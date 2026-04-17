import { Injectable } from '@nestjs/common';

@Injectable()
export class ConfigService {
  get mongodbUri(): string {
    return this.getRequired('MONGODB_URI');
  }

  get port(): number {
    return parseInt(process.env.PORT || '3000', 10);
  }

  get host(): string {
    return process.env.HOST || '0.0.0.0';
  }

  get nodeEnv(): string {
    return process.env.NODE_ENV || 'development';
  }

  get jwtSecret(): string {
    return this.getRequired('JWT_SECRET');
  }

  get jwtExpiresIn(): string {
    return process.env.JWT_EXPIRES_IN || '7d';
  }

  get rpcUrl(): string | undefined {
    return process.env.RPC_URL;
  }

  get chainId(): number {
    return parseInt(process.env.CHAIN_ID || '84532', 10);
  }

  get contractAddress(): string | undefined {
    return process.env.CONTRACT_ADDRESS;
  }

  get usdcAddress(): string | undefined {
    return process.env.USDC_ADDRESS;
  }

  get privateKey(): string | undefined {
    return process.env.PRIVATE_KEY;
  }

  get matchDurationMs(): number {
    return parseInt(process.env.MATCH_DURATION_MS || '1200000', 10);
  }

  get turnTimeoutMs(): number {
    return parseInt(process.env.TURN_TIMEOUT_MS || '30000', 10);
  }

  get maxTimeouts(): number {
    return parseInt(process.env.MAX_TIMEOUTS || '3', 10);
  }

  get minStake(): number {
    return parseInt(process.env.MIN_STAKE || '10', 10);
  }

  get maxStake(): number {
    return parseInt(process.env.MAX_STAKE || '10000', 10);
  }

  get platformFeePercent(): number {
    return parseInt(process.env.PLATFORM_FEE_PERCENT || '5', 10);
  }

  get matchmakingIntervalMs(): number {
    return parseInt(process.env.MATCHMAKING_INTERVAL_MS || '2000', 10);
  }

  get eloMatchRange(): number {
    return parseInt(process.env.ELO_MATCH_RANGE || '200', 10);
  }

  get smtpHost(): string {
    return process.env.SMTP_HOST || 'smtp.gmail.com';
  }

  get smtpPort(): number {
    return parseInt(process.env.SMTP_PORT || '587', 10);
  }

  get smtpUser(): string {
    return process.env.SMTP_USER || '';
  }

  get smtpPass(): string {
    return process.env.SMTP_PASS || '';
  }

  get smtpFrom(): string {
    return process.env.SMTP_FROM || '"AlphArena" <noreply@alpharena.com>';
  }

  get frontendUrl(): string {
    return process.env.FRONTEND_URL || 'http://localhost:3000';
  }

  get twitterBearerToken(): string | undefined {
    return process.env.TWITTER_BEARER_TOKEN;
  }

  // ── Chain selection ──
  /**
   * Default chain used for new matches, new agent/user custodial wallets,
   * and as a fallback wherever chain is not explicitly passed. One of:
   *   'base' | 'base-sepolia' | 'solana'
   */
  get chainDefault(): string {
    return process.env.CHAIN_DEFAULT || 'base';
  }

  // ── Base (EVM) Settlement ──
  /** Base RPC endpoint. Falls back to legacy RPC_URL for back-compat. */
  get baseRpcUrl(): string | undefined {
    return process.env.BASE_RPC_URL || process.env.RPC_URL;
  }

  /** 8453 = Base mainnet, 84532 = Base Sepolia (default). */
  get baseChainId(): number {
    const raw = process.env.BASE_CHAIN_ID || process.env.CHAIN_ID || '84532';
    return parseInt(raw, 10);
  }

  /**
   * Canonical USDC ERC-20 address on Base. Mainnet and Sepolia have
   * different addresses — we fall back automatically based on chainId,
   * but BASE_USDC_ADDRESS wins if set.
   */
  get baseUsdcAddress(): string {
    if (process.env.BASE_USDC_ADDRESS) return process.env.BASE_USDC_ADDRESS;
    return this.baseChainId === 8453
      ? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' // Base mainnet
      : '0x036CbD53842c5426634e7929541eC2318f3dCF7e'; // Base Sepolia
  }

  /** Arena contract on Base. Falls back to legacy CONTRACT_ADDRESS. */
  get baseContractAddress(): string | undefined {
    return process.env.BASE_CONTRACT_ADDRESS || process.env.CONTRACT_ADDRESS;
  }

  /** Platform private key on Base. Falls back to legacy PRIVATE_KEY. */
  get basePrivateKey(): string | undefined {
    return process.env.BASE_PRIVATE_KEY || process.env.PRIVATE_KEY;
  }

  // ── Solana Settlement ──
  get solanaRpcUrl(): string | undefined {
    return process.env.SOLANA_RPC_URL;
  }

  get solanaPrivateKey(): string | undefined {
    return process.env.SOLANA_PRIVATE_KEY;
  }

  get solanaAlphaMint(): string | undefined {
    return process.env.SOLANA_ALPHA_MINT;
  }

  get solanaUsdcMint(): string | undefined {
    return process.env.SOLANA_USDC_MINT;
  }

  get solanaFeeWallet(): string | undefined {
    return process.env.SOLANA_FEE_WALLET;
  }

  get solanaFeeWalletKey(): string | undefined {
    return process.env.SOLANA_FEE_WALLET_KEY;
  }

  private getRequired(key: string): string {
    const value = process.env[key];
    if (!value) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
    return value;
  }
}
