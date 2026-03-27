import { Prop, Schema, SchemaFactory, raw } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { encrypt, decrypt } from '../../common/crypto.util';

@Schema({ _id: false })
export class AgentStatsSubDoc {
  @Prop({ default: 0 })
  wins: number;

  @Prop({ default: 0 })
  losses: number;

  @Prop({ default: 0 })
  draws: number;

  @Prop({ default: 0 })
  totalMatches: number;

  @Prop({ default: 0 })
  winRate: number;

  @Prop({ default: 0 })
  totalEarnings: number;

  @Prop({ default: 0 })
  earningsAlpha: number;

  @Prop({ default: 0 })
  earningsUsdc: number;
}

export const AgentStatsSubDocSchema = SchemaFactory.createForClass(AgentStatsSubDoc);

@Schema({ timestamps: true, collection: 'agents', toJSON: { virtuals: true }, toObject: { virtuals: true } })
export class Agent extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: false, index: true, default: null })
  userId: Types.ObjectId | null;

  @Prop({ required: true })
  name: string;

  @Prop({
    type: String,
    enum: ['http', 'openclaw', 'human', 'pull'],
    default: 'http',
  })
  type: string;

  @Prop({ required: false })
  endpointUrl: string;

  @Prop({ required: false })
  openclawUrl: string;

  @Prop({ required: false, set: (v: string) => v ? encrypt(v) : v, get: (v: string) => v ? decrypt(v) : v })
  openclawToken: string;

  @Prop({ default: 'main' })
  openclawAgentId: string;

@Prop({ required: false })
  selfclawPublicKey: string;

  @Prop({ required: false, index: true })
  walletAddress: string;

  @Prop({ required: false, select: false, set: (v: string) => v ? encrypt(v) : v, get: (v: string) => v ? decrypt(v) : v })
  walletPrivateKey: string;

  @Prop({ default: 1200, index: true })
  eloRating: number;

  @Prop({
    type: AgentStatsSubDocSchema,
    default: () => ({
      wins: 0, losses: 0, draws: 0, totalMatches: 0, winRate: 0, totalEarnings: 0, earningsAlpha: 0, earningsUsdc: 0,
    }),
  })
  stats: AgentStatsSubDoc;

  @Prop({
    type: String,
    enum: ['idle', 'queued', 'in_match', 'disabled'],
    default: 'idle',
  })
  status: string;

  @Prop({ type: [String], default: ['chess'] })
  gameTypes: string[];

  @Prop({ type: String, default: 'bnb' })
  chain: string;

  @Prop({ default: false })
  autoPlay: boolean;

  @Prop({ default: 0 })
  autoPlayStakeAmount: number;

  @Prop({ default: 0 })
  autoPlayConsecutiveErrors: number;

  @Prop({ required: false, index: true, unique: true, sparse: true })
  apiKeyHash: string;

  @Prop({ required: false })
  apiKeyPrefix: string;

  @Prop({ type: Date, required: false })
  lastHeartbeat: Date;

  @Prop({ required: false, index: true, unique: true, sparse: true })
  claimToken: string;

  @Prop({ type: String, enum: ['unclaimed', 'pending', 'claimed'], default: 'unclaimed' })
  claimStatus: string;

  @Prop({ required: false })
  xUsername: string;

  @Prop({ required: false })
  xVerificationChallenge: string;

  @Prop({ required: false })
  xVerificationPostUrl: string;

  createdAt: Date;
  updatedAt: Date;
}

export const AgentSchema = SchemaFactory.createForClass(Agent);
AgentSchema.index({ eloRating: 1, status: 1 });
AgentSchema.index({ 'stats.winRate': -1 });
