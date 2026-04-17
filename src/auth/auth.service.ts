import { Injectable, ConflictException, UnauthorizedException, BadRequestException, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { Keypair, PublicKey } from '@solana/web3.js';
import * as bs58 from 'bs58';
import * as crypto from 'crypto';
import * as nacl from 'tweetnacl';
import { User } from '../database/schemas';
import { ConfigService } from '../common/config/config.service';
import { generateWalletForChain } from '../common/wallet.util';
import { MailService } from '../mail/mail.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { AuthPayload } from '../common/types';
import { SettlementRouterService } from '../settlement/settlement-router.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly configService: ConfigService,
    private readonly mailService: MailService,
    private readonly settlementRouter: SettlementRouterService,
  ) {}

  async register(dto: RegisterDto) {
    const { username, password, email, verificationCode } = dto;

    const existingUsername = await this.userModel.findOne({ username });
    if (existingUsername) {
      throw new ConflictException('Username is already taken');
    }

    if (email) {
      const existingEmail = await this.userModel.findOne({ email });
      if (existingEmail) {
        throw new ConflictException('Email is already registered');
      }

      // Check email was verified via code
      if (!verificationCode) {
        throw new BadRequestException('Verification code is required');
      }

      const verification = await this.userModel.db.collection('email_verifications').findOne({
        email,
        code: verificationCode,
        expires: { $gt: new Date() },
      });
      if (!verification) {
        throw new BadRequestException('Invalid or expired verification code');
      }
    }

    const passwordHash = await bcrypt.hash(password, 12);

    // Auto-generate a custodial wallet on the default chain (Base by default)
    const chain = this.configService.chainDefault;
    const wallet = generateWalletForChain(chain);

    const user = await this.userModel.create({
      username,
      passwordHash,
      walletAddress: wallet.walletAddress,
      walletPrivateKey: wallet.walletPrivateKey,
      email: email ?? null,
      emailVerified: !!email,
      balance: 0,
    });

    // Clean up verification record
    if (email) {
      await this.userModel.db.collection('email_verifications').deleteOne({ email });
    }

    const payload: AuthPayload = { userId: user._id.toString(), username: user.username };
    const token = this.generateToken(payload);

    this.logger.log(`New user registered: ${username} (chain=${wallet.chain})`);

    // Create token accounts in background (don't block registration)
    this.settlementRouter.ensureTokenAccounts(wallet.chain, wallet.walletAddress).catch((err) =>
      this.logger.warn(`Failed to create ATAs for user ${username}: ${err.message}`),
    );

    return {
      token,
      user: this.sanitizeUser(user),
    };
  }

  /** Get a nonce for wallet registration (no auth required, stored temporarily in DB) */
  async getWalletRegisterNonce(walletAddress: string) {
    const nonce = crypto.randomBytes(32).toString('hex');
    const message = `Sign this message to register on AlphArena: ${nonce}`;

    // Store nonce temporarily (5 min TTL)
    await this.userModel.db.collection('wallet_nonces').updateOne(
      { walletAddress },
      { $set: { walletAddress, nonce, message, createdAt: new Date() } },
      { upsert: true },
    );
    // TTL index ensures auto-cleanup (created on first call)
    await this.userModel.db.collection('wallet_nonces').createIndex(
      { createdAt: 1 },
      { expireAfterSeconds: 300 },
    ).catch(() => {}); // Ignore if already exists

    return { nonce, message };
  }

  async registerWithWallet(walletAddress: string, signature: string, nonce: string) {
    // Validate wallet address
    let publicKey: PublicKey;
    try {
      publicKey = new PublicKey(walletAddress);
    } catch {
      throw new BadRequestException('Invalid Solana wallet address');
    }

    // Check if this wallet is already registered
    const existingWallet = await this.userModel.findOne({
      $or: [
        { externalWalletAddress: walletAddress },
        { walletAddress },
      ],
    });
    if (existingWallet) {
      throw new ConflictException('This wallet is already connected to an account');
    }

    // Verify nonce was issued and not expired
    const storedNonce = await this.userModel.db.collection('wallet_nonces').findOneAndDelete({
      walletAddress,
      nonce,
    });
    if (!storedNonce) {
      throw new BadRequestException('Invalid or expired nonce. Call GET /auth/wallet/register-nonce first.');
    }

    // Verify signature against the nonce message
    const message = `Sign this message to register on AlphArena: ${nonce}`;
    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = bs58.default.decode(signature);

    const isValid = nacl.sign.detached.verify(messageBytes, signatureBytes, publicKey.toBytes());
    if (!isValid) {
      throw new BadRequestException('Invalid wallet signature');
    }

    // Generate random username like "player_a3f8b2"
    const randomSuffix = crypto.randomBytes(4).toString('hex');
    let username = `player_${randomSuffix}`;

    // Ensure uniqueness (extremely unlikely collision but be safe)
    while (await this.userModel.findOne({ username })) {
      username = `player_${crypto.randomBytes(4).toString('hex')}`;
    }

    // Create user with external wallet as primary, still generate custodial wallet as fallback
    const custodialKeypair = Keypair.generate();

    const user = await this.userModel.create({
      username,
      walletAddress: custodialKeypair.publicKey.toBase58(),
      walletPrivateKey: bs58.default.encode(custodialKeypair.secretKey),
      externalWalletAddress: walletAddress,
      walletType: 'external',
      emailVerified: false,
      balance: 0,
      // Omit email and passwordHash entirely so sparse unique index ignores them
    });

    const payload: AuthPayload = { userId: user._id.toString(), username: user.username };
    const token = this.generateToken(payload);

    this.logger.log(`New wallet user registered: ${username} (wallet: ${walletAddress})`);

    // Create ATAs for both wallets in background
    this.settlementRouter.ensureTokenAccounts('solana', custodialKeypair.publicKey.toBase58()).catch((err) =>
      this.logger.warn(`Failed to create ATAs for custodial wallet: ${err.message}`),
    );
    this.settlementRouter.ensureTokenAccounts('solana', walletAddress).catch((err) =>
      this.logger.warn(`Failed to create ATAs for external wallet ${walletAddress}: ${err.message}`),
    );

    return {
      token,
      user: this.sanitizeUser(user),
    };
  }

  async login(dto: LoginDto) {
    const { username, password } = dto;

    const user = await this.userModel.findOne({ username });
    if (!user) {
      throw new UnauthorizedException('Invalid username or password');
    }

    if (!user.passwordHash) {
      throw new UnauthorizedException('This account uses wallet login. Connect your wallet to sign in.');
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      throw new UnauthorizedException('Invalid username or password');
    }

    const payload: AuthPayload = { userId: user._id.toString(), username: user.username };
    const token = this.generateToken(payload);

    this.logger.log(`User logged in: ${username}`);

    return {
      token,
      user: this.sanitizeUser(user),
    };
  }

  /** Get a nonce for wallet login (no auth required) */
  async getWalletLoginNonce(walletAddress: string) {
    const nonce = crypto.randomBytes(32).toString('hex');
    const message = `Sign this message to log in to AlphArena: ${nonce}`;

    await this.userModel.db.collection('wallet_nonces').updateOne(
      { walletAddress, type: 'login' },
      { $set: { walletAddress, type: 'login', nonce, message, createdAt: new Date() } },
      { upsert: true },
    );

    return { nonce, message };
  }

  async loginWithWallet(walletAddress: string, signature: string, nonce: string) {
    let publicKey: PublicKey;
    try {
      publicKey = new PublicKey(walletAddress);
    } catch {
      throw new BadRequestException('Invalid Solana wallet address');
    }

    // Find user by external wallet
    const user = await this.userModel.findOne({ externalWalletAddress: walletAddress });
    if (!user) {
      throw new UnauthorizedException('No account found for this wallet. Please register first.');
    }

    // Verify nonce
    const storedNonce = await this.userModel.db.collection('wallet_nonces').findOneAndDelete({
      walletAddress,
      type: 'login',
      nonce,
    });
    if (!storedNonce) {
      throw new BadRequestException('Invalid or expired nonce. Call GET /auth/wallet/login-nonce first.');
    }

    // Verify signature against the nonce message
    const message = `Sign this message to log in to AlphArena: ${nonce}`;
    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = bs58.default.decode(signature);

    const isValid = nacl.sign.detached.verify(messageBytes, signatureBytes, publicKey.toBytes());
    if (!isValid) {
      throw new UnauthorizedException('Invalid wallet signature');
    }

    const payload: AuthPayload = { userId: user._id.toString(), username: user.username };
    const token = this.generateToken(payload);

    this.logger.log(`Wallet login: ${user.username} (wallet: ${walletAddress})`);

    return {
      token,
      user: this.sanitizeUser(user),
    };
  }

  async getProfile(userId: string) {
    const user = await this.userModel.findById(userId);
    if (!user) {
      return null;
    }
    return { user: this.sanitizeUser(user) };
  }

  async sendVerificationCode(email: string) {
    // Check if email is already registered
    const existing = await this.userModel.findOne({ email });
    if (existing) {
      throw new ConflictException('Email is already registered');
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = new Date(Date.now() + 10 * 60 * 1000); // 10 min

    // Upsert pending verification
    await this.userModel.db.collection('email_verifications').updateOne(
      { email },
      { $set: { email, code, expires, verified: false, updatedAt: new Date() } },
      { upsert: true },
    );

    try {
      await this.mailService.sendVerificationCodeEmail(email, email, code);
    } catch {
      this.logger.error(`Failed to send verification code to ${email}`);
    }

    return { message: 'Verification code sent to your email' };
  }

  async verifyCode(email: string, code: string) {
    const doc = await this.userModel.db.collection('email_verifications').findOne({
      email,
      code,
      expires: { $gt: new Date() },
    });

    if (!doc) {
      throw new BadRequestException('Invalid or expired verification code');
    }

    await this.userModel.db.collection('email_verifications').updateOne(
      { email },
      { $set: { verified: true, updatedAt: new Date() } },
    );

    this.logger.log(`Email verified: ${email}`);

    return { message: 'Email verified successfully' };
  }

  async forgotPassword(dto: ForgotPasswordDto) {
    const genericMessage = 'If an account with that email exists, a reset link has been sent.';

    const user = await this.userModel.findOne({ email: dto.email });
    if (!user) {
      return { message: genericMessage };
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

    user.resetPasswordToken = hashedToken;
    user.resetPasswordExpires = new Date(Date.now() + 3600000); // 1 hour
    await user.save();

    try {
      await this.mailService.sendPasswordResetEmail(user.email!, user.username, rawToken);
    } catch {
      this.logger.error(`Failed to send reset email to ${user.email}`);
    }

    return { message: genericMessage };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const hashedToken = crypto.createHash('sha256').update(dto.token).digest('hex');

    const user = await this.userModel.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpires: { $gt: new Date() },
    });

    if (!user) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    user.passwordHash = await bcrypt.hash(dto.password, 12);
    user.resetPasswordToken = null;
    user.resetPasswordExpires = null;
    await user.save();

    this.logger.log(`Password reset successful for user: ${user.username}`);

    return { message: 'Password has been reset successfully' };
  }

  async getWalletNonce(userId: string) {
    const user = await this.userModel.findById(userId);
    if (!user) throw new BadRequestException('User not found');

    const nonce = crypto.randomBytes(32).toString('hex');
    user.walletNonce = nonce;
    await user.save();

    const message = `Sign this message to connect your wallet to AlphArena: ${nonce}`;
    return { nonce, message };
  }

  async connectWallet(userId: string, walletAddress: string, signature: string) {
    const user = await this.userModel.findById(userId);
    if (!user) throw new BadRequestException('User not found');

    if (!user.walletNonce) {
      throw new BadRequestException('No nonce found. Call GET /auth/wallet/nonce first.');
    }

    // Validate the wallet address is a valid Solana public key
    let publicKey: PublicKey;
    try {
      publicKey = new PublicKey(walletAddress);
    } catch {
      throw new BadRequestException('Invalid Solana wallet address');
    }

    // Check no other user has this external wallet
    const existing = await this.userModel.findOne({ externalWalletAddress: walletAddress, _id: { $ne: userId } });
    if (existing) {
      throw new ConflictException('This wallet is already connected to another account');
    }

    // Verify Ed25519 signature
    const message = `Sign this message to connect your wallet to AlphArena: ${user.walletNonce}`;
    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = bs58.default.decode(signature);

    const isValid = nacl.sign.detached.verify(messageBytes, signatureBytes, publicKey.toBytes());
    if (!isValid) {
      throw new BadRequestException('Invalid signature');
    }

    user.externalWalletAddress = walletAddress;
    user.walletType = 'external';
    user.walletNonce = null;
    await user.save();

    this.logger.log(`Wallet connected for user ${user.username}: ${walletAddress}`);

    // Ensure ATAs exist for the external wallet (platform pays)
    this.settlementRouter.ensureTokenAccounts('solana', walletAddress).catch((err) =>
      this.logger.warn(`Failed to create ATAs for external wallet ${walletAddress}: ${err.message}`),
    );

    return { user: this.sanitizeUser(user) };
  }

  async switchWallet(userId: string, walletType: string) {
    const user = await this.userModel.findById(userId);
    if (!user) throw new BadRequestException('User not found');

    if (walletType === 'external' && !user.externalWalletAddress) {
      throw new BadRequestException('No external wallet connected. Connect a wallet first.');
    }

    user.walletType = walletType;
    await user.save();

    this.logger.log(`User ${user.username} switched to ${walletType} wallet`);
    return { user: this.sanitizeUser(user) };
  }

  async disconnectWallet(userId: string) {
    const user = await this.userModel.findById(userId);
    if (!user) throw new BadRequestException('User not found');

    user.externalWalletAddress = null;
    user.walletType = 'custodial';
    user.walletNonce = null;
    await user.save();

    this.logger.log(`External wallet disconnected for user ${user.username}`);
    return { user: this.sanitizeUser(user) };
  }

  private generateToken(payload: AuthPayload): string {
    return jwt.sign(payload as object, this.configService.jwtSecret, {
      expiresIn: this.configService.jwtExpiresIn as string,
    } as jwt.SignOptions);
  }

  private sanitizeUser(user: User) {
    return {
      id: user._id.toString(),
      username: user.username,
      walletAddress: user.walletAddress,
      externalWalletAddress: user.externalWalletAddress ?? null,
      walletType: user.walletType ?? 'custodial',
      email: user.email,
      emailVerified: user.emailVerified ?? false,
      balance: user.balance,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }
}
