import { Injectable, ConflictException, UnauthorizedException, BadRequestException, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { ethers } from 'ethers';
import * as crypto from 'crypto';
import { User } from '../database/schemas';
import { ConfigService } from '../common/config/config.service';
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

    // Auto-generate Base (EVM) wallet for the user
    const wallet = ethers.Wallet.createRandom();

    const user = await this.userModel.create({
      username,
      passwordHash,
      walletAddress: wallet.address,
      walletPrivateKey: wallet.privateKey,
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

    this.logger.log(`New user registered: ${username}`);

    // No-op on Base (EVM doesn't need ATAs), but keep the call for consistency
    this.settlementRouter.ensureTokenAccounts('bnb', wallet.address).catch(() => {});

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
      email: user.email,
      emailVerified: user.emailVerified ?? false,
      balance: user.balance,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }
}
