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
    return parseInt(process.env.CHAIN_ID || '56', 10);
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

  // ── Base Settlement ──
  get alphaAddress(): string | undefined {
    return process.env.ALPHA_ADDRESS;
  }

  get feeWallet(): string | undefined {
    return process.env.FEE_WALLET;
  }

  get feeWalletKey(): string | undefined {
    return process.env.FEE_WALLET_KEY;
  }

  private getRequired(key: string): string {
    const value = process.env[key];
    if (!value) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
    return value;
  }
}
