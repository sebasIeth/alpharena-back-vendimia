import { Injectable, Logger } from '@nestjs/common';
import { encodeFunctionData, parseAbi } from 'viem';
import { SettlementService } from './settlement.service';
import { SolanaSettlementService } from './solana-settlement.service';
import { ConfigService } from '../common/config/config.service';

export type BuildTransferResult =
  | { chain: 'solana'; transaction: string; blockhash: string }
  | {
      chain: 'evm';
      // Parameters the frontend needs to ask the wallet to sign an
      // ERC-20 `transfer(to, amount)` on behalf of the sender. The
      // backend does NOT sign — the user's external wallet does.
      contract: string; // USDC ERC-20 address
      to: string;
      amount: string; // atomic, decimal string
      chainId: number;
      data: `0x${string}`; // pre-encoded calldata
    };

/**
 * Chain-agnostic facade that routes settlement operations to the
 * appropriate chain-specific service (EVM or Solana).
 *
 * For Solana, all methods accept an optional `token` param (default 'ALPHA').
 */
@Injectable()
export class SettlementRouterService {
  private readonly logger = new Logger(SettlementRouterService.name);

  constructor(
    private readonly evmSettlement: SettlementService,
    private readonly solanaSettlement: SolanaSettlementService,
    private readonly configService: ConfigService,
  ) {}

  getTokenDecimals(chain: string, token: string = 'USDC'): number {
    if (chain === 'solana') {
      return this.solanaSettlement.getTokenDecimals(token);
    }
    return this.evmSettlement.getUsdcDecimals();
  }

  async transferTokenFromAgent(
    chain: string,
    agentPrivateKey: string,
    to: string,
    amount: bigint,
    token: string = 'USDC',
  ): Promise<string | null> {
    if (chain === 'solana') {
      return this.solanaSettlement.transferTokenFromAgent(agentPrivateKey, to, amount, token);
    }
    return this.evmSettlement.transferUsdcFromAgent(agentPrivateKey, to, amount);
  }

  async transferTokenFromPlatform(
    chain: string,
    to: string,
    amount: bigint,
    token: string = 'USDC',
  ): Promise<string | null> {
    if (chain === 'solana') {
      return this.solanaSettlement.transferTokenFromPlatform(to, amount, token);
    }
    return this.evmSettlement.transferUsdcFromPlatform(to, amount);
  }

  /**
   * Send fee to the dedicated fee wallet.
   */
  async sendFee(
    chain: string,
    amount: bigint,
    token: string = 'USDC',
  ): Promise<string | null> {
    if (chain === 'solana') {
      return this.solanaSettlement.sendFeeToFeeWallet(amount, token);
    }
    // EVM: fee stays in platform wallet (no separate fee wallet yet)
    return null;
  }

  async getAgentTokenBalance(chain: string, walletAddress: string, token: string = 'USDC'): Promise<string> {
    if (chain === 'solana') {
      return this.solanaSettlement.getAgentTokenBalance(walletAddress, token);
    }
    return this.evmSettlement.getAgentUsdcBalance(walletAddress);
  }

  async getAgentNativeBalance(chain: string, walletAddress: string): Promise<string> {
    if (chain === 'solana') {
      return this.solanaSettlement.getAgentSolBalance(walletAddress);
    }
    return this.evmSettlement.getAgentEthBalance(walletAddress);
  }

  getPlatformWalletAddress(chain: string): string | null {
    if (chain === 'solana') {
      return this.solanaSettlement.getPlatformWalletAddress();
    }
    return this.evmSettlement.getPlatformWalletAddress();
  }

  getFeeWalletAddress(chain: string): string | null {
    if (chain === 'solana') {
      return this.solanaSettlement.getFeeWalletAddress();
    }
    return null;
  }

  async escrow(
    chain: string,
    matchId: string,
    agentAAddress: string,
    agentBAddress: string,
    escrowAmount: bigint,
  ): Promise<string | null> {
    if (chain === 'solana') {
      this.logger.log(`Solana escrow is implicit (agent transfers) for match ${matchId}`);
      return null;
    }
    return this.evmSettlement.escrow(matchId, agentAAddress, agentBAddress, escrowAmount);
  }

  async payout(
    chain: string,
    matchId: string,
    winnerAddress: string,
    amount: bigint,
    token: string = 'USDC',
  ): Promise<string | null> {
    if (chain === 'solana') {
      return this.solanaSettlement.transferTokenFromPlatform(winnerAddress, amount, token);
    }
    return this.evmSettlement.payout(matchId, winnerAddress, amount);
  }

  async refund(
    chain: string,
    matchId: string,
    refundTargets?: Array<{ address: string; amount: bigint }>,
    token: string = 'USDC',
  ): Promise<string | null> {
    if (chain === 'solana') {
      if (!refundTargets?.length) {
        this.logger.warn(`Solana refund for match ${matchId} — no refund targets`);
        return null;
      }
      let lastTxSig: string | null = null;
      for (const target of refundTargets) {
        lastTxSig = await this.solanaSettlement.transferTokenFromPlatform(target.address, target.amount, token);
      }
      return lastTxSig;
    }
    return this.evmSettlement.refund(matchId);
  }

  async ensureTokenAccounts(chain: string, walletAddress: string): Promise<void> {
    if (chain === 'solana') {
      await this.solanaSettlement.ensureTokenAccounts(walletAddress);
    }
  }

  async getAlphaPriceUsd(): Promise<number | null> {
    return this.solanaSettlement.getAlphaPriceUsd();
  }

  async buildPartiallySignedTransfer(
    chain: string,
    senderAddress: string,
    to: string,
    amount: bigint,
    token: string = 'USDC',
  ): Promise<BuildTransferResult | null> {
    if (chain === 'solana') {
      const sol = await this.solanaSettlement.buildPartiallySignedTransfer(senderAddress, to, amount, token);
      if (!sol) return null;
      return { chain: 'solana', transaction: sol.transaction, blockhash: sol.blockhash };
    }
    // EVM path — produce ERC-20 transfer calldata. The user's external
    // wallet (MetaMask / WalletConnect / Coinbase) signs and submits it.
    if (token !== 'USDC') {
      this.logger.warn(`EVM buildPartiallySignedTransfer: only USDC supported on Base (got ${token})`);
      return null;
    }
    const contract = this.configService.baseUsdcAddress;
    const chainId = this.configService.baseChainId;
    const data = encodeFunctionData({
      abi: parseAbi(['function transfer(address to, uint256 amount)']),
      functionName: 'transfer',
      args: [to as `0x${string}`, amount],
    });
    return {
      chain: 'evm',
      contract,
      to,
      amount: amount.toString(),
      chainId,
      data,
    };
  }
}
