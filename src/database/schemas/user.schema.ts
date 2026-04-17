import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { encrypt, decrypt } from '../../common/crypto.util';

@Schema({ timestamps: true, collection: 'users', toJSON: { virtuals: true }, toObject: { virtuals: true } })
export class User extends Document {
  @Prop({ type: String, required: false, unique: true, sparse: true, index: true, default: null })
  walletAddress: string | null;

  @Prop({ required: false, select: false, set: (v: string) => v ? encrypt(v) : v, get: (v: string) => v ? decrypt(v) : v })
  walletPrivateKey: string;

  @Prop({ required: true, unique: true, index: true })
  username: string;

  @Prop({ type: String, unique: true, sparse: true })
  email: string | null;

  @Prop({ type: String, required: false })
  passwordHash: string | null;

  @Prop({ default: 0 })
  balance: number;

  @Prop({ type: String, default: null })
  resetPasswordToken: string | null;

  @Prop({ type: Date, default: null })
  resetPasswordExpires: Date | null;

  @Prop({ type: String, default: null })
  verificationCode: string | null;

  @Prop({ type: Date, default: null })
  verificationCodeExpires: Date | null;

  @Prop({ default: false })
  emailVerified: boolean;

  // NOTE: no `default: null` — sparse unique indexes in MongoDB treat
  // documents with field=null as indexed (collision), while documents
  // without the field are skipped. Let Mongoose omit this field when
  // undefined.
  @Prop({ type: String, required: false, unique: true, sparse: true })
  externalWalletAddress?: string;

  @Prop({ type: String, default: 'custodial', enum: ['custodial', 'external'] })
  walletType: string;

  @Prop({ type: String, default: null })
  walletNonce: string | null;

  createdAt: Date;
  updatedAt: Date;
}

export const UserSchema = SchemaFactory.createForClass(User);
