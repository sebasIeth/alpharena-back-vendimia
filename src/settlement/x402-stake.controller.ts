import {
  Controller, Post, Get, Query, Body, Headers, Res, HttpStatus, Logger,
  BadRequestException, UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ApiKeyAuthGuard } from '../common/guards/api-key-auth.guard';
import { JwtOrApiKeyGuard } from '../common/guards/jwt-or-apikey.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CurrentAgent } from '../common/decorators/current-agent.decorator';
import { AuthPayload } from '../common/types';
import { X402VerifierService } from './x402-verifier.service';
import { SolanaSettlementService } from './solana-settlement.service';
import { SettlementRouterService } from './settlement-router.service';
import { X402PaymentStore } from './x402-payment-store.service';
import { ConfigService } from '../common/config/config.service';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Agent } from '../database/schemas';

@Controller('x402')
@UseGuards(JwtOrApiKeyGuard)
export class X402StakeController {
  private readonly logger = new Logger(X402StakeController.name);

  constructor(
    private readonly x402Verifier: X402VerifierService,
    private readonly solanaSettlement: SolanaSettlementService,
    private readonly settlementRouter: SettlementRouterService,
    private readonly paymentStore: X402PaymentStore,
    @InjectModel(Agent.name) private readonly agentModel: Model<Agent>,
    private readonly jwtGuard: JwtAuthGuard,
    private readonly apiKeyGuard: ApiKeyAuthGuard,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Resolve the chain to use for a given agent. Falls back to the global
   * default when the agent document doesn't specify one (legacy records).
   */
  private chainFor(agent: { chain?: string | null } | null): string {
    return (agent?.chain as string) || this.configService.chainDefault;
  }

  /** The human-friendly network label we return in x402 402 responses. */
  private networkLabel(chain: string): string {
    if (chain === 'solana') return 'solana';
    if (chain === 'base' || chain === 'base-sepolia') {
      return this.configService.baseChainId === 8453 ? 'base' : 'base-sepolia';
    }
    return chain;
  }

  @Get('token-info')
  async tokenInfo(
    @Query('token') token?: string,
    @Query('chain') chainQuery?: string,
  ) {
    const t = token || 'USDC';
    const chain = chainQuery || this.configService.chainDefault;
    const decimals = this.settlementRouter.getTokenDecimals(chain, t);
    if (chain === 'solana') {
      const mint = this.solanaSettlement.getTokenMint(t);
      if (!mint) throw new BadRequestException(`Token ${t} not configured on Solana`);
      return { chain, network: this.networkLabel(chain), token: t, tokenMint: mint, decimals };
    }
    // EVM
    if (t !== 'USDC') {
      throw new BadRequestException(`Token ${t} not supported on EVM yet`);
    }
    return {
      chain,
      network: this.networkLabel(chain),
      token: t,
      tokenAddress: this.configService.baseUsdcAddress,
      chainId: this.configService.baseChainId,
      decimals,
    };
  }

  /**
   * Build a partially-signed (Solana) or calldata-only (EVM) stake
   * transaction. On Solana the platform co-signs as fee payer; on EVM
   * the user's external wallet signs and submits the ERC-20 transfer.
   */
  @Post('build-stake')
  async buildStake(
    @CurrentUser() user: AuthPayload | undefined,
    @Body() body: { agentId: string; token?: string },
  ) {
    const { agentId } = body;
    const matchToken = body.token || 'USDC';

    if (!agentId) throw new BadRequestException('agentId is required');

    const agent = await this.agentModel.findById(agentId);
    if (!agent) throw new BadRequestException('Agent not found');

    if (user?.userId) {
      if (agent.userId && agent.userId.toString() !== user.userId) throw new BadRequestException('You do not own this agent');
    }

    if (!agent.walletAddress) throw new BadRequestException('Agent has no wallet');

    const chain = this.chainFor(agent);
    const platformWallet = this.settlementRouter.getPlatformWalletAddress(chain);
    if (!platformWallet) throw new BadRequestException('Platform wallet not configured');

    // Calculate stake amount (USD-equivalent). ALPHA pricing is Solana-only.
    let stakeAmount = 1;
    if (matchToken === 'ALPHA' && chain === 'solana') {
      const alphaPrice = await this.solanaSettlement.getAlphaPriceUsd();
      if (alphaPrice && alphaPrice > 0) {
        stakeAmount = Math.ceil(1 / alphaPrice);
      }
    }

    const tokenDecimals = this.settlementRouter.getTokenDecimals(chain, matchToken);
    const amountAtomic = BigInt(stakeAmount) * BigInt(10 ** tokenDecimals);

    const result = await this.settlementRouter.buildPartiallySignedTransfer(
      chain, agent.walletAddress, platformWallet, amountAtomic, matchToken,
    );

    if (!result) throw new BadRequestException('Failed to build transaction');

    if (result.chain === 'solana') {
      return {
        chain,
        network: this.networkLabel(chain),
        transaction: result.transaction,
        blockhash: result.blockhash,
        amount: stakeAmount,
        amountAtomic: Number(amountAtomic),
        token: matchToken,
        recipient: platformWallet,
      };
    }
    // EVM: return ERC-20 transfer params for the user's wallet to sign
    return {
      chain,
      network: this.networkLabel(chain),
      evmTransfer: {
        contract: result.contract,
        to: result.to,
        amount: result.amount,
        chainId: result.chainId,
        data: result.data,
      },
      amount: stakeAmount,
      amountAtomic: Number(amountAtomic),
      token: matchToken,
      recipient: platformWallet,
    };
  }

  @Post('stake')
  async stake(
    @CurrentUser() user: AuthPayload | undefined,
    @CurrentAgent() agentAuth: Agent | undefined,
    @Body() body: { agentId: string; stakeAmount?: number; gameType?: string; token?: string },
    @Headers('x-payment-tx') paymentTx: string | undefined,
    @Res() res: Response,
  ) {
    const { agentId } = body;
    const matchToken = body.token || 'USDC';
    const gameType = 'any';

    if (!agentId) {
      throw new BadRequestException('agentId is required');
    }

    const agent = await this.agentModel.findById(agentId);
    if (!agent) throw new BadRequestException('Agent not found');

    // Don't let agent pay if already in queue or in match
    if (agent.status === 'queued') throw new BadRequestException('Agent is already in the queue. Leave first with POST /v1/queue/leave.');
    if (agent.status === 'in_match') throw new BadRequestException('Agent is currently in a match.');

    // Verify ownership: JWT user must own the agent, or API key must be the agent itself
    if (user?.userId) {
      if (agent.userId && agent.userId.toString() !== user.userId) throw new BadRequestException('You do not own this agent');
    } else if (agentAuth) {
      if (agentAuth._id.toString() !== agentId) throw new BadRequestException('API key does not match this agent');
    }

    const chain = this.chainFor(agent);
    const platformWallet = this.settlementRouter.getPlatformWalletAddress(chain);
    const tokenDecimals = this.settlementRouter.getTokenDecimals(chain, matchToken);

    if (!platformWallet) {
      throw new BadRequestException(`${matchToken} payments not configured on ${chain}`);
    }

    // Calculate stake amount (ALPHA pricing is Solana-only)
    let stakeAmount = 1;
    if (matchToken === 'ALPHA' && chain === 'solana') {
      const alphaPrice = await this.solanaSettlement.getAlphaPriceUsd();
      if (alphaPrice && alphaPrice > 0) {
        stakeAmount = Math.ceil(1 / alphaPrice);
      }
    }

    // No payment proof → return 402 with chain-specific payment requirements
    if (!paymentTx) {
      const amountAtomic = matchToken === 'ALPHA'
        ? BigInt(stakeAmount) * BigInt(10 ** tokenDecimals)
        : stakeAmount * (10 ** tokenDecimals);
      this.logger.log(`x402: returning payment requirements for agent ${agentId}, amount=${stakeAmount} ${matchToken} on ${chain}`);

      const paymentBase = {
        token: matchToken,
        network: this.networkLabel(chain),
        recipient: platformWallet,
        amount: Number(amountAtomic),
        amountHuman: stakeAmount,
        decimals: tokenDecimals,
        description: `Stake ${stakeAmount} ${matchToken} for ${gameType} match`,
      };
      const paymentInfo =
        chain === 'solana'
          ? { ...paymentBase, tokenMint: this.solanaSettlement.getTokenMint(matchToken) }
          : { ...paymentBase, tokenAddress: this.configService.baseUsdcAddress, chainId: this.configService.baseChainId };

      return res.status(HttpStatus.PAYMENT_REQUIRED).json({
        protocol: 'x402',
        version: '1.0',
        payment: paymentInfo,
        instructions: {
          method: 'POST',
          header: 'X-PAYMENT-TX',
          description: `Transfer ${matchToken} to the recipient address, then resend this request with the tx ${chain === 'solana' ? 'signature' : 'hash'} in the X-PAYMENT-TX header`,
        },
      });
    }

    // Replay check
    if (this.paymentStore.isTxUsed(paymentTx)) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        paid: false,
        error: 'This transaction has already been used for a payment. Send a new transaction.',
      });
    }

    this.logger.log(`x402: verifying payment tx=${paymentTx} for agent ${agentId} (${matchToken})`);

    const expectedAmount = BigInt(stakeAmount) * BigInt(10 ** tokenDecimals);
    const verification = await this.x402Verifier.verifyStakePayment(paymentTx, expectedAmount, platformWallet);

    if (!verification.valid) {
      this.logger.warn(`x402: payment verification failed: ${verification.error}`);
      return res.status(HttpStatus.BAD_REQUEST).json({ paid: false, error: verification.error });
    }

    // Mark tx as used and store verified payment
    this.paymentStore.markTxUsed(paymentTx);
    this.paymentStore.setPayment(agentId, {
      txSignature: paymentTx,
      amount: stakeAmount,
      token: matchToken,
      verifiedAt: new Date(),
      gameType,
    });

    this.logger.log(`x402: payment verified for agent ${agentId}, tx=${paymentTx}, token=${matchToken}`);

    return res.status(HttpStatus.OK).json({
      paid: true,
      txSignature: paymentTx,
      amount: stakeAmount,
      token: matchToken,
      agentId,
      gameType,
      expiresIn: '10m',
    });
  }
}
