import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  MarrakechGameState,
  MarrakechMoveRequest,
  MarrakechMoveResponse,
  Side,
  Board,
  Piece,
  MarrakechCarpetPlacement,
} from '../common/types';
import { TURN_TIMEOUT_MS, PULL_AGENT_TURN_TIMEOUT_MS } from '../common/constants/game.constants';
import { MoveDoc } from '../database/schemas';
import { Match } from '../database/schemas';
import { GameEngineService } from '../game-engine/game-engine.service';
import { AgentClientService } from './agent-client.service';
import { ActiveMatchesService, ActiveMatchState } from './active-matches.service';
import { EventBusService } from './event-bus.service';
import { HumanMoveService } from './human-move.service';

export interface MarrakechTurnResult {
  gameOver: boolean;
  gameState: MarrakechGameState;
  timedOut: boolean;
}

function playerIndexToSide(index: number): Side {
  return index === 0 ? 'a' : 'b';
}

@Injectable()
export class MarrakechTurnControllerService {
  private readonly logger = new Logger(MarrakechTurnControllerService.name);

  constructor(
    @InjectModel(MoveDoc.name) private readonly moveModel: Model<MoveDoc>,
    @InjectModel(Match.name) private readonly matchModel: Model<Match>,
    private readonly agentClient: AgentClientService,
    private readonly activeMatches: ActiveMatchesService,
    private readonly eventBus: EventBusService,
    private readonly gameEngine: GameEngineService,
    private readonly humanMoveService: HumanMoveService,
  ) {}

  async executeTurn(
    matchState: ActiveMatchState,
    mkState: MarrakechGameState,
  ): Promise<MarrakechTurnResult> {
    const { matchId } = matchState;
    const currentSide = playerIndexToSide(mkState.currentPlayerIndex);
    const agent = matchState.agents[currentSide];
    const marrakech = this.gameEngine.getMarrakechEngine();

    const currentPlayer = mkState.players[mkState.currentPlayerIndex];
    if (currentPlayer.eliminated || currentPlayer.carpetsRemaining === 0) {
      const newState = marrakech.advanceToNextPlayer(mkState);
      return { gameOver: newState.gameOver, gameState: newState, timedOut: false };
    }

    this.logger.log(`Executing Marrakech turn: match=${matchId}, turn=#${mkState.turnNumber}, side=${currentSide}`);

    let state = mkState;

    // Phase 1: Orient
    const validDirs = marrakech.getValidDirections(state.assam.direction);
    const orientResponse = await this.requestAction(
      agent.endpointUrl, matchId, 'orient', state,
      { directions: validDirs }, mkState.currentPlayerIndex, matchState, agent, currentSide,
    );

    if (!orientResponse) return this.handleTimeout(matchState, state, currentSide);
    if (orientResponse.action.type !== 'orient' || !validDirs.includes(orientResponse.action.direction)) {
      return this.handleTimeout(matchState, state, currentSide);
    }
    state = marrakech.orientAssam(state, orientResponse.action.direction);

    // Phase 2: Roll dice and move
    state = marrakech.rollAndMoveAssam(state);
    this.emitStateUpdate(matchId, state, currentSide, mkState.turnNumber);

    // Phase 3: BorderChoice
    while (state.phase === 'borderChoice' && state.borderChoiceInfo) {
      const borderOptions = state.borderChoiceInfo.options;
      const borderResponse = await this.requestAction(
        agent.endpointUrl, matchId, 'borderChoice', state,
        { borderOptions }, mkState.currentPlayerIndex, matchState, agent, currentSide,
      );

      if (!borderResponse) {
        state = marrakech.chooseBorderDirection(state, borderOptions[0].direction);
        continue;
      }
      if (borderResponse.action.type !== 'borderChoice') {
        state = marrakech.chooseBorderDirection(state, borderOptions[0].direction);
        continue;
      }
      const chosenDir = borderResponse.action.direction;
      if (!borderOptions.some((o) => o.direction === chosenDir)) {
        state = marrakech.chooseBorderDirection(state, borderOptions[0].direction);
        continue;
      }
      state = marrakech.chooseBorderDirection(state, chosenDir);
    }

    // Phase 4: Tribute
    state = marrakech.processTribute(state);
    if (state.gameOver) return { gameOver: true, gameState: state, timedOut: false };
    this.emitStateUpdate(matchId, state, currentSide, mkState.turnNumber);

    // Phase 5: Place carpet
    if (state.validPlacements.length === 0) {
      state = marrakech.skipPlace(state);
    } else {
      const placeResponse = await this.requestAction(
        agent.endpointUrl, matchId, 'place', state,
        { placements: state.validPlacements }, mkState.currentPlayerIndex, matchState, agent, currentSide,
      );

      if (!placeResponse) {
        state = marrakech.placeCarpet(state, state.validPlacements[0]);
      } else if (placeResponse.action.type === 'skip') {
        state = marrakech.skipPlace(state);
      } else if (placeResponse.action.type === 'place') {
        const placement = placeResponse.action.placement;
        const isValid = state.validPlacements.some(
          (p) =>
            p.cell1.row === placement.cell1.row &&
            p.cell1.col === placement.cell1.col &&
            p.cell2.row === placement.cell2.row &&
            p.cell2.col === placement.cell2.col,
        );
        if (isValid) {
          state = marrakech.placeCarpet(state, {
            ...placement,
            playerId: mkState.currentPlayerIndex,
            carpetId: '',
          } as MarrakechCarpetPlacement);
        } else {
          state = marrakech.placeCarpet(state, state.validPlacements[0]);
        }
      } else {
        state = marrakech.placeCarpet(state, state.validPlacements[0]);
      }
    }

    await this.saveMove(matchId, agent.agentId, currentSide, mkState.turnNumber, state);

    const serializedBoard = this.serializeBoard(state.board);
    const scores = { a: state.players[0]?.dirhams ?? 0, b: state.players[1]?.dirhams ?? 0 };
    await this.matchModel.updateOne(
      { _id: matchId },
      {
        currentBoard: serializedBoard,
        currentTurn: playerIndexToSide(state.currentPlayerIndex),
        moveCount: state.turnNumber,
        scores,
        marrakechState: state,
      },
    );

    this.emitStateUpdate(matchId, state, currentSide, state.turnNumber);
    return { gameOver: state.gameOver, gameState: state, timedOut: false };
  }

  private async requestAction(
    endpointUrl: string,
    matchId: string,
    phase: 'orient' | 'borderChoice' | 'place',
    state: MarrakechGameState,
    validActions: MarrakechMoveRequest['validActions'],
    playerIndex: number,
    matchState: ActiveMatchState,
    agent?: { agentId?: string; type?: string; openclawUrl?: string; openclawToken?: string; openclawAgentId?: string },
    side?: 'a' | 'b',
  ): Promise<MarrakechMoveResponse | null> {
    if (matchState.clock) matchState.clock.startTurn();

    // Route human agents through the HumanMoveService
    if ((agent?.type === 'human' || agent?.type === 'pull') && side && agent.agentId) {
      try {
        const board = this.serializeBoard(state.board);
        this.eventBus.emit('match:your_turn', {
          matchId,
          side,
          gameType: 'marrakech',
          board,
          legalMoves: phase === 'orient'
            ? (validActions as Record<string, unknown>).directions as unknown[]
            : phase === 'place'
              ? state.validPlacements
              : (validActions as Record<string, unknown>).borderOptions as unknown[],
          moveNumber: state.turnNumber,
          timeRemainingMs: matchState.clock ? matchState.clock.getTimeRemainingMs() : 30_000,
          turnTimeoutMs: TURN_TIMEOUT_MS,
        });

        const moveTimeout = agent.type === 'pull' ? PULL_AGENT_TURN_TIMEOUT_MS : undefined;
        const humanMove = await this.humanMoveService.waitForMove(matchId, side, agent.agentId, moveTimeout);
        if (matchState.clock) matchState.clock.clearTurn();
        return humanMove as MarrakechMoveResponse;
      } catch {
        if (matchState.clock) matchState.clock.clearTurn();
        return null;
      }
    }

    // Route OpenClaw agents through the OpenClaw client
    if (agent?.type === 'openclaw' && agent.openclawUrl && agent.openclawToken) {
      try {
        const openclawClient = this.agentClient.getOpenClawClient();
        const context = side && agent.agentId ? { side, agentId: agent.agentId } : undefined;
        const response = await openclawClient.getMarrakechMove(
          { openclawUrl: agent.openclawUrl, openclawToken: agent.openclawToken, openclawAgentId: agent.openclawAgentId || 'main' },
          matchId, phase, state, validActions, playerIndex, context,
        );
        if (matchState.clock) matchState.clock.clearTurn();
        return response;
      } catch {
        if (matchState.clock) matchState.clock.clearTurn();
        return null;
      }
    }

    // Standard HTTP agent
    const timeRemainingMs = matchState.clock ? matchState.clock.getTimeRemainingMs() : 30_000;

    const request: MarrakechMoveRequest = {
      matchId, gameType: 'marrakech', phase, state, validActions,
      turnNumber: state.turnNumber, timeRemainingMs, yourPlayerIndex: playerIndex,
    };

    try {
      const response = await this.agentClient.requestMove(
        endpointUrl, request as unknown as Record<string, unknown>,
      );
      if (matchState.clock) matchState.clock.clearTurn();
      return response as unknown as MarrakechMoveResponse;
    } catch {
      if (matchState.clock) matchState.clock.clearTurn();
      return null;
    }
  }

  private handleTimeout(
    matchState: ActiveMatchState,
    state: MarrakechGameState,
    side: Side,
  ): MarrakechTurnResult {
    const { matchId } = matchState;
    const newTimeouts = { ...matchState.timeouts };
    newTimeouts[side] += 1;
    this.activeMatches.updateMatch(matchId, { timeouts: newTimeouts });

    this.eventBus.emit('match:timeout', { matchId, side, timeoutCount: newTimeouts[side] });

    const marrakech = this.gameEngine.getMarrakechEngine();
    const newState = marrakech.advanceToNextPlayer(state);
    return { gameOver: false, gameState: newState, timedOut: true };
  }

  private emitStateUpdate(matchId: string, state: MarrakechGameState, side: Side, moveNumber: number): void {
    this.eventBus.emit('match:move', {
      matchId, side,
      move: { row: state.assam.position.row, col: state.assam.position.col },
      boardState: this.serializeBoard(state.board),
      score: { a: state.players[0]?.dirhams ?? 0, b: state.players[1]?.dirhams ?? 0 },
      moveNumber, thinkingTimeMs: 0,
      // Marrakech-specific
      assam: {
        position: { row: state.assam.position.row, col: state.assam.position.col },
        direction: state.assam.direction,
      },
      diceResult: state.lastDiceRoll ?? undefined,
      movePath: state.movePath.length > 0 ? state.movePath : undefined,
      phase: state.phase,
      tribute: state.currentTribute
        ? { fromPlayerId: state.currentTribute.fromPlayerId, toPlayerId: state.currentTribute.toPlayerId, amount: state.currentTribute.amount }
        : null,
      players: state.players.map((p) => ({
        id: p.id, name: p.name, dirhams: p.dirhams,
        carpetsRemaining: p.carpetsRemaining, eliminated: p.eliminated,
      })),
    });
  }

  private serializeBoard(board: MarrakechGameState['board']): Board {
    return board.map((row) =>
      row.map((cell) => (cell ? cell.playerId + 1 : 0) as Piece),
    ) as Board;
  }

  private async saveMove(
    matchId: string, agentId: string, side: Side, moveNumber: number, state: MarrakechGameState,
  ): Promise<void> {
    try {
      await this.moveModel.collection.insertOne({
        matchId: new Types.ObjectId(matchId), agentId: new Types.ObjectId(agentId),
        side, moveNumber,
        moveData: { row: state.assam.position.row, col: state.assam.position.col },
        boardStateAfter: this.serializeBoard(state.board),
        scoreAfter: { a: state.players[0]?.dirhams ?? 0, b: state.players[1]?.dirhams ?? 0 },
        thinkingTimeMs: 0, timestamp: new Date(),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to save Marrakech move #${moveNumber}: ${message}`);
    }
  }
}
