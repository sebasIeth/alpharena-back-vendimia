import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  User, UserSchema,
  Referral, ReferralSchema,
  ReferralPayment, ReferralPaymentSchema,
} from '../database/schemas';
import { ReferralsService } from './referrals.service';
import { ReferralsController } from './referrals.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Referral.name, schema: ReferralSchema },
      { name: ReferralPayment.name, schema: ReferralPaymentSchema },
    ]),
  ],
  controllers: [ReferralsController],
  providers: [ReferralsService],
  exports: [ReferralsService],
})
export class ReferralsModule {}
