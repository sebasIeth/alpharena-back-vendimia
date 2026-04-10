import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Side } from '../common/types';
import { MoveDoc, Match, Agent } from '../database/schemas';
import {
  UnoGameState, UnoAction, UnoCard, UnoCardColor,
} from '../common/types/uno.types';
import { getLegalActions, applyAction, toSpectatorView, toPlayerView } from '../game-engine/uno';
import { ActiveMatchesService, ActiveMatchState } from './active-matches.service';
import { AgentClientService } from './agent-client.service';
import { EventBusService } from './event-bus.service';
import { HumanMoveService } from './human-move.service';
import { ChessMoveRequest } from '../common/types/chess.types';

const TURN_TIMEOUT = 70_000;
const COLORS: UnoCardColor[] = ['RED', 'BLUE', 'GREEN', 'YELLOW'];

@Injectable()
export class UnoTurnControllerService {
  private readonly logger = new Logger(UnoTurnControllerService.name);

  constructor(
    @InjectModel(MoveDoc.name) private readonly moveModel: Model<MoveDoc>,
    @InjectModel(Match.name) private readonly matchModel: Model<Match>,
    private readonly activeMatches: ActiveMatchesService,
    private readonly agentClient: AgentClientService,
    private readonly eventBus: EventBusService,
    private readonly humanMoveService: HumanMoveService,
  ) {}

  /**
   * Execute one turn of UNO: request move from current player,
   * validate, apply, emit state update.
   */
  async executeTurn(
    matchState: ActiveMatchState,
    unoState: UnoGameState,
  ): Promise<{ unoState: UnoGameState; matchOver: boolean; winner: string | null }> {
    const { matchId } = matchState;
    const side = unoState.currentTurn;

    this.logger.log(`UNO turn ${unoState.moveCount + 1}: match=${matchId}, side=${side}`);

    const legalActions = getLegalActions(unoState);

    // Emit state to spectators
    this.emitUnoState(matchId, unoState);

    // Request action from agent
    const action = await this.requestAction(matchState, unoState, side, legalActions);

    // Apply action
    applyAction(unoState, action);

    // Emit move event
    this.eventBus.emit('match:move', {
      matchId,
      side,
      unoAction: action,
      ...toSpectatorView(unoState),
    });

    // Save move to DB
    await this.saveMove(matchId, matchState.agents[side].agentId, side, unoState.moveCount, action, unoState);

    // Persist state to DB
    await this.persistUnoState(matchId, unoState);

    // Handle DRAW_CARD: if drawn card is playable, agent gets a follow-up action
    if (action.type === 'DRAW_CARD' && unoState.currentTurn === side && unoState.status !== 'finished') {
      // Agent drew a playable card — ask if they want to play it or pass
      const followUpActions = getLegalActions(unoState);
      // Filter: only the drawn card (last in hand) or PASS
      const drawnCard = unoState.players[side].hand[unoState.players[side].hand.length - 1];
      const filteredActions = followUpActions.filter(
        (a) => a.type === 'PASS' || (a.type === 'PLAY_CARD' && a.cardId === drawnCard.id),
      );

      if (filteredActions.length > 0) {
        const followUp = await this.requestAction(matchState, unoState, side, filteredActions);
        applyAction(unoState, followUp);

        this.eventBus.emit('match:move', {
          matchId,
          side,
          unoAction: followUp,
          ...toSpectatorView(unoState),
        });

        await this.saveMove(matchId, matchState.agents[side].agentId, side, unoState.moveCount, followUp, unoState);
        await this.persistUnoState(matchId, unoState);
      }
    }

    const matchOver = unoState.status === 'finished';
    return { unoState, matchOver, winner: unoState.winner };
  }

  private async requestAction(
    matchState: ActiveMatchState,
    unoState: UnoGameState,
    side: string,
    legalActions: UnoAction[],
  ): Promise<UnoAction> {
    const { matchId } = matchState;
    const agent = matchState.agents[side];
    const playerCount = Object.keys(unoState.players).length;
    const otherCounts: Record<string, number> = {};
    for (const [s, p] of Object.entries(unoState.players)) {
      if (s !== side) otherCounts[s] = p.hand.length;
    }
    const topCard = unoState.discardPile[unoState.discardPile.length - 1];

    const moveRequest = {
      matchId,
      gameType: 'uno',
      yourSide: side,
      hand: unoState.players[side].hand,
      topCard,
      currentColor: unoState.currentColor,
      opponentCardCounts: otherCounts,
      legalActions,
      moveNumber: unoState.moveCount,
      timeRemainingMs: TURN_TIMEOUT,
    };

    try {
      let response: unknown;

      if (agent.type === 'human' || agent.type === 'pull') {
        this.eventBus.emit('match:your_turn', {
          matchId,
          side,
          gameType: 'uno',
          ...toPlayerView(unoState, side),
          legalActions,
          turnTimeoutMs: TURN_TIMEOUT,
        });
        response = await this.humanMoveService.waitForMove(matchId, side, agent.agentId, TURN_TIMEOUT);
      } else if (agent.type === 'openclaw') {
        const raw = await this.agentClient.requestChessMoveFromOpenClaw(
          agent as unknown as Agent, moveRequest as unknown as ChessMoveRequest,
          { side, agentId: agent.agentId },
        );
        response = raw;
      } else if (agent.endpointUrl?.startsWith('internal://')) {
        // Built-in bot: pick a random legal action
        response = this.pickFallbackAction(legalActions);
      } else {
        response = await this.agentClient.requestMove(
          agent.endpointUrl,
          moveRequest as unknown as Record<string, unknown>,
        );
      }

      const parsed = this.parseAction(response, legalActions, unoState.players[side].hand);
      if (parsed) return parsed;

      this.logger.warn(`Invalid UNO action from ${side} in match ${matchId}: ${JSON.stringify(response)}`);
      return this.pickFallbackAction(legalActions);
    } catch {
      this.logger.warn(`UNO action timeout for side ${side} in match ${matchId}`);
      this.trackTimeout(matchState, side);
      return this.pickFallbackAction(legalActions);
    }
  }

  private parseAction(
    response: unknown,
    legalActions: UnoAction[],
    hand: UnoCard[],
  ): UnoAction | null {
    if (!response || typeof response !== 'object') return null;
    const obj = response as Record<string, unknown>;

    // Extract action type
    const actionType = (obj.type || obj.action || obj.actionType) as string | undefined;
    if (!actionType) return null;

    const upperType = actionType.toUpperCase();

    if (upperType === 'PASS') {
      const passAction = legalActions.find((a) => a.type === 'PASS');
      return passAction || null;
    }

    if (upperType === 'DRAW_CARD' || upperType === 'DRAW') {
      return legalActions.find((a) => a.type === 'DRAW_CARD') || null;
    }

    if (upperType === 'PLAY_CARD' || upperType === 'PLAY') {
      const cardId = obj.cardId as string | undefined;
      const chosenColor = ((obj.chosenColor || obj.color) as string | undefined)?.toUpperCase() as UnoCardColor | undefined;

      if (!cardId) {
        // Try to match by card value/color
        const cardColor = ((obj.cardColor || obj.color) as string | undefined)?.toUpperCase();
        const cardValue = obj.cardValue ?? obj.value;
        const cardType = ((obj.cardType) as string | undefined)?.toUpperCase();

        const matchedCard = hand.find((c) => {
          if (cardColor && c.color === cardColor && cardType && c.type === cardType) return true;
          if (cardColor && c.color === cardColor && cardValue != null && c.value === Number(cardValue)) return true;
          return false;
        });

        if (matchedCard) {
          const matchingLegal = legalActions.find(
            (a) => a.type === 'PLAY_CARD' && a.cardId === matchedCard.id &&
              (!a.chosenColor || a.chosenColor === chosenColor),
          );
          if (matchingLegal) return matchingLegal;
          // If wild, pick the color
          if (matchedCard.type === 'WILD' || matchedCard.type === 'WILD_DRAW_FOUR') {
            const color = chosenColor && COLORS.includes(chosenColor) ? chosenColor : COLORS[Math.floor(Math.random() * 4)];
            return { type: 'PLAY_CARD', cardId: matchedCard.id, chosenColor: color };
          }
        }
        return null;
      }

      // Find matching legal action
      const matching = legalActions.find(
        (a) => a.type === 'PLAY_CARD' && a.cardId === cardId,
      );
      if (matching) {
        // For wild cards, use chosen color if valid
        if (chosenColor && COLORS.includes(chosenColor)) {
          return { ...matching, chosenColor };
        }
        return matching;
      }
    }

    return null;
  }

  /** Pick a random legal action — prefer playing a card. */
  private pickFallbackAction(legalActions: UnoAction[]): UnoAction {
    const playable = legalActions.filter((a) => a.type === 'PLAY_CARD');
    if (playable.length > 0) {
      return playable[Math.floor(Math.random() * playable.length)];
    }
    return legalActions.find((a) => a.type === 'DRAW_CARD') || legalActions[0];
  }

  private trackTimeout(matchState: ActiveMatchState, side: string): void {
    const newTimeouts = { ...matchState.timeouts };
    newTimeouts[side] = (newTimeouts[side] || 0) + 1;
    this.activeMatches.updateMatch(matchState.matchId, { timeouts: newTimeouts });
    this.matchModel.updateOne(
      { _id: matchState.matchId },
      { [`timeouts.${side}`]: newTimeouts[side] },
    ).catch(() => {});
    this.eventBus.emit('match:timeout', {
      matchId: matchState.matchId, side, timeoutCount: newTimeouts[side],
    });
  }

  private emitUnoState(matchId: string, state: UnoGameState): void {
    this.eventBus.emit('match:move', {
      matchId,
      ...toSpectatorView(state),
      unoPhase: state.status,
    });
  }

  private async persistUnoState(matchId: string, state: UnoGameState): Promise<void> {
    try {
      // Persist without full hand details for security — only counts + top card
      await this.matchModel.updateOne(
        { _id: matchId },
        {
          unoState: {
            currentTurn: state.currentTurn,
            currentColor: state.currentColor,
            direction: state.direction,
            status: state.status,
            winner: state.winner,
            lastAction: state.lastAction,
            moveCount: state.moveCount,
            topCard: state.discardPile[state.discardPile.length - 1],
            drawPileCount: state.drawPile.length,
            handCounts: Object.fromEntries(
              Object.entries(state.players).map(([s, p]) => [s, p.hand.length]),
            ),
            // Store full hands for replay after match ends
            ...(state.status === 'finished' ? {
              players: {
                a: { hand: state.players.a.hand },
                b: { hand: state.players.b.hand },
              },
            } : {}),
          },
          currentTurn: state.currentTurn,
          moveCount: state.moveCount,
          scores: {
            a: state.winner === 'a' ? 1 : 0,
            b: state.winner === 'b' ? 1 : 0,
          },
        },
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to persist UNO state for match ${matchId}: ${msg}`);
    }
  }

  private async saveMove(
    matchId: string,
    agentId: string,
    side: string,
    moveNumber: number,
    action: UnoAction,
    state: UnoGameState,
  ): Promise<void> {
    try {
      await this.moveModel.collection.insertOne({
        matchId: new Types.ObjectId(matchId),
        agentId: new Types.ObjectId(agentId),
        side,
        moveNumber,
        moveData: {
          unoAction: action,
          topCard: state.discardPile[state.discardPile.length - 1],
          currentColor: state.currentColor,
          handCounts: {
            a: state.players.a.hand.length,
            b: state.players.b.hand.length,
          },
        },
        boardStateAfter: [],
        scoreAfter: { a: state.winner === 'a' ? 1 : 0, b: state.winner === 'b' ? 1 : 0 },
        thinkingTimeMs: 0,
        timestamp: new Date(),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to save UNO move for match ${matchId}: ${msg}`);
    }
  }
}
