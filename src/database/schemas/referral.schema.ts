import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true, collection: 'referrals' })
export class Referral extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  referrerId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, unique: true, index: true })
  referredId: Types.ObjectId;

  @Prop({ default: 0 })
  totalEarned: number;

  createdAt: Date;
  updatedAt: Date;
}

export const ReferralSchema = SchemaFactory.createForClass(Referral);
