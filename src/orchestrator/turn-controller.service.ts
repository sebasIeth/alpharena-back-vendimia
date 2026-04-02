import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { GameState, PlayerColor, Side, MoveRequest, Position } from '../common/types';
import { MoveDoc } from '../database/schemas';
import { Match } from '../database/schemas';
import { TURN_TIMEOUT_MS, PULL_AGENT_TURN_TIMEOUT_MS } from '../common/constants/game.constants';
import { GameEngineService } from '../game-engine/game-engine.service';
import { AgentClientService } from './agent-client.service';
import { ActiveMatchesService, ActiveMatchState } from './active-matches.service';
import { EventBusService } from './event-bus.service';
import { HumanMoveService } from './human-move.service';

export interface TurnResult {
  gameOver: boolean;
  gameState: GameState;
  timedOut: boolean;
  passed: boolean;
}

function colorToSide(color: PlayerColor): Side {
  return color === 'B' ? 'a' : 'b';
}

@Injectable()
export class TurnControllerService {
  private readonly logger = new Logger(TurnControllerService.name);

  constructor(
    @InjectModel(MoveDoc.name) private readonly moveModel: Model<MoveDoc>,
    @InjectModel(Match.name) private readonly matchModel: Model<Match>,
    private readonly agentClient: AgentClientService,
    private readonly activeMatches: ActiveMatchesService,
    private readonly eventBus: EventBusService,
    private readonly gameEngine: GameEngineService,
    private readonly humanMoveService: HumanMoveService,
  ) {}

  async executeTurn(matchState: ActiveMatchState): Promise<TurnResult> {
    const { matchId, gameState } = matchState;
    const currentColor = gameState.currentPlayer;
    const currentSide = colorToSide(currentColor);
    const agent = matchState.agents[currentSide];

    this.logger.log(
      `Executing turn: match=${matchId}, move=#${gameState.moveNumber}, player=${currentColor}, side=${currentSide}`,
    );

    const legalMoves = this.gameEngine.getLegalMoves(gameState);

    if (legalMoves.length === 0) {
      return this.handleNoLegalMoves(matchState, currentSide);
    }

    let turnDeadline = matchState.turnDeadline;
    if (matchState.clock) {
      turnDeadline = matchState.clock.startTurn();
      this.activeMatches.updateMatch(matchId, { turnDeadline });
    }

    const timeRemainingMs = matchState.clock ? matchState.clock.getTimeRemainingMs() : 0;

    const moveRequest: MoveRequest = {
      matchId,
      gameType: 'chess',
      board: gameState.board.map((row) => [...row]),
      yourPiece: agent.piece,
      legalMoves,
      moveNumber: gameState.moveNumber,
      timeRemainingMs,
    };

    const thinkingStart = Date.now();

    try {
      let response: { move: [number, number] };

      if (agent.type === 'human' || agent.type === 'pull') {
        // Emit your_turn event so the frontend knows it's the human's turn
        this.eventBus.emit('match:your_turn', {
          matchId,
          side: currentSide,
          gameType: 'chess',
          board: gameState.board,
          legalMoves,
          moveNumber: gameState.moveNumber,
          timeRemainingMs,
          turnTimeoutMs: TURN_TIMEOUT_MS,
        });

        const moveTimeout = agent.type === 'pull' ? PULL_AGENT_TURN_TIMEOUT_MS : undefined;
        const humanMove = await this.humanMoveService.waitForMove(matchId, currentSide, agent.agentId, moveTimeout);
        response = { move: humanMove as [number, number] };
      } else if (agent.type === 'openclaw') {
        response = await this.agentClient.requestReversiMoveFromOpenClaw(agent, moveRequest, { side: currentSide, agentId: agent.agentId });
      } else {
        response = (await this.agentClient.requestMove(agent.endpointUrl, moveRequest as unknown as Record<string, unknown>)) as { move: [number, number] };
      }

      if (matchState.clock) matchState.clock.clearTurn();

      const thinkingTimeMs = Date.now() - thinkingStart;
      const [row, col] = response.move;

      const isLegal = legalMoves.some(([lr, lc]) => lr === row && lc === col);
      if (!isLegal) {
        this.logger.warn(`Agent returned invalid move [${row},${col}] for match ${matchId}`);
        return this.handleTimeout(matchState, currentSide);
      }

      const newGameState = this.gameEngine.applyMove(gameState, { row, col });
      const scoreAfter = { a: newGameState.scores.black, b: newGameState.scores.white };

      this.activeMatches.updateMatch(matchId, { gameState: newGameState });

      this.eventBus.emit('match:move', {
        matchId,
        side: currentSide,
        move: { row, col },
        boardState: newGameState.board,
        score: scoreAfter,
        moveNumber: newGameState.moveNumber,
        thinkingTimeMs,
      });

      await this.saveMove(matchId, agent.agentId, currentSide, newGameState.moveNumber, { row, col }, newGameState.board, scoreAfter, thinkingTimeMs);

      await this.matchModel.updateOne(
        { _id: matchId },
        {
          currentBoard: newGameState.board,
          currentTurn: colorToSide(newGameState.currentPlayer),
          moveCount: newGameState.moveNumber,
          scores: scoreAfter,
        },
      );

      return { gameOver: newGameState.gameOver, gameState: newGameState, timedOut: false, passed: false };
    } catch (error: unknown) {
      if (matchState.clock) matchState.clock.clearTurn();
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error during turn for match ${matchId}: ${message}`);
      return this.handleTimeout(matchState, currentSide);
    }
  }

  private handleNoLegalMoves(matchState: ActiveMatchState, currentSide: Side): TurnResult {
    const { matchId, gameState } = matchState;
    this.logger.log(`No legal moves for side ${currentSide} in match ${matchId}`);

    if (this.gameEngine.isGameOver(gameState)) {
      return { gameOver: true, gameState, timedOut: false, passed: true };
    }

    const opponentColor: PlayerColor = currentSide === 'a' ? 'W' : 'B';
    const passedState: GameState = { ...gameState, currentPlayer: opponentColor };
    this.activeMatches.updateMatch(matchId, { gameState: passedState });

    return { gameOver: false, gameState: passedState, timedOut: false, passed: true };
  }

  private handleTimeout(matchState: ActiveMatchState, side: Side): TurnResult {
    const { matchId, gameState } = matchState;
    const newTimeouts = { ...matchState.timeouts };
    newTimeouts[side] += 1;
    this.activeMatches.updateMatch(matchId, { timeouts: newTimeouts });

    this.matchModel.updateOne(
      { _id: matchId },
      { [`timeouts.${side}`]: newTimeouts[side] },
    ).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to update timeout in DB for match ${matchId}: ${msg}`);
    });

    this.eventBus.emit('match:timeout', { matchId, side, timeoutCount: newTimeouts[side] });

    const opponentColor: PlayerColor = side === 'a' ? 'W' : 'B';
    const passedState: GameState = { ...gameState, currentPlayer: opponentColor };
    this.activeMatches.updateMatch(matchId, { gameState: passedState });

    return { gameOver: false, gameState: passedState, timedOut: true, passed: false };
  }

  private async saveMove(
    matchId: string,
    agentId: string,
    side: Side,
    moveNumber: number,
    moveData: { row: number; col: number },
    boardStateAfter: number[][],
    scoreAfter: { a: number; b: number },
    thinkingTimeMs: number,
  ): Promise<void> {
    try {
      await this.moveModel.collection.insertOne({
        matchId: new Types.ObjectId(matchId), agentId: new Types.ObjectId(agentId),
        side, moveNumber, moveData,
        boardStateAfter, scoreAfter, thinkingTimeMs, timestamp: new Date(),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to save move #${moveNumber} for match ${matchId}: ${message}`);
    }
  }
}
