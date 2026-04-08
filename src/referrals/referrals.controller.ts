import { Controller, Get, Post, Body, UseGuards, Req } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ReferralsService } from './referrals.service';

@Controller('v1/referrals')
@UseGuards(JwtAuthGuard)
export class ReferralsController {
  constructor(private readonly referralsService: ReferralsService) {}

  @Get('me')
  async getMyStats(@Req() req: any) {
    return this.referralsService.getReferralStats(req.user.userId, req.user.username);
  }

  @Get('code')
  getMyCode(@Req() req: any) {
    const code = this.referralsService.getReferralCode(req.user.userId, req.user.username);
    return {
      referralCode: code,
      referralLink: `https://app.alpharena.ai?ref=${code}`,
    };
  }

  @Post('register')
  async register(@Req() req: any, @Body() body: { referrerCode: string }) {
    await this.referralsService.registerReferral(req.user.userId, body.referrerCode);
    return { success: true, message: 'Referral registered successfully' };
  }
}
