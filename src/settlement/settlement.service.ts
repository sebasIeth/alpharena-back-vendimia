import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '../common/config/config.service';
import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  formatUnits,
  type Chain,
  type PublicClient,
  type WalletClient,
  type HttpTransport,
  type Address,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import * as chains from 'viem/chains';
import { arenaAbi, erc20Abi } from './contracts/arena-abi';

/** USDC addresses per chain */
const USDC_BY_CHAIN: Record<number, Address> = {
  8453: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',  // Base mainnet
  84532: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // Base Sepolia
};

interface SettlementClients {
  publicClient: PublicClient<HttpTransport, Chain>;
  walletClient: WalletClient<HttpTransport, Chain, PrivateKeyAccount>;
  account: PrivateKeyAccount;
}

/**
 * High-level NestJS service that wraps all on-chain settlement operations.
 *
 * All escrow/payout/refund operations use USDC (ERC-20) on Base.
 *
 * When blockchain configuration is not provided (common during local
 * development), every write method logs a warning and returns `null` instead
 * of a transaction hash.  This allows the rest of the platform to operate
 * normally without a live chain.
 */
@Injectable()
export class SettlementService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SettlementService.name);
  private clients: SettlementClients | null = null;
  private contractAddress: Address | null = null;
  private usdcAddress: Address | null = null;
  private rpcUrl: string | null = null;
  private chain: Chain | null = null;

  constructor(private readonly configService: ConfigService) {}

  // ── Lifecycle ────────────────────────────────────────────────────

  onModuleInit(): void {
    this.start();
  }

  onModuleDestroy(): void {
    this.stop();
  }

  /**
   * Initialise viem clients.  If any required blockchain config value is
   * missing the service enters "no-op" mode and all write operations become
   * safe stubs.
   */
  private start(): void {
    const rpcUrl = this.configService.rpcUrl;
    const privateKey = this.configService.privateKey;
    const contractAddr = this.configService.contractAddress;
    const chainIdStr = String(this.configService.chainId);
    const usdcAddr = this.configService.usdcAddress;

    if (!rpcUrl || !privateKey || !contractAddr) {
      this.logger.warn(
        'Blockchain configuration incomplete (SETTLEMENT_RPC_URL / SETTLEMENT_PRIVATE_KEY / SETTLEMENT_CONTRACT_ADDRESS). ' +
          'Settlement service running in no-op mode — transactions will not be submitted.',
      );
      return;
    }

    const resolvedChainId = chainIdStr ? parseInt(chainIdStr, 10) : 84532;
    this.clients = this.createSettlementClient(rpcUrl, privateKey, resolvedChainId);
    this.contractAddress = contractAddr as Address;
    this.rpcUrl = rpcUrl;
    this.chain = this.resolveChain(resolvedChainId);

    // Resolve USDC address from config or chain ID
    this.usdcAddress = (usdcAddr as Address) ?? USDC_BY_CHAIN[resolvedChainId] ?? null;

    if (!this.usdcAddress) {
      this.logger.warn(
        `No USDC address configured or known for chain ${resolvedChainId}. Escrow will fail.`,
      );
    }

    this.logger.log(
      `Settlement service started (USDC mode) — chain=${resolvedChainId}, contract=${contractAddr}, usdc=${this.usdcAddress}, account=${this.clients.account.address}`,
    );
  }

  /**
   * Tear down clients and release resources.
   */
  private stop(): void {
    this.clients = null;
    this.contractAddress = null;
    this.usdcAddress = null;
    this.rpcUrl = null;
    this.chain = null;
    this.logger.log('Settlement service stopped');
  }

  // ── Client creation ──────────────────────────────────────────────

  /**
   * Resolve a viem Chain definition by its numeric chain ID.
   */
  private resolveChain(chainId: number): Chain {
    for (const value of Object.values(chains)) {
      if (
        typeof value === 'object' &&
        value !== null &&
        'id' in value &&
        (value as Chain).id === chainId
      ) {
        return value as Chain;
      }
    }
    throw new Error(
      `Unsupported chain ID: ${chainId}. No matching chain definition found in viem/chains.`,
    );
  }

  /**
   * Create a pair of viem clients (public + wallet) for on-chain settlement.
   */
  private createSettlementClient(
    rpcUrl: string,
    privateKey: string,
    chainId: number,
  ): SettlementClients {
    const chain = this.resolveChain(chainId);
    const account = privateKeyToAccount(privateKey as `0x${string}`);

    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
    });

    const walletClient = createWalletClient({
      chain,
      transport: http(rpcUrl),
      account,
    });

    return { publicClient, walletClient, account };
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private isReady(): boolean {
    return this.clients !== null && this.contractAddress !== null && this.usdcAddress !== null;
  }

  /**
   * Convert an application-level match ID string into a bytes32 hex value
   * suitable for the smart contract.  If the value is already a 0x-prefixed
   * 66-char hex string it is returned as-is; otherwise it is right-padded
   * with zeroes.
   */
  private toBytes32(matchId: string): `0x${string}` {
    if (matchId.startsWith('0x') && matchId.length === 66) {
      return matchId as `0x${string}`;
    }
    // Encode as UTF-8 bytes then pad to 32 bytes
    const hex = Buffer.from(matchId, 'utf8').toString('hex').slice(0, 64);
    return `0x${hex.padEnd(64, '0')}` as `0x${string}`;
  }

  /**
   * Ensure the Arena contract has sufficient USDC allowance from the operator.
   * If current allowance is less than the required amount, sends an approve tx.
   */
  private async ensureUsdcAllowance(spender: Address, amount: bigint): Promise<void> {
    const { publicClient, walletClient, account } = this.clients!;

    const currentAllowance = await publicClient.readContract({
      address: this.usdcAddress!,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [account.address, spender],
    });

    if ((currentAllowance as bigint) >= amount) {
      return;
    }

    // Approve max uint256 so we only need to do this once
    const maxApproval = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');

    this.logger.log(`Approving max USDC spend for Arena contract: spender=${spender}`);

    const { request } = await publicClient.simulateContract({
      address: this.usdcAddress!,
      abi: erc20Abi,
      functionName: 'approve',
      args: [spender, maxApproval],
      account,
    });

    const txHash = await walletClient.writeContract(request);
    await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 2 });

    this.logger.log(`USDC max approval confirmed: txHash=${txHash}`);
  }

  // ── Public API ───────────────────────────────────────────────────

  /**
   * Lock escrow USDC for a match.
   *
   * Automatically approves USDC spending if the current allowance is insufficient.
   * The transaction is submitted and then we wait for at least one confirmation.
   *
   * @returns The transaction hash, or `null` when running in no-op mode.
   */
  async escrow(
    matchId: string,
    agentAAddress: string,
    agentBAddress: string,
    stakeAmount: bigint,
  ): Promise<string | null> {
    if (!this.isReady()) {
      this.logger.warn(`escrow skipped — settlement service not initialised (matchId=${matchId})`);
      return null;
    }

    const { publicClient, walletClient, account } = this.clients!;
    const matchIdBytes32 = this.toBytes32(matchId);

    this.logger.log(
      `Submitting escrowFunds transaction (USDC): matchId=${matchId}, agentA=${agentAAddress}, agentB=${agentBAddress}, stakeAmount=${stakeAmount.toString()}`,
    );

    try {
      // Ensure USDC approval before escrow
      await this.ensureUsdcAllowance(this.contractAddress!, stakeAmount);

      const { request } = await publicClient.simulateContract({
        address: this.contractAddress!,
        abi: arenaAbi,
        functionName: 'escrowFunds',
        args: [matchIdBytes32, agentAAddress as Address, agentBAddress as Address, stakeAmount],
        account,
      });

      const txHash = await walletClient.writeContract(request);

      this.logger.log(`escrowFunds transaction sent, waiting for receipt: txHash=${txHash}, matchId=${matchId}`);

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

      if (receipt.status === 'reverted') {
        throw new Error(`escrowFunds transaction reverted: ${txHash}`);
      }

      this.logger.log(
        `escrowFunds confirmed: txHash=${txHash}, blockNumber=${receipt.blockNumber.toString()}, matchId=${matchId}`,
      );

      return txHash;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to lock escrow: matchId=${matchId}, error=${message}`);
      throw error;
    }
  }

  /**
   * Release escrowed USDC to the match winner.
   *
   * @returns The transaction hash, or `null` when running in no-op mode.
   */
  async payout(
    matchId: string,
    winnerAddress: string,
    amount: bigint,
  ): Promise<string | null> {
    if (!this.isReady()) {
      this.logger.warn(`payout skipped — settlement service not initialised (matchId=${matchId})`);
      return null;
    }

    const { publicClient, walletClient, account } = this.clients!;
    const matchIdBytes32 = this.toBytes32(matchId);

    this.logger.log(
      `Submitting releasePayout transaction: matchId=${matchId}, winner=${winnerAddress}, amount=${amount.toString()}`,
    );

    try {
      const { request } = await publicClient.simulateContract({
        address: this.contractAddress!,
        abi: arenaAbi,
        functionName: 'releasePayout',
        args: [matchIdBytes32, winnerAddress as Address, amount],
        account,
      });

      const txHash = await walletClient.writeContract(request);

      this.logger.log(`releasePayout transaction sent, waiting for receipt: txHash=${txHash}, matchId=${matchId}`);

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

      if (receipt.status === 'reverted') {
        throw new Error(`releasePayout transaction reverted: ${txHash}`);
      }

      this.logger.log(
        `releasePayout confirmed: txHash=${txHash}, blockNumber=${receipt.blockNumber.toString()}, matchId=${matchId}`,
      );

      return txHash;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to release payout: matchId=${matchId}, error=${message}`);
      throw error;
    }
  }

  /**
   * Refund both parties of a cancelled / errored match.
   *
   * @returns The transaction hash, or `null` when running in no-op mode.
   */
  async refund(matchId: string): Promise<string | null> {
    if (!this.isReady()) {
      this.logger.warn(`refund skipped — settlement service not initialised (matchId=${matchId})`);
      return null;
    }

    const { publicClient, walletClient, account } = this.clients!;
    const matchIdBytes32 = this.toBytes32(matchId);

    this.logger.log(`Submitting refundMatch transaction: matchId=${matchId}`);

    try {
      const { request } = await publicClient.simulateContract({
        address: this.contractAddress!,
        abi: arenaAbi,
        functionName: 'refundMatch',
        args: [matchIdBytes32],
        account,
      });

      const txHash = await walletClient.writeContract(request);

      this.logger.log(`refundMatch transaction sent, waiting for receipt: txHash=${txHash}, matchId=${matchId}`);

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

      if (receipt.status === 'reverted') {
        throw new Error(`refundMatch transaction reverted: ${txHash}`);
      }

      this.logger.log(
        `refundMatch confirmed: txHash=${txHash}, blockNumber=${receipt.blockNumber.toString()}, matchId=${matchId}`,
      );

      return txHash;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to refund match: matchId=${matchId}, error=${message}`);
      throw error;
    }
  }

  // ── Agent Wallet Operations ───────────────────────────────────────

  /**
   * Read on-chain USDC balance for an agent wallet.
   * Returns the balance as a human-readable string (e.g. "100.5").
   */
  async getAgentUsdcBalance(walletAddress: string): Promise<string> {
    if (!this.clients || !this.usdcAddress) return '0';

    const balance = await this.clients.publicClient.readContract({
      address: this.usdcAddress,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [walletAddress as Address],
    });

    return formatUnits(balance as bigint, 6);
  }

  /**
   * Read on-chain ETH balance for an agent wallet (needed for gas).
   * Returns the balance as a human-readable string (e.g. "0.001").
   */
  async getAgentEthBalance(walletAddress: string): Promise<string> {
    if (!this.clients) return '0';

    const balance = await this.clients.publicClient.getBalance({
      address: walletAddress as Address,
    });

    return formatEther(balance);
  }

  /**
   * Transfer USDC from an agent's wallet to a destination address.
   * Creates a temporary wallet client with the agent's private key.
   *
   * @returns The transaction hash, or `null` when running in no-op mode.
   */
  async transferUsdcFromAgent(
    agentPrivateKey: string,
    to: string,
    amount: bigint,
  ): Promise<string | null> {
    if (!this.clients || !this.usdcAddress) {
      this.logger.warn('transferUsdcFromAgent skipped — settlement service not initialised');
      return null;
    }

    const { publicClient } = this.clients;
    const agentAccount = privateKeyToAccount(agentPrivateKey as `0x${string}`);
    const agentWalletClient = createWalletClient({
      chain: this.chain!,
      transport: http(this.rpcUrl!),
      account: agentAccount,
    });

    this.logger.log(
      `Transferring USDC from agent ${agentAccount.address} to ${to}, amount=${amount.toString()}`,
    );

    const { request } = await publicClient.simulateContract({
      address: this.usdcAddress,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [to as Address, amount],
      account: agentAccount,
    });

    const txHash = await agentWalletClient.writeContract(request);
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    this.logger.log(`USDC transfer confirmed: txHash=${txHash}`);
    return txHash;
  }

  /**
   * Transfer USDC from the platform wallet to a destination address.
   *
   * @returns The transaction hash, or `null` when running in no-op mode.
   */
  async transferUsdcFromPlatform(
    to: string,
    amount: bigint,
  ): Promise<string | null> {
    if (!this.isReady()) {
      this.logger.warn('transferUsdcFromPlatform skipped — settlement service not initialised');
      return null;
    }

    const { publicClient, walletClient, account } = this.clients!;

    this.logger.log(
      `Transferring USDC from platform ${account.address} to ${to}, amount=${amount.toString()}`,
    );

    const { request } = await publicClient.simulateContract({
      address: this.usdcAddress!,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [to as Address, amount],
      account,
    });

    const txHash = await walletClient.writeContract(request);
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    this.logger.log(`USDC platform transfer confirmed: txHash=${txHash}`);
    return txHash;
  }

  /**
   * Get the platform wallet address (the operator account).
   */
  getPlatformWalletAddress(): string | null {
    return this.clients?.account.address ?? null;
  }

  /**
   * Get the USDC token decimals used by this service.
   */
  getUsdcDecimals(): number {
    return 6;
  }
}
