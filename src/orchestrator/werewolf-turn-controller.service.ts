import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { MoveDoc, Match, Agent } from '../database/schemas';
import {
  WerewolfGameState,
  WerewolfAction,
  WerewolfTurnResult,
  WerewolfRole,
} from '../common/types/werewolf.types';
import {
  getLegalActions,
  applyAction,
  toSpectatorView,
  toPlayerView,
  toPublicSnapshot,
} from '../game-engine/werewolf';
import { ActiveMatchesService, ActiveMatchState } from './active-matches.service';
import { AgentClientService } from './agent-client.service';
import { EventBusService } from './event-bus.service';
import { HumanMoveService } from './human-move.service';
import { ChessMoveRequest } from '../common/types/chess.types';

const TURN_TIMEOUT = 70_000;

@Injectable()
export class WerewolfTurnControllerService {
  private readonly logger = new Logger(WerewolfTurnControllerService.name);

  constructor(
    @InjectModel(MoveDoc.name) private readonly moveModel: Model<MoveDoc>,
    @InjectModel(Match.name) private readonly matchModel: Model<Match>,
    private readonly activeMatches: ActiveMatchesService,
    private readonly agentClient: AgentClientService,
    private readonly eventBus: EventBusService,
    private readonly humanMoveService: HumanMoveService,
  ) {}

  async executeTurn(
    matchState: ActiveMatchState,
    werewolfState: WerewolfGameState,
  ): Promise<WerewolfTurnResult> {
    const { matchId } = matchState;
    const side = werewolfState.activeSide;

    if (!side) {
      // Engine has no active side — resolve as finished or draw
      return {
        werewolfState,
        matchOver: true,
        winner: werewolfState.winner,
      };
    }

    this.logger.log(
      `Werewolf turn ${werewolfState.moveCount + 1}: match=${matchId}, side=${side}, phase=${werewolfState.phase}, cycle=${werewolfState.cycle}`,
    );

    const legalActions = getLegalActions(werewolfState, side);
    if (legalActions.length === 0) {
      this.logger.warn(`No legal actions for ${side} in phase ${werewolfState.phase}`);
      return {
        werewolfState,
        matchOver: werewolfState.status === 'finished',
        winner: werewolfState.winner,
      };
    }

    // Spectator state broadcast
    this.emitState(matchId, werewolfState);

    const action = await this.requestAction(matchState, werewolfState, side, legalActions);

    applyAction(werewolfState, side, action);

    // Emit move event (redacted — no secret info for night phases)
    const emitAction = this.redactForBroadcast(action, werewolfState);
    const spectator = toSpectatorView(werewolfState) as Record<string, unknown>;
    this.eventBus.emit('match:move', {
      matchId,
      side,
      werewolfAction: emitAction as { type: string; target?: string; role?: string },
      werewolfPhase: werewolfState.phase,
      cycle: werewolfState.cycle,
      activeSide: werewolfState.activeSide,
      werewolfPlayers: spectator.players as Record<string, unknown>,
      discussionLog: spectator.discussionLog as unknown[],
      deaths: spectator.deaths as unknown[],
      status: werewolfState.status,
      winner: werewolfState.winner,
      moveNumber: werewolfState.moveCount,
    });

    await this.saveMove(
      matchId,
      matchState.agents[side]?.agentId,
      side,
      werewolfState.moveCount,
      action,
      werewolfState,
    );

    await this.persistState(matchId, werewolfState);

    const matchOver = werewolfState.status === 'finished';
    return { werewolfState, matchOver, winner: werewolfState.winner };
  }

  private redactForBroadcast(action: WerewolfAction, _state: WerewolfGameState): WerewolfAction | { type: 'NIGHT_ACTION' } {
    if (action.type === 'NIGHT_KILL_VOTE' || action.type === 'SEER_INVESTIGATE') {
      return { type: 'NIGHT_ACTION' } as { type: 'NIGHT_ACTION' };
    }
    return action;
  }

  private async requestAction(
    matchState: ActiveMatchState,
    state: WerewolfGameState,
    side: string,
    legalActions: WerewolfAction[],
  ): Promise<WerewolfAction> {
    const { matchId } = matchState;
    const agent = matchState.agents[side];
    const me = state.players[side];

    const alivePlayers = Object.values(state.players)
      .filter((p) => p.isAlive)
      .map((p) => ({ side: p.side, displayName: p.displayName }));

    const moveRequest: Record<string, unknown> = {
      matchId,
      gameType: 'werewolf',
      yourSide: side,
      yourDisplayName: me.displayName,
      yourRole: me.role,
      phase: state.phase,
      cycle: state.cycle,
      alivePlayers,
      deaths: state.deaths,
      discussionLog: state.discussionLog,
      legalActions,
      moveNumber: state.moveCount,
      timeRemainingMs: TURN_TIMEOUT,
    };

    if (me.role === 'WEREWOLF') {
      moveRequest.knownWerewolves = Object.values(state.players)
        .filter((p) => p.role === 'WEREWOLF' && p.side !== side)
        .map((p) => p.side);
    }
    if (me.role === 'SEER') {
      moveRequest.yourSeerMemory = state.seerMemory;
    }

    try {
      let response: unknown;

      if (agent?.type === 'human' || agent?.type === 'pull') {
        const playerView = toPlayerView(state, side) as Record<string, unknown>;
        this.eventBus.emit('match:your_turn', {
          matchId,
          side,
          gameType: 'werewolf',
          yourRole: playerView.yourRole as string,
          yourDisplayName: playerView.yourDisplayName as string,
          knownWerewolves: playerView.knownWerewolves as string[] | undefined,
          seerMemory: playerView.seerMemory as unknown[] | undefined,
          werewolfPhase: state.phase,
          cycle: state.cycle,
          activeSide: state.activeSide,
          werewolfPlayers: playerView.players as Record<string, unknown>,
          discussionLog: state.discussionLog,
          deaths: state.deaths,
          legalActions,
          moveNumber: state.moveCount,
          turnTimeoutMs: TURN_TIMEOUT,
        });
        response = await this.humanMoveService.waitForMove(
          matchId,
          side,
          agent.agentId,
          TURN_TIMEOUT,
        );
      } else if (agent?.type === 'openclaw') {
        const raw = await this.agentClient.requestChessMoveFromOpenClaw(
          agent as unknown as Agent,
          moveRequest as unknown as ChessMoveRequest,
          { side, agentId: agent.agentId },
        );
        response = raw;
      } else if (agent?.endpointUrl?.startsWith('internal://')) {
        response = this.pickFallbackAction(legalActions, state, side);
      } else if (agent?.endpointUrl) {
        response = await this.agentClient.requestMove(
          agent.endpointUrl,
          moveRequest as Record<string, unknown>,
        );
      } else {
        response = this.pickFallbackAction(legalActions, state, side);
      }

      const parsed = this.parseAction(response, legalActions);
      if (parsed) return parsed;

      this.logger.warn(
        `Invalid Werewolf action from ${side} in match ${matchId}: ${JSON.stringify(response)}`,
      );
      return this.pickFallbackAction(legalActions, state, side);
    } catch {
      this.logger.warn(`Werewolf action timeout for ${side} in match ${matchId}`);
      this.trackTimeout(matchState, side);
      return this.pickFallbackAction(legalActions, state, side);
    }
  }

  private parseAction(response: unknown, legalActions: WerewolfAction[]): WerewolfAction | null {
    if (!response || typeof response !== 'object') return null;
    const obj = response as Record<string, unknown>;
    const rawType = (obj.type || obj.action || obj.actionType) as string | undefined;
    if (!rawType) return null;
    const upperType = rawType.toUpperCase();

    // Match target-bearing actions
    const targetLike = (obj.target || obj.targetSide || obj.victim) as string | undefined;
    const roleLike = ((obj.role || obj.claim) as string | undefined)?.toUpperCase() as WerewolfRole | undefined;

    for (const a of legalActions) {
      if (a.type !== upperType) continue;
      if (a.type === 'DAY_PASS') return a;
      if (a.type === 'DAY_CLAIM') {
        if (roleLike && a.role === roleLike) return a;
        continue;
      }
      // All remaining types have target
      if ('target' in a && targetLike && a.target === targetLike) return a;
    }
    return null;
  }

  private pickFallbackAction(
    legalActions: WerewolfAction[],
    _state: WerewolfGameState,
    side: string,
  ): WerewolfAction {
    if (legalActions.length === 0) return legalActions[0];

    const phase = legalActions[0].type;

    // Day discussion: mix of accuse / defend / claim / pass, weighted toward variety
    if (
      phase === 'DAY_ACCUSE' ||
      phase === 'DAY_DEFEND' ||
      phase === 'DAY_CLAIM' ||
      phase === 'DAY_PASS'
    ) {
      const pool = legalActions.filter(
        (a) =>
          a.type === 'DAY_ACCUSE' ||
          a.type === 'DAY_CLAIM' ||
          a.type === 'DAY_PASS',
      );
      const candidates = pool.length > 0 ? pool : legalActions;
      return candidates[Math.floor(Math.random() * candidates.length)];
    }

    // Day vote: random alive target (not self) if possible
    if (phase === 'DAY_VOTE') {
      const nonSelf = legalActions.filter(
        (a) => a.type === 'DAY_VOTE' && a.target !== side,
      );
      const pool = nonSelf.length > 0 ? nonSelf : legalActions;
      return pool[Math.floor(Math.random() * pool.length)];
    }

    // Night kill vote / seer investigate: random target
    return legalActions[Math.floor(Math.random() * legalActions.length)];
  }

  private trackTimeout(matchState: ActiveMatchState, side: string): void {
    const newTimeouts = { ...matchState.timeouts };
    newTimeouts[side] = (newTimeouts[side] || 0) + 1;
    this.activeMatches.updateMatch(matchState.matchId, { timeouts: newTimeouts });
    this.matchModel
      .updateOne({ _id: matchState.matchId }, { [`timeouts.${side}`]: newTimeouts[side] })
      .catch(() => {});
    this.eventBus.emit('match:timeout', {
      matchId: matchState.matchId,
      side,
      timeoutCount: newTimeouts[side],
    });
  }

  private emitState(matchId: string, state: WerewolfGameState): void {
    const spectator = toSpectatorView(state) as Record<string, unknown>;
    this.eventBus.emit('match:move', {
      matchId,
      werewolfPhase: state.phase,
      cycle: state.cycle,
      activeSide: state.activeSide,
      werewolfPlayers: spectator.players as Record<string, unknown>,
      discussionLog: spectator.discussionLog as unknown[],
      deaths: spectator.deaths as unknown[],
      status: state.status,
      winner: state.winner,
      moveNumber: state.moveCount,
    });
  }

  private async persistState(matchId: string, state: WerewolfGameState): Promise<void> {
    try {
      await this.matchModel.updateOne(
        { _id: matchId },
        {
          werewolfState: toPublicSnapshot(state),
          currentTurn: state.activeSide ?? 'a',
          moveNumber: state.moveCount,
        },
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to persist Werewolf state for match ${matchId}: ${msg}`);
    }
  }

  private async saveMove(
    matchId: string,
    agentId: string | undefined,
    side: string,
    moveNumber: number,
    action: WerewolfAction,
    state: WerewolfGameState,
  ): Promise<void> {
    if (!agentId) return;
    try {
      // Compact public snapshot so replay can reconstruct state at any step
      // without re-running the engine client-side. Excludes secret fields
      // (roles, seer memory, night votes) until the match is finished.
      const spectator = toSpectatorView(state) as Record<string, unknown>;
      await this.moveModel.collection.insertOne({
        matchId: new Types.ObjectId(matchId),
        agentId: new Types.ObjectId(agentId),
        side,
        moveNumber,
        moveData: {
          werewolfAction: action,
          phase: state.phase,
          cycle: state.cycle,
          werewolfSnapshot: {
            players: spectator.players,
            phase: spectator.phase,
            cycle: spectator.cycle,
            activeSide: spectator.activeSide,
            discussionLog: spectator.discussionLog,
            deaths: spectator.deaths,
            status: spectator.status,
            winner: spectator.winner,
          },
        },
        boardStateAfter: [],
        scoreAfter: {},
        thinkingTimeMs: 0,
        timestamp: new Date(),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to save Werewolf move for match ${matchId}: ${msg}`);
    }
  }
}
