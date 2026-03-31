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
import { X402PaymentStore } from './x402-payment-store.service';
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
    private readonly paymentStore: X402PaymentStore,
    @InjectModel(Agent.name) private readonly agentModel: Model<Agent>,
    private readonly jwtGuard: JwtAuthGuard,
    private readonly apiKeyGuard: ApiKeyAuthGuard,
  ) {}

  @Get('token-info')
  async tokenInfo(@Query('token') token?: string) {
    const t = token || 'USDC';
    const mint = this.solanaSettlement.getTokenMint(t);
    const decimals = this.solanaSettlement.getTokenDecimals(t);
    if (!mint) throw new BadRequestException(`Token ${t} not configured`);
    return { token: t, tokenMint: mint, decimals };
  }

  /**
   * Build a partially-signed stake transaction.
   * Platform signs as fee payer. User signs with their external wallet.
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

    const platformWallet = this.solanaSettlement.getPlatformWalletAddress();
    if (!platformWallet) throw new BadRequestException('Platform wallet not configured');

    // Calculate stake amount
    let stakeAmount = 1;
    if (matchToken === 'ALPHA') {
      const alphaPrice = await this.solanaSettlement.getAlphaPriceUsd();
      if (alphaPrice && alphaPrice > 0) {
        stakeAmount = Math.ceil(1 / alphaPrice);
      }
    }

    const tokenDecimals = this.solanaSettlement.getTokenDecimals(matchToken);
    const amountAtomic = BigInt(stakeAmount) * BigInt(10 ** tokenDecimals);

    const result = await this.solanaSettlement.buildPartiallySignedTransfer(
      agent.walletAddress, platformWallet, amountAtomic, matchToken,
    );

    if (!result) throw new BadRequestException('Failed to build transaction');

    return {
      transaction: result.transaction,
      blockhash: result.blockhash,
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

    const platformWallet = this.solanaSettlement.getPlatformWalletAddress();
    const tokenMint = this.solanaSettlement.getTokenMint(matchToken);
    const tokenDecimals = this.solanaSettlement.getTokenDecimals(matchToken);

    if (!platformWallet || !tokenMint) {
      throw new BadRequestException(`${matchToken} payments not configured on this server`);
    }

    // Calculate stake amount
    let stakeAmount = 1;
    if (matchToken === 'ALPHA') {
      const alphaPrice = await this.solanaSettlement.getAlphaPriceUsd();
      if (alphaPrice && alphaPrice > 0) {
        stakeAmount = Math.ceil(1 / alphaPrice);
      }
    }

    // No payment proof → return 402
    if (!paymentTx) {
      const amountAtomic = matchToken === 'ALPHA'
        ? BigInt(stakeAmount) * BigInt(10 ** tokenDecimals)
        : stakeAmount * (10 ** tokenDecimals);
      this.logger.log(`x402: returning payment requirements for agent ${agentId}, amount=${stakeAmount} ${matchToken}`);
      return res.status(HttpStatus.PAYMENT_REQUIRED).json({
        protocol: 'x402',
        version: '1.0',
        payment: {
          token: matchToken,
          tokenMint,
          network: 'solana',
          recipient: platformWallet,
          amount: Number(amountAtomic),
          amountHuman: stakeAmount,
          decimals: tokenDecimals,
          description: `Stake ${stakeAmount} ${matchToken} for ${gameType} match`,
        },
        instructions: {
          method: 'POST',
          header: 'X-PAYMENT-TX',
          description: `Transfer ${matchToken} to the recipient address, then resend this request with the tx signature in the X-PAYMENT-TX header`,
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
