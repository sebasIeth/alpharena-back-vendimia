import { Injectable, Logger } from '@nestjs/common';
import { SettlementService } from './settlement.service';

/**
 * Chain-agnostic facade that routes settlement operations to the
 * appropriate chain-specific service. Currently Base (EVM) only.
 */
@Injectable()
export class SettlementRouterService {
  private readonly logger = new Logger(SettlementRouterService.name);

  constructor(
    private readonly settlement: SettlementService,
  ) {}

  getTokenDecimals(_chain: string, token: string = 'USDC'): number {
    return this.settlement.getTokenDecimals(token);
  }

  async transferTokenFromAgent(
    _chain: string,
    agentPrivateKey: string,
    to: string,
    amount: bigint,
    token: string = 'USDC',
  ): Promise<string | null> {
    return this.settlement.transferTokenFromAgent(agentPrivateKey, to, amount, token);
  }

  async transferTokenFromPlatform(
    _chain: string,
    to: string,
    amount: bigint,
    token: string = 'USDC',
  ): Promise<string | null> {
    return this.settlement.transferTokenFromPlatform(to, amount, token);
  }

  async sendFee(
    _chain: string,
    amount: bigint,
    token: string = 'USDC',
  ): Promise<string | null> {
    return this.settlement.sendFeeToFeeWallet(amount, token);
  }

  async getAgentTokenBalance(_chain: string, walletAddress: string, token: string = 'USDC'): Promise<string> {
    return this.settlement.getAgentTokenBalance(walletAddress, token);
  }

  async getAgentNativeBalance(_chain: string, walletAddress: string): Promise<string> {
    return this.settlement.getAgentEthBalance(walletAddress);
  }

  getPlatformWalletAddress(_chain: string): string | null {
    return this.settlement.getPlatformWalletAddress();
  }

  getFeeWalletAddress(_chain: string): string | null {
    return this.settlement.getFeeWalletAddress();
  }

  async escrow(
    _chain: string,
    matchId: string,
    agentAAddress: string,
    agentBAddress: string,
    escrowAmount: bigint,
  ): Promise<string | null> {
    return this.settlement.escrow(matchId, agentAAddress, agentBAddress, escrowAmount);
  }

  async payout(
    _chain: string,
    matchId: string,
    winnerAddress: string,
    amount: bigint,
    token: string = 'USDC',
  ): Promise<string | null> {
    return this.settlement.payout(matchId, winnerAddress, amount, token);
  }

  async refund(
    _chain: string,
    matchId: string,
    refundTargets?: Array<{ address: string; amount: bigint }>,
    token: string = 'USDC',
  ): Promise<string | null> {
    return this.settlement.refund(matchId, refundTargets, token);
  }

  async ensureTokenAccounts(_chain: string, _walletAddress: string): Promise<void> {
    // No-op on EVM — ERC-20 tokens don't need ATAs
  }

  async getAlphaPriceUsd(): Promise<number | null> {
    return this.settlement.getAlphaPriceUsd();
  }
}
