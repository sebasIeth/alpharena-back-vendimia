import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { PLATFORM_FEE_PERCENT } from '../common/constants/game.constants';
import { MatchResultReason, Side } from '../common/types';
import { Match, Agent } from '../database/schemas';
import { ActiveMatchesService, ActiveMatchState } from './active-matches.service';
import { EventBusService } from './event-bus.service';
import { SettlementRouterService } from '../settlement/settlement-router.service';

const ELO_K = 32;

function expectedScore(playerRating: number, opponentRating: number): number {
  return 1 / (1 + Math.pow(10, (opponentRating - playerRating) / 400));
}

function calculateEloChanges(
  ratingA: number,
  ratingB: number,
  outcome: 'a' | 'b' | 'draw',
): { a: number; b: number } {
  const expectedA = expectedScore(ratingA, ratingB);
  const expectedB = expectedScore(ratingB, ratingA);
  let actualA: number, actualB: number;

  if (outcome === 'a') { actualA = 1; actualB = 0; }
  else if (outcome === 'b') { actualA = 0; actualB = 1; }
  else { actualA = 0.5; actualB = 0.5; }

  return {
    a: Math.round(ELO_K * (actualA - expectedA)),
    b: Math.round(ELO_K * (actualB - expectedB)),
  };
}

@Injectable()
export class ResultHandlerService {
  private readonly logger = new Logger(ResultHandlerService.name);

  constructor(
    @InjectModel(Match.name) private readonly matchModel: Model<Match>,
    @InjectModel(Agent.name) private readonly agentModel: Model<Agent>,
    private readonly activeMatches: ActiveMatchesService,
    private readonly eventBus: EventBusService,
    private readonly settlementRouter: SettlementRouterService,
  ) {}

  async handleMatchEnd(
    matchId: string,
    reason: string,
    forcedWinnerSide?: 'a' | 'b',
  ): Promise<void> {
    const matchState = this.activeMatches.getMatch(matchId);
    if (!matchState) {
      this.logger.error(`Match ${matchId} not found for result handling`);
      return;
    }

    if (matchState.clock) matchState.clock.stop();

    this.logger.log(`Handling match end: ${matchId}, reason=${reason}, forced=${forcedWinnerSide}`);

    const { winnerId, winningSide } = this.determineWinner(matchState, reason, forcedWinnerSide);
    const gameState = matchState.gameState;
    const finalScore = { a: gameState.scores.black, b: gameState.scores.white };

    const matchDoc = await this.matchModel.findById(matchId);
    if (!matchDoc) {
      this.logger.error(`Match document ${matchId} not found in DB`);
      this.activeMatches.removeMatch(matchId);
      return;
    }

    const eloOutcome: 'a' | 'b' | 'draw' = winningSide ?? 'draw';
    const eloChanges = calculateEloChanges(
      matchDoc.agents.a.eloAtStart,
      matchDoc.agents.b.eloAtStart,
      eloOutcome,
    );

    const matchChain = matchDoc.chain || 'bnb';
    const matchToken = matchDoc.token || 'USDC';
    const tokenDecimals = this.settlementRouter.getTokenDecimals(matchChain, matchToken);

    let payoutTxHash: string | null = null;
    let feeTxHash: string | null = null;
    if (matchDoc.potAmount > 0) {
      try {
        const potAmountToken = BigInt(matchDoc.potAmount) * BigInt(10 ** tokenDecimals);
        const platformFeeToken = potAmountToken * BigInt(PLATFORM_FEE_PERCENT) / BigInt(100);

        if (winnerId && winningSide) {
          const payoutAmountToken = potAmountToken - platformFeeToken;

          const winnerWallet = matchState.agents[winningSide].walletAddress;
          if (!winnerWallet) {
            this.logger.error(`No wallet address for winner (side=${winningSide}) in match ${matchId}`);
          } else {
            payoutTxHash = await this.settlementRouter.payout(matchChain, matchId, winnerWallet, payoutAmountToken, matchToken);
          }
        } else {
          // Draw refund: each agent gets their stake back minus their share of the fee
          const agentCount = Object.values(matchState.agents).filter((a: any) => a.walletAddress).length;
          const feePerAgent = platformFeeToken / BigInt(agentCount);
          const stakeAmountToken = BigInt(matchDoc.stakeAmount) * BigInt(10 ** tokenDecimals);
          const refundPerAgent = stakeAmountToken - feePerAgent;

          const refundTargets = Object.values(matchState.agents)
            .filter((a: any) => a.walletAddress)
            .map((a: any) => ({ address: a.walletAddress as string, amount: refundPerAgent }));
          payoutTxHash = await this.settlementRouter.refund(matchChain, matchId, refundTargets, matchToken);
        }

        // Send fee to dedicated fee wallet
        if (platformFeeToken > BigInt(0)) {
          feeTxHash = await this.settlementRouter.sendFee(matchChain, platformFeeToken, matchToken).catch((e: unknown) => {
            const msg = e instanceof Error ? e.message : String(e);
            this.logger.error(`Failed to send fee to fee wallet for match ${matchId}: ${msg}`);
            return null;
          });
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Settlement failed for match ${matchId}: ${message}`);
      }
    } else {
      this.logger.log(`Skipping settlement for zero-stake match ${matchId}`);
    }

    const matchResult = {
      winnerId: winnerId ?? null,
      reason,
      finalScore,
      totalMoves: matchDoc.moveCount || gameState.moveNumber,
      eloChange: eloChanges,
    };

    await this.matchModel.updateOne(
      { _id: matchId },
      {
        status: 'completed',
        result: matchResult,
        currentBoard: gameState.board,
        endedAt: new Date(),
        ...(payoutTxHash ? { 'txHashes.payout': payoutTxHash } : {}),
        ...(feeTxHash ? { 'txHashes.fee': feeTxHash } : {}),
      },
    );

    for (const [side, agent] of Object.entries(matchState.agents)) {
      const outcome = winningSide === side ? 'win' : winningSide ? 'loss' : 'draw';
      const eloDelta = eloChanges[side] ?? 0;
      const earnings = winningSide === side ? this.calculateEarnings(matchDoc) : 0;
      const token = matchDoc.token || 'USDC';
      await this.updateAgentStats(agent.agentId, outcome, eloDelta, earnings, token);
    }

    this.eventBus.emit('match:ended', {
      matchId,
      agentIds: Object.fromEntries(
        Object.entries(matchState.agents).map(([side, a]) => [side, a.agentId]),
      ),
      gameType: matchDoc.gameType ?? 'chess',
      result: { winnerId, reason, finalScore, totalMoves: gameState.moveNumber },
    });

    this.logger.log(`Match ${matchId} ended: winner=${winnerId}, reason=${reason}`);
    this.activeMatches.removeMatch(matchId);
  }

  private determineWinner(
    matchState: ActiveMatchState,
    reason: string,
    forcedWinnerSide?: 'a' | 'b',
  ): { winnerId: string | null; winningSide: 'a' | 'b' | null } {
    if (forcedWinnerSide) {
      return { winnerId: matchState.agents[forcedWinnerSide].agentId, winningSide: forcedWinnerSide };
    }

    const { winner } = matchState.gameState;
    if (winner === 'draw' || winner === null) {
      const { scores } = matchState.gameState;
      if (scores.black > scores.white) return { winnerId: matchState.agents.a.agentId, winningSide: 'a' };
      if (scores.white > scores.black) return { winnerId: matchState.agents.b.agentId, winningSide: 'b' };
      return { winnerId: null, winningSide: null };
    }

    const winningSide: 'a' | 'b' = winner === 'B' ? 'a' : 'b';
    return { winnerId: matchState.agents[winningSide].agentId, winningSide };
  }

  private calculateEarnings(matchDoc: any): number {
    const potAmount = matchDoc.potAmount;
    const platformFee = Math.floor(potAmount * (PLATFORM_FEE_PERCENT / 100));
    return potAmount - platformFee - matchDoc.stakeAmount;
  }

  private async updateAgentStats(
    agentId: string,
    outcome: 'win' | 'loss' | 'draw',
    eloDelta: number,
    earnings: number,
    token: string = 'USDC',
  ): Promise<void> {
    try {
      const statsUpdate: Record<string, number> = { 'stats.totalMatches': 1 };
      if (outcome === 'win') statsUpdate['stats.wins'] = 1;
      else if (outcome === 'loss') statsUpdate['stats.losses'] = 1;
      else statsUpdate['stats.draws'] = 1;
      if (earnings > 0) {
        statsUpdate['stats.totalEarnings'] = earnings;
        if (token === 'USDC') statsUpdate['stats.earningsUsdc'] = earnings;
        else statsUpdate['stats.earningsAlpha'] = earnings;
      }

      await this.agentModel.updateOne(
        { _id: agentId },
        { $inc: { ...statsUpdate, eloRating: eloDelta }, $set: { status: 'idle' } },
      );

      const agent = await this.agentModel.findById(agentId);
      if (agent && agent.stats.totalMatches > 0) {
        const winRate = agent.stats.wins / agent.stats.totalMatches;
        await this.agentModel.updateOne(
          { _id: agentId },
          { $set: { 'stats.winRate': Math.round(winRate * 10000) / 10000 } },
        );
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to update agent ${agentId} stats: ${message}`);
    }
  }
}
