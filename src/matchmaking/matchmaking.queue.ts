import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { QueueEntry as QueueEntryDoc } from '../database/schemas';

export type QueueEntryStatus = 'waiting' | 'pairing';

export interface QueueEntryData {
  agentId: string;
  userId: string;
  eloRating: number;
  stakeAmount: number;
  gameType: string;
  gameTypes?: string[];
  status: QueueEntryStatus;
  joinedAt: Date;
  agentType?: string;
  token?: string;
}

@Injectable()
export class MatchmakingQueue {
  private entries: QueueEntryData[] = [];
  private readonly logger = new Logger(MatchmakingQueue.name);

  constructor(@InjectModel('QueueEntry') private readonly queueEntryModel: Model<QueueEntryDoc>) {}

  async loadFromDatabase(): Promise<void> {
    // Clean stale entries older than 10 minutes and entries without gameTypes on startup
    const staleThreshold = new Date(Date.now() - 10 * 60 * 1000);
    const staleResult = await this.queueEntryModel.deleteMany({ $or: [{ joinedAt: { $lt: staleThreshold } }, { gameTypes: null }] });
    if (staleResult.deletedCount > 0) {
      this.logger.log(`Cleaned ${staleResult.deletedCount} stale queue entries on startup`);
    }

    const docs = await this.queueEntryModel.find({ status: { $in: ['waiting', 'pairing'] } }).lean();
    this.entries = docs.map((doc: any) => ({
      agentId: doc.agentId.toString(),
      userId: doc.userId?.toString() ?? doc.agentId.toString(),
      eloRating: doc.eloRating,
      stakeAmount: doc.stakeAmount,
      gameType: doc.gameType,
      gameTypes: doc.gameTypes || [doc.gameType],
      status: doc.status as QueueEntryStatus,
      joinedAt: doc.joinedAt,
      token: doc.token,
      agentType: doc.agentType,
    }));
    this.logger.log(`Loaded ${this.entries.length} queue entries from database`);
  }

  async add(entry: QueueEntryData): Promise<void> {
    const existing = this.entries.find((e) => e.agentId === entry.agentId);
    if (existing) throw new Error(`Agent ${entry.agentId} is already in the queue`);

    await this.queueEntryModel.create({
      agentId: entry.agentId,
      userId: entry.userId,
      eloRating: entry.eloRating,
      stakeAmount: entry.stakeAmount,
      gameType: entry.gameType,
      gameTypes: entry.gameTypes || [entry.gameType],
      token: entry.token,
      agentType: entry.agentType,
      status: entry.status,
      joinedAt: entry.joinedAt,
    });

    this.entries.push(entry);
    this.logger.log(`Agent ${entry.agentId} added to queue`);
  }

  async remove(agentId: string): Promise<void> {
    const index = this.entries.findIndex((e) => e.agentId === agentId);
    if (index !== -1) this.entries.splice(index, 1);
    await this.queueEntryModel.deleteOne({ agentId });
    this.logger.log(`Agent ${agentId} removed from queue`);
  }

  getWaiting(gameType: string): QueueEntryData[] {
    return this.entries.filter((e) => e.gameType === gameType && e.status === 'waiting');
  }

  async setStatus(agentId: string, status: QueueEntryStatus): Promise<void> {
    const entry = this.entries.find((e) => e.agentId === agentId);
    if (entry) entry.status = status;
    await this.queueEntryModel.updateOne({ agentId }, { $set: { status } });
  }

  getAll(): QueueEntryData[] {
    return [...this.entries];
  }

  size(): number { return this.entries.length; }

  get(agentId: string): QueueEntryData | undefined {
    return this.entries.find((e) => e.agentId === agentId);
  }

  getGameTypes(): string[] {
    const types = new Set<string>();
    for (const entry of this.entries) types.add(entry.gameType);
    return [...types];
  }

  /** Remove stuck 'pairing' entries only. Waiting entries stay indefinitely until matched or cancelled.
   *  Returns the removed entries so callers can issue refunds. */
  async cleanupStaleEntries(staleMs: number = 10 * 60 * 1000, pairingTimeoutMs: number = 60 * 1000): Promise<QueueEntryData[]> {
    const now = Date.now();
    const pairingThreshold = new Date(now - pairingTimeoutMs);

    // Only remove entries stuck in 'pairing' state (indicates a failed match attempt)
    // Waiting entries stay in queue until an opponent is found
    const toRemove = this.entries.filter(e =>
      e.status === 'pairing' && e.joinedAt < pairingThreshold,
    );

    if (toRemove.length === 0) return [];

    for (const entry of toRemove) {
      const index = this.entries.findIndex(e => e.agentId === entry.agentId);
      if (index !== -1) this.entries.splice(index, 1);
    }

    const agentIds = toRemove.map(e => e.agentId);
    await this.queueEntryModel.deleteMany({ agentId: { $in: agentIds } });
    this.logger.log(`Cleaned ${toRemove.length} stale/stuck queue entries: ${agentIds.join(', ')}`);
    return toRemove;
  }
}
