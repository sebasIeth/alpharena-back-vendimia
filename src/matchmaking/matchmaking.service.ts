import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { MatchmakingQueue, QueueEntryData } from './matchmaking.queue';
import { findPairs, findPokerGroup } from './pairing';
import { Agent } from '../database/schemas';
import { MATCHMAKING_INTERVAL_MS, MATCHMAKING_COUNTDOWN_MS } from '../common/constants/game.constants';
import { OrchestratorService } from '../orchestrator/orchestrator.service';
import { EventBusService } from '../orchestrator/event-bus.service';
import { X402PaymentStore } from '../settlement/x402-payment-store.service';
import { ActiveMatchesService } from '../orchestrator/active-matches.service';
import { SettlementRouterService } from '../settlement/settlement-router.service';

@Injectable()
export class MatchmakingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MatchmakingService.name);
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private cleanupIntervalId: ReturnType<typeof setInterval> | null = null;
  private processing = false;
  private processingStartedAt: number | null = null;
  private onPairedCallback: ((agentA: string, agentB: string, stakeAmount: number, gameType: string, token?: string) => Promise<string>) | null = null;
  private onMultiMatchCallback: ((agentIds: string[], stakeAmount: number, gameType: string, token?: string) => Promise<string>) | null = null;
  private readonly countdowns = new Map<string, { startedAt: number }>();
  private readonly lastJoinTime = new Map<string, number>();
  private static readonly JOIN_COOLDOWN_MS = 5_000;
  private static readonly PROCESSING_TIMEOUT_MS = 30_000;
  private static readonly CLEANUP_INTERVAL_MS = 60_000;
  private static readonly COUNTDOWN_STALE_MS = MATCHMAKING_COUNTDOWN_MS * 3;

  constructor(
    private readonly queue: MatchmakingQueue,
    @InjectModel(Agent.name) private readonly agentModel: Model<Agent>,
    private readonly orchestrator: OrchestratorService,
    private readonly eventBus: EventBusService,
    private readonly x402PaymentStore: X402PaymentStore,
    private readonly activeMatches: ActiveMatchesService,
    private readonly settlementRouter: SettlementRouterService,
  ) {}

  /**
   * Refund stake to an agent that was removed from queue without matching.
   * Platform sends back the escrowed tokens.
   */
  private async refundStake(entry: QueueEntryData): Promise<void> {
    try {
      const agent = await this.agentModel.findById(entry.agentId);
      if (!agent?.walletAddress || !entry.stakeAmount || entry.stakeAmount <= 0) return;

      const chain = agent.chain || 'solana';
      const token = entry.token || 'USDC';
      const decimals = this.settlementRouter.getTokenDecimals(chain, token);
      const amountAtomic = BigInt(Math.round(entry.stakeAmount * 10 ** decimals));

      const txHash = await this.settlementRouter.transferTokenFromPlatform(chain, agent.walletAddress, amountAtomic, token);
      this.logger.log(`Refunded ${entry.stakeAmount} ${token} to agent ${entry.agentId} (tx: ${txHash})`);
    } catch (err: any) {
      this.logger.error(`Failed to refund agent ${entry.agentId}: ${err.message}`);
    }
  }

  async onModuleInit() {
    await this.queue.loadFromDatabase();

    // Sync: reset agents stuck in 'queued' or 'pairing' that aren't actually in the queue
    const queuedAgentIds = new Set(this.queue.getAll().map(e => e.agentId));
    const stuckAgents = await this.agentModel.find({ status: { $in: ['queued', 'pairing'] } });
    for (const agent of stuckAgents) {
      if (!queuedAgentIds.has(agent._id.toString())) {
        agent.status = 'idle';
        await agent.save();
        this.logger.log(`Recovered stuck agent ${agent.name} (${agent._id}) from ${agent.status} → idle`);
      }
    }

    this.setOnPairedCallback(async (agentAId, agentBId, stakeAmount, gameType, token) => {
      const [agentA, agentB] = await Promise.all([
        this.agentModel.findById(agentAId),
        this.agentModel.findById(agentBId),
      ]);
      if (!agentA || !agentB) throw new Error(`Agent not found: A=${agentAId}, B=${agentBId}`);

      return this.orchestrator.startMatch(
        {
          agentId: agentA._id.toString(),
          userId: agentA.userId?.toString() ?? '',
          name: agentA.name,
          endpointUrl: agentA.endpointUrl ?? '',
          eloRating: agentA.eloRating,
          type: agentA.type,
          chain: agentA.chain,
          token,
          openclawUrl: agentA.openclawUrl,
          openclawToken: agentA.openclawToken,
          openclawAgentId: agentA.openclawAgentId,
        },
        {
          agentId: agentB._id.toString(),
          userId: agentB.userId?.toString() ?? '',
          name: agentB.name,
          endpointUrl: agentB.endpointUrl ?? '',
          eloRating: agentB.eloRating,
          type: agentB.type,
          chain: agentB.chain,
          token,
          openclawUrl: agentB.openclawUrl,
          openclawToken: agentB.openclawToken,
          openclawAgentId: agentB.openclawAgentId,
        },
        stakeAmount,
        gameType,
      );
    });

    // Multi-agent callback for poker (N players)
    this.onMultiMatchCallback = async (agentIds, stakeAmount, gameType, token) => {
      const agentDocs = await Promise.all(agentIds.map(id => this.agentModel.findById(id)));
      const agents = agentDocs.filter(Boolean).map(a => ({
        agentId: a!._id.toString(),
        userId: a!.userId?.toString() ?? '',
        name: a!.name,
        endpointUrl: a!.endpointUrl ?? '',
        eloRating: a!.eloRating,
        type: a!.type,
        chain: a!.chain,
        token,
        openclawUrl: a!.openclawUrl,
        openclawToken: a!.openclawToken,
        openclawAgentId: a!.openclawAgentId,
      }));
      if (agents.length < 2) throw new Error('Not enough valid agents');
      return this.orchestrator.startMatchMulti(agents, stakeAmount, gameType);
    };

    this.logger.log(`Matchmaking service started, queue size: ${this.queue.size()}`);
    this.intervalId = setInterval(() => { void this.processPairing(); }, MATCHMAKING_INTERVAL_MS);
    this.cleanupIntervalId = setInterval(() => { void this.periodicCleanup(); }, MatchmakingService.CLEANUP_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.cleanupIntervalId !== null) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
    }
    this.countdowns.clear();
    this.lastJoinTime.clear();
    this.logger.log('Matchmaking service stopped');
  }

  setOnPairedCallback(cb: (agentA: string, agentB: string, stakeAmount: number, gameType: string, token?: string) => Promise<string>) {
    this.onPairedCallback = cb;
  }

  async joinQueue(agentId: string, userId: string, eloRating: number, stakeAmount: number, gameType: string, agentType?: string, token?: string, gameTypes?: string[]): Promise<void> {
    // Rate limiting: reject if agent joined too recently
    const now = Date.now();
    const lastJoin = this.lastJoinTime.get(agentId);
    if (lastJoin && now - lastJoin < MatchmakingService.JOIN_COOLDOWN_MS) {
      throw new Error(`Agent ${agentId} must wait ${Math.ceil((MatchmakingService.JOIN_COOLDOWN_MS - (now - lastJoin)) / 1000)}s before joining the queue again`);
    }
    this.lastJoinTime.set(agentId, now);

    // Prevent joining if already in an active match
    for (const [, state] of this.activeMatches.entries()) {
      for (const side of Object.keys(state.agents)) {
        if (state.agents[side].agentId === agentId) {
          throw new Error(`Agent ${agentId} is already in an active match`);
        }
      }
    }
    const entry: QueueEntryData = { agentId, userId, eloRating, stakeAmount, gameType, gameTypes, status: 'waiting', joinedAt: new Date(), agentType, token };
    await this.queue.add(entry);
    this.logger.log(`Agent ${agentId} joined matchmaking queue`);
  }

  async leaveQueue(agentId: string): Promise<void> {
    const entry = await this.queue.get(agentId);
    if (entry?.status === 'pairing') {
      throw new Error('Cannot leave queue while being matched. Try again shortly.');
    }
    await this.queue.remove(agentId);
    this.logger.log(`Agent ${agentId} left matchmaking queue`);

    // Refund stake if agent had pre-paid and was still waiting
    if (entry && entry.status === 'waiting' && entry.stakeAmount > 0) {
      await this.refundStake(entry);
    }
  }

  async getQueueStatus(agentId: string): Promise<QueueEntryData | undefined> {
    return this.queue.get(agentId);
  }

  async getQueueSize(gameType?: string): Promise<number> {
    if (gameType) return this.queue.getWaiting(gameType).length;
    return this.queue.size();
  }

  /** Get game types that have agents waiting, so new agents can join the same queue */
  getActiveGameTypes(): { gameType: string; count: number }[] {
    const types = this.queue.getGameTypes();
    return types.map(gt => ({ gameType: gt, count: this.queue.getWaiting(gt).length })).filter(t => t.count > 0);
  }

  getQueueEntries(gameType?: string): QueueEntryData[] {
    const all = this.queue.getAll();
    if (gameType) return all.filter((e) => e.gameType === gameType);
    return all;
  }

  private emitCountdown(gameType: string, remainingMs: number, waiting: QueueEntryData[]): void {
    this.eventBus.emit('matchmaking:countdown', {
      gameType,
      remainingMs,
      agents: waiting.map((e) => ({ agentId: e.agentId, eloRating: e.eloRating })),
    });
  }

  private async processPairing(): Promise<void> {
    if (!this.onPairedCallback) return;

    // Timeout safety: if processing flag is stuck, force-reset it
    if (this.processing) {
      if (this.processingStartedAt && Date.now() - this.processingStartedAt > MatchmakingService.PROCESSING_TIMEOUT_MS) {
        this.logger.warn('Processing flag stuck for too long, force-resetting');
        this.processing = false;
        this.processingStartedAt = null;
      } else {
        return;
      }
    }

    this.processing = true;
    this.processingStartedAt = Date.now();

    try {
      const allWaiting = this.queue.getAll().filter(e => e.status === 'waiting');
      if (allWaiting.length < 2) return;

      // 1. Try poker grouping first (3+ players that support poker)
      if (this.onMultiMatchCallback) {
        const pokerGroup = findPokerGroup(allWaiting);
        if (pokerGroup && pokerGroup.length >= 3) {
          const countdown = this.countdowns.get('poker');
          const now = Date.now();
          if (!countdown) {
            this.countdowns.set('poker', { startedAt: now });
            this.logger.log(`Poker countdown started with ${pokerGroup.length} agents`);
            this.emitCountdown('poker', MATCHMAKING_COUNTDOWN_MS, allWaiting);
          } else {
            const remaining = MATCHMAKING_COUNTDOWN_MS - (now - countdown.startedAt);
            if (remaining > 0) {
              this.emitCountdown('poker', remaining, allWaiting);
            } else {
              this.countdowns.delete('poker');
              this.logger.log(`Poker countdown expired, creating match with ${pokerGroup.length} players`);
              try {
                for (const entry of pokerGroup) await this.queue.setStatus(entry.agentId, 'pairing');
                const stakeAmount = Math.min(...pokerGroup.map(e => e.stakeAmount));
                const token = pokerGroup[0].token || 'ALPHA';

                // Re-validate x402 payments before poker match creation
                if (token === 'USDC' && stakeAmount > 0) {
                  const validGroup: typeof pokerGroup = [];
                  for (const entry of pokerGroup) {
                    const payment = this.x402PaymentStore.getPayment(entry.agentId);
                    if (!payment) {
                      this.logger.warn(`x402 payment expired for poker agent ${entry.agentId}, removing from queue and refunding`);
                      await this.queue.remove(entry.agentId);
                      await this.agentModel.updateOne({ _id: entry.agentId }, { $set: { status: 'idle' } });
                      await this.refundStake(entry);
                    } else {
                      validGroup.push(entry);
                    }
                  }
                  if (validGroup.length < 2) {
                    for (const entry of validGroup) {
                      try { await this.queue.setStatus(entry.agentId, 'waiting'); } catch {}
                    }
                    throw new Error('Not enough valid x402 payments for poker match');
                  }
                }

                const matchId = await this.onMultiMatchCallback(pokerGroup.map(e => e.agentId), stakeAmount, 'poker', token);
                if (token === 'USDC') {
                  const escrowTxs: { agentId: string; txSignature: string; amount: number }[] = [];
                  for (const entry of pokerGroup) {
                    const payment = this.x402PaymentStore.getPayment(entry.agentId);
                    if (payment) {
                      escrowTxs.push({ agentId: entry.agentId, txSignature: payment.txSignature, amount: payment.amount });
                      this.x402PaymentStore.consumePayment(entry.agentId);
                    }
                  }
                  if (escrowTxs.length > 0) {
                    await this.agentModel.db.collection('matches').updateOne(
                      { _id: new (require('mongoose').Types.ObjectId)(matchId) },
                      { $set: { 'txHashes.escrow': escrowTxs } },
                    );
                  }
                }
                this.eventBus.emit('matchmaking:matched', { matchId, gameType: 'poker', agents: pokerGroup.map(e => e.agentId) });
                for (const entry of pokerGroup) await this.queue.remove(entry.agentId);
              } catch (err) {
                this.logger.error(`Failed to create poker match: ${err}`);
                for (const entry of pokerGroup) {
                  try { await this.queue.setStatus(entry.agentId, 'waiting'); } catch {}
                }
              }
            }
          }
        }
      }

      // 2. Universal pairing: find any 2 agents with common game types
      const remaining = this.queue.getAll().filter(e => e.status === 'waiting');
      const pairs = findPairs(remaining);
      if (pairs.length === 0) return;

      // Instant pair for 2-agent matches (chess, or poker with only 2)
      for (const [entryA, entryB, chosenGame] of pairs) {
        try {
          await this.queue.setStatus(entryA.agentId, 'pairing');
          await this.queue.setStatus(entryB.agentId, 'pairing');
          const stakeAmount = Math.min(entryA.stakeAmount, entryB.stakeAmount);
          const token = entryA.token || entryB.token || 'ALPHA';

          // Re-validate x402 payments before match creation (payments can expire while in queue)
          if (token === 'USDC' && stakeAmount > 0) {
            for (const entry of [entryA, entryB]) {
              const payment = this.x402PaymentStore.getPayment(entry.agentId);
              if (!payment) {
                this.logger.warn(`x402 payment expired for agent ${entry.agentId}, removing from queue and refunding`);
                await this.queue.remove(entry.agentId);
                await this.agentModel.updateOne({ _id: entry.agentId }, { $set: { status: 'idle' } });
                await this.refundStake(entry);
                throw new Error(`x402 payment expired for agent ${entry.agentId}`);
              }
            }
          }

          this.logger.log(`Pairing ${entryA.agentId} vs ${entryB.agentId} for ${chosenGame}`);
          const matchId = await this.onPairedCallback(entryA.agentId, entryB.agentId, stakeAmount, chosenGame, token);
          if (token === 'USDC') {
            const escrowTxs: { agentId: string; txSignature: string; amount: number }[] = [];
            for (const entry of [entryA, entryB]) {
              const payment = this.x402PaymentStore.getPayment(entry.agentId);
              if (payment) {
                escrowTxs.push({ agentId: entry.agentId, txSignature: payment.txSignature, amount: payment.amount });
                this.x402PaymentStore.consumePayment(entry.agentId);
              }
            }
            if (escrowTxs.length > 0) {
              await this.agentModel.db.collection('matches').updateOne(
                { _id: new (require('mongoose').Types.ObjectId)(matchId) },
                { $set: { 'txHashes.escrow': escrowTxs } },
              );
            }
          }
          this.eventBus.emit('matchmaking:matched', { matchId, gameType: chosenGame, agents: [entryA.agentId, entryB.agentId] });
          await this.queue.remove(entryA.agentId);
          await this.queue.remove(entryB.agentId);
        } catch (err) {
          this.logger.error(`Failed to create match: ${err}`);
          try { await this.queue.setStatus(entryA.agentId, 'waiting'); } catch {}
          try { await this.queue.setStatus(entryB.agentId, 'waiting'); } catch {}
        }
      }
    } catch (err) {
      this.logger.error(`Error during pairing cycle: ${err}`);
    } finally {
      this.processing = false;
      this.processingStartedAt = null;
    }
  }

  /** Periodic cleanup of stale queue entries, stuck pairing entries, and orphaned countdowns */
  private async periodicCleanup(): Promise<void> {
    try {
      // Clean stale queue entries and stuck pairing entries
      const removedEntries = await this.queue.cleanupStaleEntries();
      if (removedEntries.length > 0) {
        // Refund stakes for removed entries
        for (const entry of removedEntries) {
          if (entry.stakeAmount > 0) {
            await this.refundStake(entry);
          }
        }

        // Reset agent statuses for cleaned entries
        const queuedAgentIds = new Set(this.queue.getAll().map(e => e.agentId));
        const stuckAgents = await this.agentModel.find({ status: { $in: ['queued', 'pairing'] } });
        for (const agent of stuckAgents) {
          if (!queuedAgentIds.has(agent._id.toString())) {
            agent.status = 'idle';
            await agent.save();
            this.logger.log(`Cleanup: reset agent ${agent.name} (${agent._id}) to idle`);
          }
        }
      }

      // Clean stale countdowns (Issue 7)
      const now = Date.now();
      for (const [key, countdown] of this.countdowns.entries()) {
        if (now - countdown.startedAt > MatchmakingService.COUNTDOWN_STALE_MS) {
          this.countdowns.delete(key);
          this.logger.log(`Cleanup: removed stale countdown for ${key}`);
        }
      }

      // Clean old lastJoinTime entries to prevent memory leak
      for (const [agentId, time] of this.lastJoinTime.entries()) {
        if (now - time > MatchmakingService.JOIN_COOLDOWN_MS * 10) {
          this.lastJoinTime.delete(agentId);
        }
      }
    } catch (err) {
      this.logger.error(`Error during periodic cleanup: ${err}`);
    }
  }
}
