import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true, collection: 'transactions', toJSON: { virtuals: true }, toObject: { virtuals: true } })
export class Transaction extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Match', required: true, index: true })
  matchId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({
    type: String,
    enum: ['stake', 'payout', 'refund', 'platform_fee'],
    required: true,
  })
  type: string;

  @Prop({ required: true })
  amount: number;

  @Prop({ type: String, default: 'bnb' })
  chain: string;

  @Prop({ type: String, default: null })
  txHash: string;

  @Prop({
    type: String,
    enum: ['pending', 'confirmed', 'failed'],
    default: 'pending',
  })
  status: string;

  createdAt: Date;
  updatedAt: Date;
}

export const TransactionSchema = SchemaFactory.createForClass(Transaction);
TransactionSchema.index({ userId: 1, createdAt: -1 });
TransactionSchema.index({ txHash: 1 }, { sparse: true, unique: true });
