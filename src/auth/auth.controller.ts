import { Controller, Post, Get, Body, UseGuards, NotFoundException, HttpCode } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { SendVerificationCodeDto } from './dto/send-verification-code.dto';
import { VerifyCodeDto } from './dto/verify-code.dto';
import { ConnectWalletDto, SwitchWalletDto } from './dto/connect-wallet.dto';
import { RegisterWalletDto, WalletNonceDto } from './dto/register-wallet.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthPayload } from '../common/types';
import { SkipThrottle } from '@nestjs/throttler';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  async register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('wallet/register-nonce')
  @HttpCode(200)
  async getWalletRegisterNonce(@Body() dto: WalletNonceDto) {
    return this.authService.getWalletRegisterNonce(dto.walletAddress);
  }

  @Post('register-wallet')
  async registerWithWallet(@Body() dto: RegisterWalletDto) {
    return this.authService.registerWithWallet(dto.walletAddress, dto.signature, dto.nonce);
  }

  @Post('wallet/login-nonce')
  @HttpCode(200)
  async getWalletLoginNonce(@Body() dto: WalletNonceDto) {
    return this.authService.getWalletLoginNonce(dto.walletAddress);
  }

  @Post('login-wallet')
  @HttpCode(200)
  async loginWithWallet(@Body() dto: RegisterWalletDto) {
    return this.authService.loginWithWallet(dto.walletAddress, dto.signature, dto.nonce);
  }

  @Post('send-verification-code')
  @HttpCode(200)
  async sendVerificationCode(@Body() dto: SendVerificationCodeDto) {
    return this.authService.sendVerificationCode(dto.email);
  }

  @Post('verify-code')
  @HttpCode(200)
  async verifyCode(@Body() dto: VerifyCodeDto) {
    return this.authService.verifyCode(dto.email, dto.code);
  }

  @Post('forgot-password')
  @HttpCode(200)
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Post('reset-password')
  @HttpCode(200)
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() user: AuthPayload) {
    const profile = await this.authService.getProfile(user.userId);
    if (!profile) {
      throw new NotFoundException('User not found');
    }
    return profile;
  }

  @Get('me/wallet')
  @UseGuards(JwtAuthGuard)
  async wallet(@CurrentUser() user: AuthPayload) {
    const profile = await this.authService.getProfile(user.userId);
    if (!profile) {
      throw new NotFoundException('User not found');
    }
    return { walletAddress: profile.user.walletAddress };
  }

  @Get('wallet/nonce')
  @UseGuards(JwtAuthGuard)
  async getWalletNonce(@CurrentUser() user: AuthPayload) {
    return this.authService.getWalletNonce(user.userId);
  }

  @Post('wallet/connect')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  async connectWallet(@CurrentUser() user: AuthPayload, @Body() dto: ConnectWalletDto) {
    return this.authService.connectWallet(user.userId, dto.walletAddress, dto.signature);
  }

  @Post('wallet/switch')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  async switchWallet(@CurrentUser() user: AuthPayload, @Body() dto: SwitchWalletDto) {
    return this.authService.switchWallet(user.userId, dto.walletType);
  }

  @Post('wallet/disconnect')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  async disconnectWallet(@CurrentUser() user: AuthPayload) {
    return this.authService.disconnectWallet(user.userId);
  }
}
