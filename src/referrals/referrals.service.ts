import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { REFERRAL_FEE_PERCENT } from '../common/constants/game.constants';
import { User, Referral, ReferralPayment } from '../database/schemas';
import { SettlementRouterService } from '../settlement/settlement-router.service';
import { ConfigService } from '../common/config/config.service';

@Injectable()
export class ReferralsService {
  private readonly logger = new Logger(ReferralsService.name);

  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(Referral.name) private readonly referralModel: Model<Referral>,
    @InjectModel(ReferralPayment.name) private readonly referralPaymentModel: Model<ReferralPayment>,
    private readonly settlementRouter: SettlementRouterService,
    private readonly configService: ConfigService,
  ) {}

  getReferralCode(userId: string, username: string): string {
    return username;
  }

  async registerReferral(referredUserId: string, rawCode: string): Promise<void> {
    // Support pasting full referral URL — extract the code from ?ref= param
    let referrerCode = rawCode;
    try {
      const url = new URL(rawCode);
      const ref = url.searchParams.get('ref');
      if (ref) referrerCode = ref;
    } catch {
      // Not a URL, use as-is
    }

    const existing = await this.referralModel.findOne({ referredId: referredUserId });
    if (existing) {
      throw new BadRequestException('You already have a referrer registered');
    }

    const referrer = await this.userModel.findOne({
      username: { $regex: new RegExp(`^${referrerCode}$`, 'i') },
    });
    if (!referrer) {
      throw new BadRequestException('Invalid referral code');
    }

    if (referrer._id.toString() === referredUserId) {
      throw new BadRequestException('You cannot refer yourself');
    }

    await this.referralModel.create({
      referrerId: referrer._id,
      referredId: new Types.ObjectId(referredUserId),
    });

    this.logger.log(`Referral registered: ${referrerCode} -> user ${referredUserId}`);
  }

  async getReferralStats(userId: string, username: string, paymentsLimit = 50) {
    const referralCode = this.getReferralCode(userId, username);
    const referralLink = `${this.configService.frontendUrl}?ref=${referralCode}`;

    const referrals = await this.referralModel.find({ referrerId: new Types.ObjectId(userId) }).sort({ createdAt: -1 });

    const referralDetails = await Promise.all(
      referrals.map(async (ref) => {
        const user = await this.userModel.findById(ref.referredId).select('username createdAt');
        const payments = await this.referralPaymentModel.find({ referralId: ref._id });
        const totalGenerated = payments.reduce((sum, p) => sum + p.referrerAmount, 0);
        return {
          username: user?.username || 'Unknown',
          joinedAt: ref.createdAt,
          totalGeneratedSOL: totalGenerated,
        };
      }),
    );

    const recentPayments = await this.referralPaymentModel
      .find({
        referralId: { $in: referrals.map((r) => r._id) },
      })
      .sort({ createdAt: -1 })
      .limit(paymentsLimit);

    const totalEarned = referrals.reduce((sum, r) => sum + r.totalEarned, 0);

    const hasReferrer = !!(await this.referralModel.findOne({ referredId: new Types.ObjectId(userId) }));

    return {
      referralCode,
      referralLink,
      totalReferrals: referrals.length,
      totalEarnedSOL: totalEarned,
      hasReferrer,
      referrals: referralDetails,
      recentPayments: recentPayments.map((p) => ({
        amount: p.referrerAmount,
        token: p.token,
        matchId: p.matchId,
        date: p.createdAt,
        status: p.status,
        txSignature: p.txSignature,
      })),
    };
  }

  async processReferralPayment(
    matchId: string,
    agentOwnerId: string,
    feeAmount: number,
    token: string,
    chain: string,
  ): Promise<void> {
    const referral = await this.referralModel.findOne({
      referredId: new Types.ObjectId(agentOwnerId),
    });
    if (!referral) return;

    const referrerAmount = feeAmount * (REFERRAL_FEE_PERCENT / 100);
    if (referrerAmount <= 0) return;

    const payment = await this.referralPaymentModel.create({
      referralId: referral._id,
      matchId,
      feeAmount,
      referrerAmount,
      token,
      status: 'pending',
    });

    const referrer = await this.userModel.findById(referral.referrerId);
    const referrerWallet = referrer?.walletAddress || referrer?.externalWalletAddress;

    if (!referrerWallet) {
      this.logger.warn(
        `Referrer ${referral.referrerId} has no wallet — skipping payout for match ${matchId}`,
      );
      await this.referralPaymentModel.updateOne(
        { _id: payment._id },
        { status: 'failed' },
      );
      return;
    }

    try {
      const tokenDecimals = this.settlementRouter.getTokenDecimals(chain, token);
      const amountToken = BigInt(Math.round(referrerAmount * 10 ** tokenDecimals));

      const txSignature = await this.settlementRouter.transferTokenFromPlatform(
        chain,
        referrerWallet,
        amountToken,
        token,
      );

      await this.referralPaymentModel.updateOne(
        { _id: payment._id },
        { status: 'paid', txSignature },
      );
      await this.referralModel.updateOne(
        { _id: referral._id },
        { $inc: { totalEarned: referrerAmount } },
      );

      this.logger.log(
        `Referral payment: ${referrerAmount} ${token} to ${referrerWallet} for match ${matchId} (tx: ${txSignature})`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed referral payment for match ${matchId}, referrer ${referral.referrerId}: ${message}`,
      );
      await this.referralPaymentModel.updateOne(
        { _id: payment._id },
        { status: 'failed' },
      );
    }
  }
}
