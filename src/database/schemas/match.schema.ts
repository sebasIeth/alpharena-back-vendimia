import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

@Schema({ _id: false })
export class MatchAgentSubDoc {
  @Prop({ type: Types.ObjectId, ref: 'Agent', required: true })
  agentId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  eloAtStart: number;
}

export const MatchAgentSubDocSchema = SchemaFactory.createForClass(MatchAgentSubDoc);

@Schema({ _id: false })
export class MatchResultSubDoc {
  @Prop({ type: Types.ObjectId, ref: 'Agent', default: null, required: false })
  winnerId: Types.ObjectId;

  @Prop({
    type: String,
    enum: ['score', 'timeout', 'forfeit', 'disconnect', 'draw'],
    required: true,
  })
  reason: string;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  finalScore: Record<string, number>;

  @Prop({ required: true })
  totalMoves: number;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  eloChange: Record<string, number>;
}

export const MatchResultSubDocSchema = SchemaFactory.createForClass(MatchResultSubDoc);

@Schema({ timestamps: true, collection: 'matches', toJSON: { virtuals: true }, toObject: { virtuals: true } })
export class Match extends Document {
  @Prop({ required: true })
  gameType: string;

  @Prop({ type: String, default: 'solana' })
  chain: string;

  @Prop({ type: String, default: 'ALPHA' })
  token: string;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  agents: Record<string, MatchAgentSubDoc>;

  @Prop({ required: true })
  stakeAmount: number;

  @Prop({ required: true })
  potAmount: number;

  @Prop({
    type: String,
    enum: ['pending', 'starting', 'active', 'completed', 'cancelled', 'error'],
    default: 'starting',
  })
  status: string;

  @Prop({ type: MatchResultSubDocSchema, default: null, required: false })
  result: MatchResultSubDoc;

  @Prop({ type: [[Number]], default: [] })
  currentBoard: number[][];

  @Prop({ type: String, default: 'a' })
  currentTurn: string;

  @Prop({ default: 0 })
  moveCount: number;

  @Prop({
    type: MongooseSchema.Types.Mixed,
    default: () => ({ a: 0, b: 0 }),
  })
  timeouts: Record<string, number>;

  @Prop({
    type: Object,
    default: () => ({ escrow: null, payout: null }),
  })
  txHashes: { escrow: string[]; payout: string; fee: string };

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  scores: Record<string, number>;

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  marrakechState: any;

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  chessState: any;

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  pokerState: any;

  /** Per-hand archive: [ { handNumber, holeCards: { a: Card[], b: Card[] }, result, winner } ] */
  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  pokerHandHistories: any[];

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  rpsState: any;

  @Prop({ type: Date, default: null })
  turnStartedAt: Date;

  @Prop({ type: Date, default: null })
  startedAt: Date;

  @Prop({ type: Date, default: null })
  endedAt: Date;

  createdAt: Date;
  updatedAt: Date;
}

export const MatchSchema = SchemaFactory.createForClass(Match);
MatchSchema.index({ status: 1 });
MatchSchema.index({ status: 1, updatedAt: -1 });
// Note: These agent indexes only cover 2-player matches (slots a & b).
// For N-player matches, queries on agents.c, agents.d, etc. won't use these indexes.
MatchSchema.index({ 'agents.a.userId': 1 });
MatchSchema.index({ 'agents.b.userId': 1 });
MatchSchema.index({ createdAt: -1 });
MatchSchema.index({ 'agents.a.agentId': 1, status: 1 });
MatchSchema.index({ 'agents.b.agentId': 1, status: 1 });
