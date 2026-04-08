import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true, collection: 'referral_payments' })
export class ReferralPayment extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Referral', required: true, index: true })
  referralId: Types.ObjectId;

  @Prop({ required: true, index: true })
  matchId: string;

  @Prop({ required: true })
  feeAmount: number;

  @Prop({ required: true })
  referrerAmount: number;

  @Prop({ type: String, default: 'USDC' })
  token: string;

  @Prop({ type: String, default: null })
  txSignature: string | null;

  @Prop({ type: String, enum: ['pending', 'paid', 'failed'], default: 'pending' })
  status: string;

  createdAt: Date;
  updatedAt: Date;
}

export const ReferralPaymentSchema = SchemaFactory.createForClass(ReferralPayment);
