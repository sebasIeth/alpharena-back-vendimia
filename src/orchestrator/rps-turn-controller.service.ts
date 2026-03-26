import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Side } from '../common/types';
import { MoveDoc, Match } from '../database/schemas';
import { RPS_BEST_OF, RPS_VALID_THROWS, RpsThrow } from '../common/constants/game.constants';
import { ActiveMatchesService, ActiveMatchState } from './active-matches.service';
import { AgentClientService } from './agent-client.service';
import { EventBusService } from './event-bus.service';
import { HumanMoveService } from './human-move.service';

export interface RpsRoundResult {
  roundNumber: number;
  throwA: RpsThrow;
  throwB: RpsThrow;
  winner: 'a' | 'b' | 'draw';
}

export interface RpsGameState {
  bestOf: number;
  currentRound: number;
  scores: { a: number; b: number };
  rounds: RpsRoundResult[];
  phase: 'waiting_moves' | 'revealing' | 'round_result' | 'match_over';
  pendingThrows: { a?: RpsThrow; b?: RpsThrow };
}

export interface RpsRoundOutcome {
  rpsState: RpsGameState;
  matchOver: boolean;
  winner: Side | 'draw' | null;
}

function determineRoundWinner(throwA: RpsThrow, throwB: RpsThrow): 'a' | 'b' | 'draw' {
  if (throwA === throwB) return 'draw';
  if (
    (throwA === 'rock' && throwB === 'scissors') ||
    (throwA === 'scissors' && throwB === 'paper') ||
    (throwA === 'paper' && throwB === 'rock')
  ) return 'a';
  return 'b';
}

export function createRpsInitialState(bestOf: number = RPS_BEST_OF): RpsGameState {
  return {
    bestOf,
    currentRound: 1,
    scores: { a: 0, b: 0 },
    rounds: [],
    phase: 'waiting_moves',
    pendingThrows: {},
  };
}

@Injectable()
export class RpsTurnControllerService {
  private readonly logger = new Logger(RpsTurnControllerService.name);

  constructor(
    @InjectModel(MoveDoc.name) private readonly moveModel: Model<MoveDoc>,
    @InjectModel(Match.name) private readonly matchModel: Model<Match>,
    private readonly activeMatches: ActiveMatchesService,
    private readonly agentClient: AgentClientService,
    private readonly eventBus: EventBusService,
    private readonly humanMoveService: HumanMoveService,
  ) {}

  /**
   * Execute one round of RPS: request simultaneous moves from both players,
   * reveal, determine winner, update state.
   */
  async executeRound(
    matchState: ActiveMatchState,
    rpsState: RpsGameState,
  ): Promise<RpsRoundOutcome> {
    const { matchId } = matchState;
    const winsNeeded = Math.ceil(rpsState.bestOf / 2);

    this.logger.log(`RPS round ${rpsState.currentRound}: match=${matchId}`);

    rpsState.phase = 'waiting_moves';
    rpsState.pendingThrows = {};

    // Emit phase update to both players
    this.emitRpsState(matchId, rpsState);

    // Request moves from both players simultaneously
    // Use allSettled to ensure both complete even if one fails
    const results = await Promise.allSettled([
      this.requestThrow(matchState, rpsState, 'a'),
      this.requestThrow(matchState, rpsState, 'b'),
    ]);

    const throwA: RpsThrow = results[0].status === 'fulfilled'
      ? results[0].value
      : RPS_VALID_THROWS[Math.floor(Math.random() * 3)];
    const throwB: RpsThrow = results[1].status === 'fulfilled'
      ? results[1].value
      : RPS_VALID_THROWS[Math.floor(Math.random() * 3)];

    // Determine round winner
    const roundWinner = determineRoundWinner(throwA, throwB);
    const roundResult: RpsRoundResult = {
      roundNumber: rpsState.currentRound,
      throwA,
      throwB,
      winner: roundWinner,
    };

    rpsState.rounds.push(roundResult);
    if (roundWinner !== 'draw') {
      rpsState.scores[roundWinner] += 1;
    }

    // Revealing phase
    rpsState.phase = 'revealing';
    this.eventBus.emit('match:move', {
      matchId,
      rpsRound: rpsState.currentRound,
      rpsTotalRounds: rpsState.bestOf,
      rpsPhase: 'revealing',
      rpsScores: { ...rpsState.scores },
      rpsResult: roundResult,
    });

    // Save both moves to DB
    await Promise.all([
      this.saveMove(matchId, matchState.agents['a'].agentId, 'a', rpsState.currentRound, throwA, rpsState.scores),
      this.saveMove(matchId, matchState.agents['b'].agentId, 'b', rpsState.currentRound, throwB, rpsState.scores),
    ]);

    // Persist RPS state to DB
    await this.persistRpsState(matchId, rpsState);

    // Wait for reveal animation
    await new Promise<void>((r) => setTimeout(r, 2000));

    // Check if match is over
    const matchOver = rpsState.scores.a >= winsNeeded || rpsState.scores.b >= winsNeeded;
    let winner: Side | 'draw' | null = null;

    if (matchOver) {
      rpsState.phase = 'match_over';
      winner = rpsState.scores.a > rpsState.scores.b ? 'a' : 'b';
    } else {
      rpsState.phase = 'round_result';
      rpsState.currentRound += 1;
    }

    // Emit round result
    this.eventBus.emit('match:move', {
      matchId,
      rpsRound: rpsState.currentRound,
      rpsTotalRounds: rpsState.bestOf,
      rpsPhase: rpsState.phase,
      rpsScores: { ...rpsState.scores },
    });

    if (!matchOver) {
      // Brief pause between rounds
      await new Promise<void>((r) => setTimeout(r, 1500));
    }

    return { rpsState, matchOver, winner };
  }

  private async requestThrow(
    matchState: ActiveMatchState,
    rpsState: RpsGameState,
    side: Side,
  ): Promise<RpsThrow> {
    const { matchId } = matchState;
    const agent = matchState.agents[side];

    const moveRequest = {
      matchId,
      gameType: 'rps',
      currentRound: rpsState.currentRound,
      bestOf: rpsState.bestOf,
      scores: { ...rpsState.scores },
      yourSide: side,
      legalMoves: ['rock', 'paper', 'scissors'],
    };

    try {
      let response: unknown;

      if (agent.type === 'human' || agent.type === 'pull') {
        // Human/pull: emit your_turn and wait for WebSocket move
        this.eventBus.emit('match:your_turn', {
          matchId,
          side,
          gameType: 'rps',
          rpsRound: rpsState.currentRound,
          rpsTotalRounds: rpsState.bestOf,
          rpsPhase: 'waiting_moves',
          rpsScores: { ...rpsState.scores },
          legalMoves: ['rock', 'paper', 'scissors'],
          turnTimeoutMs: 70000,
        });
        response = await this.humanMoveService.waitForMove(matchId + ':' + side, side, agent.agentId, 70000);
      } else if (agent.type === 'openclaw') {
        const raw = await this.agentClient.requestChessMoveFromOpenClaw(agent as any, moveRequest as any, { side, agentId: agent.agentId });
        response = raw;
      } else {
        // HTTP agent
        response = await this.agentClient.requestMove(agent.endpointUrl, moveRequest as any);
      }

      const throwStr = this.parseThrow(response);
      if (throwStr) return throwStr;

      this.logger.warn(`Invalid RPS throw from ${side} in match ${matchId}: ${JSON.stringify(response)}`);
      return RPS_VALID_THROWS[Math.floor(Math.random() * 3)];
    } catch {
      this.logger.warn(`RPS throw timeout for side ${side} in match ${matchId}`);
      // Track timeout
      const newTimeouts = { ...matchState.timeouts };
      newTimeouts[side] = (newTimeouts[side] || 0) + 1;
      this.activeMatches.updateMatch(matchId, { timeouts: newTimeouts });
      this.matchModel.updateOne(
        { _id: matchId },
        { [`timeouts.${side}`]: newTimeouts[side] },
      ).catch(() => {});
      this.eventBus.emit('match:timeout', { matchId, side, timeoutCount: newTimeouts[side] });
      return RPS_VALID_THROWS[Math.floor(Math.random() * 3)];
    }
  }

  private parseThrow(move: unknown): RpsThrow | null {
    if (typeof move === 'string' && RPS_VALID_THROWS.includes(move as RpsThrow)) {
      return move as RpsThrow;
    }
    if (typeof move === 'object' && move !== null) {
      const obj = move as Record<string, unknown>;
      const val = obj.rpsThrow || obj.throw || obj.choice || obj.move;
      if (typeof val === 'string' && RPS_VALID_THROWS.includes(val as RpsThrow)) {
        return val as RpsThrow;
      }
    }
    return null;
  }

  private emitRpsState(matchId: string, state: RpsGameState): void {
    this.eventBus.emit('match:move', {
      matchId,
      rpsRound: state.currentRound,
      rpsTotalRounds: state.bestOf,
      rpsPhase: state.phase,
      rpsScores: { ...state.scores },
    });
  }

  private async persistRpsState(matchId: string, state: RpsGameState): Promise<void> {
    try {
      await this.matchModel.updateOne(
        { _id: matchId },
        {
          rpsState: { ...state, pendingThrows: {} }, // Don't persist pending throws
          scores: state.scores,
          moveCount: state.rounds.length * 2,
        },
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to persist RPS state for match ${matchId}: ${msg}`);
    }
  }

  private async saveMove(
    matchId: string,
    agentId: string,
    side: Side,
    roundNumber: number,
    rpsThrow: RpsThrow,
    scores: { a: number; b: number },
  ): Promise<void> {
    try {
      await this.moveModel.collection.insertOne({
        matchId: new Types.ObjectId(matchId),
        agentId: new Types.ObjectId(agentId),
        side,
        moveNumber: roundNumber,
        moveData: { rpsThrow, roundNumber },
        boardStateAfter: [],
        scoreAfter: scores,
        thinkingTimeMs: 0,
        timestamp: new Date(),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to save RPS move for match ${matchId}: ${msg}`);
    }
  }
}
