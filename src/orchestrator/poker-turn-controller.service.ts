import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Side, Board } from '../common/types';
import {
  PokerGameState, PokerMoveRequest, PokerMoveResponse,
  PokerAction, PokerActionType, PokerLegalActions,
} from '../common/types/poker.types';
import { MoveDoc, Match } from '../database/schemas';
import { TURN_TIMEOUT_MS, PULL_AGENT_TURN_TIMEOUT_MS } from '../common/constants/game.constants';
import {
  dealNewHand, getLegalActions, applyAction,
  isStreetOver, advanceStreet, resolveShowdown,
  resolveFold, isHandOver, isMatchOver,
  getActiveSides, getActableSides, countPlayersInHand,
} from '../game-engine/poker';
import { AgentClientService } from './agent-client.service';
import { ActiveMatchesService, ActiveMatchState } from './active-matches.service';
import { EventBusService } from './event-bus.service';
import { HumanMoveService } from './human-move.service';

/** Abort match after this many consecutive agent errors */
const MAX_CONSECUTIVE_ERRORS = 3;

export interface PokerHandResult {
  pokerState: PokerGameState;
  matchOver: boolean;
  winner: string | null;
}

@Injectable()
export class PokerTurnControllerService {
  private readonly logger = new Logger(PokerTurnControllerService.name);

  constructor(
    @InjectModel(MoveDoc.name) private readonly moveModel: Model<MoveDoc>,
    @InjectModel(Match.name) private readonly matchModel: Model<Match>,
    private readonly agentClient: AgentClientService,
    private readonly activeMatches: ActiveMatchesService,
    private readonly eventBus: EventBusService,
    private readonly humanMoveService: HumanMoveService,
  ) {}

  /** Track consecutive errors per match to abort runaway loops */
  private consecutiveErrors = new Map<string, number>();
  /** Track total action count across all hands per match */
  private totalActionCounts = new Map<string, number>();

  /** Build a Record<string, number> of all players' stacks */
  private buildStacksRecord(state: PokerGameState): Record<string, number> {
    const stacks: Record<string, number> = {};
    for (const [side, player] of Object.entries(state.players)) {
      stacks[side] = player.stack;
    }
    return stacks;
  }

  async executeHand(
    matchState: ActiveMatchState,
    pokerState: PokerGameState,
  ): Promise<PokerHandResult> {
    const { matchId } = matchState;

    // Initialize total action count if not set
    if (!this.totalActionCounts.has(matchId)) {
      this.totalActionCounts.set(matchId, 0);
    }

    // 1. Deal new hand
    let state = dealNewHand(pokerState);
    this.logger.log(
      `Hand #${state.handNumber} starting: match=${matchId}, dealer=${state.dealerSide}`,
    );

    // If not enough players to play (e.g. timeout eliminations), skip persisting
    // so the previous hand's resolved state (with holeCards/communityCards) stays in DB for replays
    if (state.gameOver) {
      return { pokerState: state, matchOver: true, winner: state.winner === 'draw' ? null : state.winner };
    }

    await this.persistPokerState(matchId, state);

    // 2. Loop through streets
    while (!isHandOver(state)) {
      // All non-folded players are all-in → skip to showdown
      if (getActableSides(state).length === 0) {
        break;
      }

      // Only one (or zero) player can still act → advance streets automatically
      const fewActable = getActableSides(state).length <= 1;

      // Within each street, loop through actions
      while (!isStreetOver(state) && !isHandOver(state)) {
        const currentSide = state.currentPlayerSide;
        const agent = matchState.agents[currentSide];

        // Check if match was cancelled externally
        const checkState = this.activeMatches.getMatch(matchId);
        if (!checkState || checkState.status !== 'active') {
          return { pokerState: state, matchOver: true, winner: null };
        }

        const legalActions = getLegalActions(state);
        const timeRemainingMs = matchState.clock ? matchState.clock.getTimeRemainingMs() : 0;

        // Build otherPlayers array from all players except current
        const otherPlayers = Object.entries(state.players)
          .filter(([side]) => side !== currentSide)
          .map(([side, p]) => ({
            side,
            stack: p.stack,
            currentBet: p.currentBet,
            hasFolded: p.hasFolded,
            isAllIn: p.isAllIn,
          }));

        const moveRequest: PokerMoveRequest = {
          matchId,
          gameType: 'poker',
          handNumber: state.handNumber,
          street: state.street,
          yourSide: currentSide,
          yourHoleCards: state.players[currentSide].holeCards,
          communityCards: state.communityCards,
          pot: state.pot,
          yourStack: state.players[currentSide].stack,
          yourCurrentBet: state.players[currentSide].currentBet,
          otherPlayers,
          legalActions,
          actionHistory: state.actionHistory,
          blinds: { small: state.smallBlind, big: state.bigBlind },
          isDealer: state.players[currentSide].isDealer,
          timeRemainingMs,
        };

        if (matchState.clock) {
          const turnDeadline = matchState.clock.startTurn();
          this.activeMatches.updateMatch(matchId, { turnDeadline });
        }

        const thinkingStart = Date.now();
        let actionResponse: PokerMoveResponse;

        // Notify spectators that this agent's turn has started
        this.eventBus.emit('agent:thinking', {
          matchId,
          agentId: agent.agentId,
          side: currentSide,
          raw: '',
          moveNumber: state.actionHistory.length,
        });

        try {
          if (agent.type === 'human' || agent.type === 'pull') {
            const playerStacks = this.buildStacksRecord(state);
            this.eventBus.emit('match:your_turn', {
              matchId,
              side: currentSide,
              gameType: 'poker',
              board: [] as unknown as Board,
              legalMoves: [legalActions],
              moveNumber: state.actionHistory.length,
              timeRemainingMs,
              turnTimeoutMs: TURN_TIMEOUT_MS,
              pokerHoleCards: state.players[currentSide].holeCards,
              pokerCommunityCards: state.communityCards,
              pokerPot: state.pot,
              pokerPlayerStacks: playerStacks,
              pokerStreet: state.street,
              pokerHandNumber: state.handNumber,
              pokerIsDealer: state.players[currentSide].isDealer,
              pokerActionHistory: state.actionHistory.map((a) => ({
                type: a.type, amount: a.amount, playerSide: a.playerSide, street: a.street,
              })),
            });

            const moveTimeout = agent.type === 'pull' ? PULL_AGENT_TURN_TIMEOUT_MS : undefined;
            const humanMove = await this.humanMoveService.waitForMove(matchId, currentSide, agent.agentId, moveTimeout);
            actionResponse = humanMove as PokerMoveResponse;
          } else if (agent.type === 'openclaw') {
            actionResponse = await this.agentClient.requestPokerMoveFromOpenClaw(
              agent, moveRequest, { side: currentSide, agentId: agent.agentId },
            );
          } else {
            actionResponse = (await this.agentClient.requestMove(agent.endpointUrl, moveRequest as unknown as Record<string, unknown>)) as unknown as PokerMoveResponse;
          }

          if (matchState.clock) matchState.clock.clearTurn();
          this.consecutiveErrors.delete(matchId);
        } catch (error: unknown) {
          if (matchState.clock) matchState.clock.clearTurn();
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error(`Error getting poker action for match ${matchId}: ${message}`);

          // Track consecutive errors — abort match if threshold exceeded
          const errCount = (this.consecutiveErrors.get(matchId) || 0) + 1;
          this.consecutiveErrors.set(matchId, errCount);

          if (errCount >= MAX_CONSECUTIVE_ERRORS) {
            this.logger.error(
              `Match ${matchId} aborted: ${errCount} consecutive agent errors`,
            );
            this.consecutiveErrors.delete(matchId);
            return { pokerState: state, matchOver: true, winner: null };
          }

          // Timeout → auto-fold
          actionResponse = { action: 'fold' };
          this.handleTimeout(matchState, currentSide);
        }

        const thinkingTimeMs = Date.now() - thinkingStart;

        // Validate & normalize action
        const validatedAction = this.validateAction(actionResponse, legalActions, currentSide);

        // Capture hand/street BEFORE applying action (applyAction may advance to next hand)
        const handNumberBefore = state.handNumber;
        const streetBefore = state.street;

        // Apply action to poker state
        const pokerAction: PokerAction = {
          type: validatedAction.action,
          amount: validatedAction.amount,
          playerSide: currentSide,
          street: streetBefore,
          timestamp: Date.now(),
        };

        state = applyAction(state, pokerAction);

        // Increment total action counter
        const totalActions = (this.totalActionCounts.get(matchId) || 0) + 1;
        this.totalActionCounts.set(matchId, totalActions);

        // Emit match:move event (use pre-action hand/street so moves stay in the correct hand)
        const moveNumber = totalActions;
        const playerStacks = this.buildStacksRecord(state);
        this.eventBus.emit('match:move', {
          matchId,
          side: currentSide,
          move: { row: 0, col: 0 },
          boardState: [] as unknown as Board,
          score: playerStacks,
          moveNumber,
          thinkingTimeMs,
          pokerAction: { type: validatedAction.action, amount: validatedAction.amount },
          pokerStreet: streetBefore,
          pokerPot: state.pot,
          pokerCommunityCards: state.communityCards,
          pokerPlayerStacks: playerStacks,
          pokerHandNumber: handNumberBefore,
          pokerPlayers: this.buildPokerPlayersPublic(state),
        });

        await this.saveMove(matchId, agent.agentId, currentSide, moveNumber, validatedAction, state, thinkingTimeMs, handNumberBefore, streetBefore);
        await this.persistPokerState(matchId, state);

        // Yield to event loop
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      // If hand is over (fold), break out
      if (isHandOver(state)) break;

      // Advance to next street (or showdown)
      if (state.street !== 'showdown') {
        state = advanceStreet(state);
        this.logger.log(`Hand #${state.handNumber}: advancing to ${state.street} (match=${matchId})`);
        await this.persistPokerState(matchId, state);

        // Emit street advance so spectators see community cards immediately
        const playerStacks = this.buildStacksRecord(state);
        this.eventBus.emit('match:move', {
          matchId,
          side: state.currentPlayerSide,
          move: { row: 0, col: 0 },
          boardState: [] as unknown as Board,
          score: playerStacks,
          moveNumber: state.actionHistory.length,
          thinkingTimeMs: 0,
          pokerStreet: state.street,
          pokerPot: state.pot,
          pokerCommunityCards: state.communityCards,
          pokerPlayerStacks: playerStacks,
          pokerHandNumber: state.handNumber,
          pokerPlayers: this.buildPokerPlayersPublic(state),
        });

        // If showdown after advance (river → showdown), break
        if (state.street === 'showdown') break;

        // If all non-folded players are all-in, skip action loops and keep advancing
        if (getActableSides(state).length === 0) continue;
        if (fewActable) continue;
      }
    }

    // 3. Resolve hand — capture pot before it resets to 0
    const potBeforeResolve = state.pot;
    let handWinner: string | null = null;
    if (countPlayersInHand(state) <= 1) {
      // Everyone but one player has folded
      const activeSides = getActiveSides(state);
      handWinner = activeSides.length === 1 ? activeSides[0] : null;
      state = resolveFold(state);
      this.logger.log(`Hand #${state.handNumber}: fold — handWinner=${handWinner} (match=${matchId})`);
    } else {
      state = resolveShowdown(state);
      handWinner = state.showdownResult?.winnerSide ?? null;
      this.logger.log(
        `Hand #${state.handNumber}: showdown — winner=${handWinner}, ` +
        `hand=${state.showdownResult?.winnerHand?.description} (match=${matchId})`,
      );
    }

    await this.persistPokerState(matchId, state);

    // Save hand history with hole cards for replay (always reveal after hand ends)
    const holeCards: Record<string, any> = {};
    for (const [side, player] of Object.entries(state.players)) {
      holeCards[side] = player.holeCards;
    }

    const handHistory = {
      handNumber: state.handNumber,
      holeCards,
      communityCards: state.communityCards,
      result: state.showdownResult ? 'showdown' : 'fold',
      winner: handWinner,
      pot: potBeforeResolve,
      actions: state.actionHistory.map(a => ({
        type: a.type, amount: a.amount, playerSide: a.playerSide, street: a.street,
      })),
    };
    await this.matchModel.updateOne(
      { _id: matchId },
      { $push: { pokerHandHistories: handHistory } },
    );

    // Emit hand result — always include hole cards so spectators can see them on rewind
    const playerStacks = this.buildStacksRecord(state);
    this.eventBus.emit('match:move', {
      matchId,
      side: state.winner ?? state.currentPlayerSide,
      move: { row: 0, col: 0 },
      boardState: [] as unknown as Board,
      score: playerStacks,
      moveNumber: state.actionHistory.length,
      thinkingTimeMs: 0,
      pokerStreet: state.street,
      pokerPot: state.pot,
      pokerCommunityCards: state.communityCards,
      pokerPlayerStacks: playerStacks,
      pokerHandNumber: state.handNumber,
      pokerPlayers: this.buildPokerPlayersWithCards(state),
      pokerShowdownResult: state.showdownResult ?? null,
      pokerHandResult: handHistory,
    });

    const matchOver = isMatchOver(state);
    if (matchOver) {
      this.totalActionCounts.delete(matchId);
      this.consecutiveErrors.delete(matchId);
    }
    return {
      pokerState: state,
      matchOver,
      winner: matchOver ? (state.winner ?? null) : null,
    };
  }

  /** Public view — no hole cards (safe to broadcast to spectators) */
  private buildPokerPlayersPublic(state: PokerGameState) {
    return Object.entries(state.players).map(([side, player]) => ({
      seatIndex: state.seatOrder.indexOf(side),
      side,
      stack: player.stack,
      holeCards: [] as { rank: string; suit: string }[],
      currentBet: player.currentBet,
      hasFolded: player.hasFolded,
      isAllIn: player.isAllIn,
      isDealer: player.isDealer,
    }));
  }

  /** Full view — includes hole cards (only for showdown) */
  private buildPokerPlayersWithCards(state: PokerGameState) {
    return Object.entries(state.players).map(([side, player]) => ({
      seatIndex: state.seatOrder.indexOf(side),
      side,
      stack: player.stack,
      holeCards: player.holeCards,
      currentBet: player.currentBet,
      hasFolded: player.hasFolded,
      isAllIn: player.isAllIn,
      isDealer: player.isDealer,
    }));
  }

  private validateAction(
    response: PokerMoveResponse,
    legalActions: PokerLegalActions,
    side: string,
  ): { action: PokerActionType; amount?: number } {
    const action = response.action;

    if (action === 'fold' && legalActions.canFold) return { action: 'fold' };
    if (action === 'check' && legalActions.canCheck) return { action: 'check' };
    if (action === 'call' && legalActions.canCall) return { action: 'call', amount: legalActions.callAmount };
    if (action === 'all_in' && legalActions.canAllIn) return { action: 'all_in', amount: legalActions.allInAmount };
    if (action === 'raise' && legalActions.canRaise) {
      const amount = response.amount ?? legalActions.minRaise;
      const clampedAmount = Math.max(legalActions.minRaise, Math.min(legalActions.maxRaise, amount));
      return { action: 'raise', amount: clampedAmount };
    }

    // Invalid action — fallback to check if possible, otherwise fold
    this.logger.warn(`Invalid poker action "${action}" from side ${side}, falling back`);
    if (legalActions.canCheck) return { action: 'check' };
    return { action: 'fold' };
  }

  private handleTimeout(matchState: ActiveMatchState, side: string): void {
    const { matchId } = matchState;
    const newTimeouts = { ...matchState.timeouts };
    newTimeouts[side] = (newTimeouts[side] || 0) + 1;
    this.activeMatches.updateMatch(matchId, { timeouts: newTimeouts });

    this.matchModel.updateOne(
      { _id: matchId },
      { [`timeouts.${side}`]: newTimeouts[side] },
    ).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to update timeout in DB for match ${matchId}: ${msg}`);
    });

    this.eventBus.emit('match:timeout', { matchId, side, timeoutCount: newTimeouts[side] });
  }

  private async saveMove(
    matchId: string,
    agentId: string,
    side: string,
    moveNumber: number,
    action: { action: PokerActionType; amount?: number },
    stateAfter: PokerGameState,
    thinkingTimeMs: number,
    handNumber?: number,
    street?: string,
  ): Promise<void> {
    try {
      // Build pokerPlayers record from all players
      const pokerPlayers: Record<string, { stack: number; currentBet: number; hasFolded: boolean; isAllIn: boolean }> = {};
      for (const [s, p] of Object.entries(stateAfter.players)) {
        pokerPlayers[s] = { stack: p.stack, currentBet: p.currentBet, hasFolded: p.hasFolded, isAllIn: p.isAllIn };
      }

      // Use direct collection insert to bypass Mongoose schema validation
      // (the MoveDoc schema was designed for reversi/chess board games)
      await this.moveModel.collection.insertOne({
        matchId: new Types.ObjectId(matchId),
        agentId: new Types.ObjectId(agentId),
        side, moveNumber,
        moveData: {
          row: 0, col: 0,
          pokerAction: action.action,
          pokerAmount: action.amount,
          pokerHandNumber: handNumber ?? stateAfter.handNumber,
          pokerStreet: street ?? stateAfter.street,
          pokerCommunityCards: stateAfter.communityCards,
          pokerPot: stateAfter.pot,
          pokerPlayers,
        },
        boardStateAfter: [],
        scoreAfter: this.buildStacksRecord(stateAfter),
        thinkingTimeMs,
        timestamp: new Date(),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to save poker move #${moveNumber} for match ${matchId}: ${message}`);
      this.logger.error(`Move details: side=${side}, matchId=${matchId}, moveNumber=${moveNumber}`);
    }
  }

  private async persistPokerState(matchId: string, state: PokerGameState): Promise<void> {
    // Strip deck from saved state (don't leak remaining cards)
    const stateToSave = { ...state, deck: [] };
    const totalMoveCount = this.totalActionCounts.get(matchId) || state.actionHistory.length;
    await this.matchModel.updateOne(
      { _id: matchId },
      {
        pokerState: stateToSave,
        currentTurn: state.currentPlayerSide,
        moveCount: totalMoveCount,
        scores: this.buildStacksRecord(state),
      },
    ).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to persist poker state for match ${matchId}: ${msg}`);
    });
  }
}
