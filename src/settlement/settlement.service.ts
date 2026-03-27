import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '../common/config/config.service';
import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  formatUnits,
  parseUnits,
  type Chain,
  type PublicClient,
  type WalletClient,
  type HttpTransport,
  type Address,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import * as chains from 'viem/chains';
import { erc20Abi } from './contracts/arena-abi';

export type TokenSymbol = 'ALPHA' | 'USDC';

interface TokenConfig {
  address: Address;
  decimals: number;
}

/** USDC addresses per chain */
const USDC_BY_CHAIN: Record<number, Address> = {
  56: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',   // BNB mainnet
};

interface SettlementClients {
  publicClient: PublicClient<HttpTransport, Chain>;
  walletClient: WalletClient<HttpTransport, Chain, PrivateKeyAccount>;
  account: PrivateKeyAccount;
}

/**
 * Settlement service for Base (EVM).
 *
 * All operations use direct ERC-20 transfers via the platform (relayer) wallet.
 * No smart contract required — the relayer holds funds and distributes payouts.
 *
 * When blockchain configuration is not provided, every write method logs a
 * warning and returns `null` instead of a transaction hash.
 */
@Injectable()
export class SettlementService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SettlementService.name);
  private clients: SettlementClients | null = null;
  private feeWalletAddress: Address | null = null;
  private feeWalletKey: string | null = null;
  private rpcUrl: string | null = null;
  private chain: Chain | null = null;
  private tokens: Map<string, TokenConfig> = new Map();

  constructor(private readonly configService: ConfigService) {}

  // ── Lifecycle ────────────────────────────────────────────────────

  async onModuleInit(): Promise<void> {
    await this.start();
  }

  onModuleDestroy(): void {
    this.stop();
  }

  private async start(): Promise<void> {
    const rpcUrl = this.configService.rpcUrl;
    const privateKey = this.configService.privateKey;

    if (!rpcUrl || !privateKey) {
      this.logger.warn(
        'Blockchain configuration incomplete (RPC_URL / PRIVATE_KEY). ' +
          'Settlement service running in no-op mode.',
      );
      return;
    }

    const chainId = this.configService.chainId;
    this.chain = this.resolveChain(chainId);
    this.rpcUrl = rpcUrl;

    const account = privateKeyToAccount(privateKey as `0x${string}`);
    const publicClient = createPublicClient({ chain: this.chain, transport: http(rpcUrl) });
    const walletClient = createWalletClient({ chain: this.chain, transport: http(rpcUrl), account });
    this.clients = { publicClient, walletClient, account };

    // Fee wallet
    const feeWallet = this.configService.feeWallet;
    const feeWalletKey = this.configService.feeWalletKey;
    if (feeWallet) {
      this.feeWalletAddress = feeWallet as Address;
      this.feeWalletKey = feeWalletKey ?? null;
      this.logger.log(`Fee wallet: ${this.feeWalletAddress}`);
    }

    // Register USDC
    const usdcAddr = (this.configService.usdcAddress as Address) ?? USDC_BY_CHAIN[chainId] ?? null;
    if (usdcAddr) {
      try {
        const decimals = await publicClient.readContract({
          address: usdcAddr,
          abi: erc20Abi,
          functionName: 'decimals',
        });
        this.tokens.set('USDC', { address: usdcAddr, decimals: Number(decimals) });
        this.logger.log(`USDC token: ${usdcAddr} (${decimals} decimals)`);
      } catch {
        // Fallback: Base USDC is 6 decimals
        this.tokens.set('USDC', { address: usdcAddr, decimals: 6 });
        this.logger.warn(`USDC token: ${usdcAddr} (fallback 6 decimals)`);
      }
    }

    // Register ALPHA
    const alphaAddr = this.configService.alphaAddress;
    if (alphaAddr) {
      try {
        const decimals = await publicClient.readContract({
          address: alphaAddr as Address,
          abi: erc20Abi,
          functionName: 'decimals',
        });
        this.tokens.set('ALPHA', { address: alphaAddr as Address, decimals: Number(decimals) });
        this.logger.log(`ALPHA token: ${alphaAddr} (${decimals} decimals)`);
      } catch {
        this.tokens.set('ALPHA', { address: alphaAddr as Address, decimals: 18 });
        this.logger.warn(`ALPHA token: ${alphaAddr} (fallback 18 decimals)`);
      }
    }

    this.logger.log(
      `Settlement service started — chain=${chainId}, tokens=[${[...this.tokens.keys()].join(', ')}], platform=${account.address}`,
    );
  }

  private stop(): void {
    this.clients = null;
    this.rpcUrl = null;
    this.chain = null;
    this.tokens.clear();
    this.logger.log('Settlement service stopped');
  }

  // ── Chain resolution ──────────────────────────────────────────────

  private resolveChain(chainId: number): Chain {
    for (const value of Object.values(chains)) {
      if (typeof value === 'object' && value !== null && 'id' in value && (value as Chain).id === chainId) {
        return value as Chain;
      }
    }
    throw new Error(`Unsupported chain ID: ${chainId}`);
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private isReady(): boolean {
    return this.clients !== null;
  }

  private resolveToken(tokenOrSymbol: string): TokenConfig | null {
    const bySymbol = this.tokens.get(tokenOrSymbol);
    if (bySymbol) return bySymbol;
    for (const config of this.tokens.values()) {
      if (config.address.toLowerCase() === tokenOrSymbol.toLowerCase()) return config;
    }
    return null;
  }

  // ── Token Info ────────────────────────────────────────────────────

  getTokenDecimals(tokenOrSymbol: string = 'USDC'): number {
    return this.resolveToken(tokenOrSymbol)?.decimals ?? 6;
  }

  getTokenAddress(symbol: string): string | null {
    return this.tokens.get(symbol)?.address ?? null;
  }

  getSupportedTokens(): string[] {
    return [...this.tokens.keys()];
  }

  // ── Transfer: Agent → Destination ─────────────────────────────────

  /**
   * Transfer ERC-20 tokens from an agent wallet to a destination.
   * The agent pays gas for this transaction.
   */
  async transferTokenFromAgent(
    agentPrivateKey: string,
    to: string,
    amount: bigint,
    tokenOrSymbol: string = 'USDC',
  ): Promise<string | null> {
    if (!this.isReady()) {
      this.logger.warn('transferTokenFromAgent skipped — not initialised');
      return null;
    }

    const token = this.resolveToken(tokenOrSymbol);
    if (!token) {
      this.logger.error(`Unknown token: ${tokenOrSymbol}`);
      return null;
    }

    const { publicClient } = this.clients!;
    const agentAccount = privateKeyToAccount(agentPrivateKey as `0x${string}`);
    const agentWalletClient = createWalletClient({
      chain: this.chain!,
      transport: http(this.rpcUrl!),
      account: agentAccount,
    });

    this.logger.log(
      `Transfer ${tokenOrSymbol} from agent ${agentAccount.address} to ${to}, amount=${amount}`,
    );

    const { request } = await publicClient.simulateContract({
      address: token.address,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [to as Address, amount],
      account: agentAccount,
    });

    const txHash = await agentWalletClient.writeContract(request);
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    this.logger.log(`Agent transfer confirmed: ${txHash}`);
    return txHash;
  }

  // ── Transfer: Platform → Destination ──────────────────────────────

  /**
   * Transfer ERC-20 tokens from the platform wallet to a destination.
   */
  async transferTokenFromPlatform(
    to: string,
    amount: bigint,
    tokenOrSymbol: string = 'USDC',
  ): Promise<string | null> {
    if (!this.isReady()) {
      this.logger.warn('transferTokenFromPlatform skipped — not initialised');
      return null;
    }

    const token = this.resolveToken(tokenOrSymbol);
    if (!token) {
      this.logger.error(`Unknown token: ${tokenOrSymbol}`);
      return null;
    }

    const { publicClient, walletClient, account } = this.clients!;

    this.logger.log(
      `Transfer ${tokenOrSymbol} from platform ${account.address} to ${to}, amount=${amount}`,
    );

    const { request } = await publicClient.simulateContract({
      address: token.address,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [to as Address, amount],
      account,
    });

    const txHash = await walletClient.writeContract(request);
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    this.logger.log(`Platform transfer confirmed: ${txHash}`);
    return txHash;
  }

  // ── Fee Wallet ────────────────────────────────────────────────────

  /**
   * Send fee to the dedicated fee wallet.
   */
  async sendFeeToFeeWallet(
    amount: bigint,
    tokenOrSymbol: string = 'USDC',
  ): Promise<string | null> {
    if (!this.feeWalletAddress) {
      this.logger.warn('No fee wallet configured, fee stays in platform wallet');
      return null;
    }
    return this.transferTokenFromPlatform(this.feeWalletAddress, amount, tokenOrSymbol);
  }

  getFeeWalletAddress(): string | null {
    return this.feeWalletAddress;
  }

  // ── Balance Queries ───────────────────────────────────────────────

  /**
   * Read ERC-20 token balance for an address.
   */
  async getAgentTokenBalance(walletAddress: string, tokenOrSymbol: string = 'USDC'): Promise<string> {
    if (!this.isReady()) return '0';

    const token = this.resolveToken(tokenOrSymbol);
    if (!token) return '0';

    try {
      const balance = await this.clients!.publicClient.readContract({
        address: token.address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [walletAddress as Address],
      });
      return formatUnits(balance as bigint, token.decimals);
    } catch {
      return '0';
    }
  }

  /**
   * Read native ETH balance for an address.
   */
  async getAgentEthBalance(walletAddress: string): Promise<string> {
    if (!this.isReady()) return '0';
    try {
      const balance = await this.clients!.publicClient.getBalance({
        address: walletAddress as Address,
      });
      return formatEther(balance);
    } catch {
      return '0';
    }
  }

  // ── Platform Info ─────────────────────────────────────────────────

  getPlatformWalletAddress(): string | null {
    return this.clients?.account.address ?? null;
  }

  // ── Match Settlement (simple transfer pattern, no smart contract) ──

  /**
   * Escrow is implicit on Base — funds are transferred from agents to the
   * platform wallet before the match starts. This is a no-op.
   */
  async escrow(
    matchId: string,
    _agentAAddress: string,
    _agentBAddress: string,
    _stakeAmount: bigint,
  ): Promise<string | null> {
    this.logger.log(`Escrow is implicit (agent transfers) for match ${matchId}`);
    return null;
  }

  /**
   * Pay out the winner from the platform wallet.
   */
  async payout(
    matchId: string,
    winnerAddress: string,
    amount: bigint,
    tokenOrSymbol: string = 'USDC',
  ): Promise<string | null> {
    this.logger.log(`Payout for match ${matchId}: ${winnerAddress}, amount=${amount}`);
    return this.transferTokenFromPlatform(winnerAddress, amount, tokenOrSymbol);
  }

  /**
   * Refund agents from the platform wallet.
   */
  async refund(
    matchId: string,
    refundTargets?: Array<{ address: string; amount: bigint }>,
    tokenOrSymbol: string = 'USDC',
  ): Promise<string | null> {
    if (!refundTargets?.length) {
      this.logger.warn(`Refund for match ${matchId} — no refund targets`);
      return null;
    }
    let lastTxHash: string | null = null;
    for (const target of refundTargets) {
      lastTxHash = await this.transferTokenFromPlatform(target.address, target.amount, tokenOrSymbol);
    }
    return lastTxHash;
  }

  /**
   * No-op on EVM — ERC-20 tokens can be received without prior setup.
   */
  async ensureTokenAccounts(_walletAddress: string): Promise<void> {
    // No ATAs needed on EVM
  }

  // ── ALPHA price from DexScreener ──────────────────────────────────

  private alphaPriceUsd: number | null = null;
  private alphaPriceLastFetch = 0;
  private readonly ALPHA_PRICE_TTL = 60_000;

  async getAlphaPriceUsd(): Promise<number | null> {
    if (this.alphaPriceUsd !== null && Date.now() - this.alphaPriceLastFetch < this.ALPHA_PRICE_TTL) {
      return this.alphaPriceUsd;
    }
    const alphaAddr = this.getTokenAddress('ALPHA');
    if (!alphaAddr) return null;
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${alphaAddr}`);
      if (!res.ok) return this.alphaPriceUsd;
      const data = await res.json();
      const price = data?.pairs?.[0]?.priceUsd ? parseFloat(data.pairs[0].priceUsd) : null;
      if (price !== null && !isNaN(price)) {
        this.alphaPriceUsd = price;
        this.alphaPriceLastFetch = Date.now();
        this.logger.log(`ALPHA price updated: $${price}`);
      }
      return this.alphaPriceUsd;
    } catch {
      return this.alphaPriceUsd;
    }
  }
}
