import { Controller, Get, Post, Body, UseGuards, Req, Query } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ConfigService } from '../common/config/config.service';
import { ReferralsService } from './referrals.service';

@Controller('v1/referrals')
@UseGuards(JwtAuthGuard)
export class ReferralsController {
  constructor(
    private readonly referralsService: ReferralsService,
    private readonly configService: ConfigService,
  ) {}

  @Get('me')
  async getMyStats(
    @Req() req: any,
    @Query('paymentsLimit') paymentsLimit?: string,
  ) {
    const limit = paymentsLimit ? Math.min(Math.max(parseInt(paymentsLimit, 10) || 50, 1), 200) : 50;
    return this.referralsService.getReferralStats(req.user.userId, req.user.username, limit);
  }

  @Get('code')
  getMyCode(@Req() req: any) {
    const code = this.referralsService.getReferralCode(req.user.userId, req.user.username);
    return {
      referralCode: code,
      referralLink: `${this.configService.frontendUrl}?ref=${code}`,
    };
  }

  @Post('register')
  async register(@Req() req: any, @Body() body: { referrerCode: string }) {
    await this.referralsService.registerReferral(req.user.userId, body.referrerCode);
    return { success: true, message: 'Referral registered successfully' };
  }
}
