import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Side, PlayerColor, Board } from '../common/types';
import { ChessMoveRequest, ChessUciMove } from '../common/types/chess.types';
import { MoveDoc, Match } from '../database/schemas';
import { TURN_TIMEOUT_MS, PULL_AGENT_TURN_TIMEOUT_MS } from '../common/constants/game.constants';
import { ChessEngine } from '../game-engine/chess';
import { AgentClientService } from './agent-client.service';
import { ActiveMatchesService, ActiveMatchState } from './active-matches.service';
import { EventBusService } from './event-bus.service';
import { HumanMoveService } from './human-move.service';

export interface ChessTurnResult {
  gameOver: boolean;
  chessEngine: ChessEngine;
  timedOut: boolean;
  winner: 'white' | 'black' | 'draw' | null;
  reason?: string;
}

function colorToSide(color: 'white' | 'black'): Side {
  return color === 'white' ? 'a' : 'b';
}

@Injectable()
export class ChessTurnControllerService {
  private readonly logger = new Logger(ChessTurnControllerService.name);

  constructor(
    @InjectModel(MoveDoc.name) private readonly moveModel: Model<MoveDoc>,
    @InjectModel(Match.name) private readonly matchModel: Model<Match>,
    private readonly agentClient: AgentClientService,
    private readonly activeMatches: ActiveMatchesService,
    private readonly eventBus: EventBusService,
    private readonly humanMoveService: HumanMoveService,
  ) {}

  async executeTurn(
    matchState: ActiveMatchState,
    chessEngine: ChessEngine,
    moveHistory: ChessUciMove[],
  ): Promise<ChessTurnResult> {
    const { matchId } = matchState;
    const currentColor = chessEngine.getTurn();
    const currentSide = colorToSide(currentColor);
    const agent = matchState.agents[currentSide];

    this.logger.log(
      `Executing chess turn: match=${matchId}, move=#${chessEngine.getMoveNumber()}, color=${currentColor}, side=${currentSide}`,
    );

    const legalMoves = chessEngine.getLegalMovesUci();

    if (legalMoves.length === 0) {
      // No legal moves = checkmate or stalemate (handled by chess.js)
      const winner = chessEngine.getWinner();
      return { gameOver: true, chessEngine, timedOut: false, winner, reason: chessEngine.isCheckmate() ? 'checkmate' : 'stalemate' };
    }

    if (matchState.clock) {
      const turnDeadline = matchState.clock.startTurn();
      this.activeMatches.updateMatch(matchId, { turnDeadline });
    }

    const timeRemainingMs = matchState.clock ? matchState.clock.getTimeRemainingMs() : 0;

    const moveRequest: ChessMoveRequest = {
      matchId,
      gameType: 'chess',
      fen: chessEngine.getFen(),
      board: chessEngine.getBoard(),
      yourColor: currentColor,
      legalMoves,
      moveNumber: chessEngine.getMoveNumber(),
      timeRemainingMs,
      isCheck: chessEngine.isCheck(),
      moveHistory,
    };

    const thinkingStart = Date.now();

    // Notify spectators that this agent's turn has started
    this.eventBus.emit('agent:thinking', {
      matchId,
      agentId: agent.agentId,
      side: currentSide,
      raw: '',
      moveNumber: chessEngine.getMoveNumber(),
    });

    try {
      let response: { move: ChessUciMove };

      if (agent.type === 'human' || agent.type === 'pull') {
        this.eventBus.emit('match:your_turn', {
          matchId,
          side: currentSide,
          gameType: 'chess',
          board: chessEngine.getBoard() as unknown as Board,
          legalMoves,
          fen: chessEngine.getFen(),
          moveNumber: chessEngine.getMoveNumber(),
          timeRemainingMs,
          turnTimeoutMs: TURN_TIMEOUT_MS,
        });

        const moveTimeout = agent.type === 'pull' ? PULL_AGENT_TURN_TIMEOUT_MS : undefined;
        const humanMove = await this.humanMoveService.waitForMove(matchId, currentSide, agent.agentId, moveTimeout);
        response = { move: humanMove as ChessUciMove };
      } else if (agent.type === 'openclaw') {
        response = await this.agentClient.requestChessMoveFromOpenClaw(agent, moveRequest, { side: currentSide, agentId: agent.agentId });
      } else {
        response = (await this.agentClient.requestMove(agent.endpointUrl, moveRequest as unknown as Record<string, unknown>)) as { move: string };
      }

      if (matchState.clock) matchState.clock.clearTurn();

      const thinkingTimeMs = Date.now() - thinkingStart;
      const uciMove = response.move;

      if (!chessEngine.isLegalUci(uciMove)) {
        this.logger.warn(`Agent returned invalid chess move "${uciMove}" for match ${matchId}`);
        return this.handleTimeout(matchState, chessEngine);
      }

      chessEngine.applyMoveUci(uciMove);
      moveHistory.push(uciMove);

      const boardRaw = chessEngine.getBoard();
      const board = boardRaw as unknown as Board;
      const materialScore = chessEngine.getMaterialScore();
      const scoreAfter = {
        a: Math.max(0, materialScore),
        b: Math.max(0, -materialScore),
      };

      // Update the generic game state in active matches
      this.activeMatches.updateMatch(matchId, {
        gameState: {
          ...matchState.gameState,
          board,
          currentPlayer: chessEngine.getTurn() === 'white' ? 'B' as PlayerColor : 'W' as PlayerColor,
          moveNumber: moveHistory.length,
          scores: { black: scoreAfter.a, white: scoreAfter.b },
          gameOver: chessEngine.isGameOver(),
          winner: chessEngine.isGameOver()
            ? (chessEngine.getWinner() === 'white' ? 'B' : chessEngine.getWinner() === 'black' ? 'W' : 'draw')
            : null,
        },
      });

      this.eventBus.emit('match:move', {
        matchId,
        side: currentSide,
        move: { row: 0, col: 0 }, // chess uses UCI, not row/col
        boardState: board,
        score: scoreAfter,
        moveNumber: moveHistory.length,
        thinkingTimeMs,
        chessMove: uciMove,
        fen: chessEngine.getFen(),
        isCheck: chessEngine.isCheck(),
      });

      await this.saveMove(matchId, agent.agentId, currentSide, moveHistory.length, uciMove, boardRaw, scoreAfter, thinkingTimeMs);

      await this.matchModel.updateOne(
        { _id: matchId },
        {
          currentBoard: boardRaw,
          currentTurn: colorToSide(chessEngine.getTurn()),
          moveCount: moveHistory.length,
          scores: scoreAfter,
          chessState: {
            fen: chessEngine.getFen(),
            moveHistory: [...moveHistory],
            pgn: chessEngine.getPgn(),
          },
        },
      );

      const winner = chessEngine.getWinner();
      return {
        gameOver: chessEngine.isGameOver(),
        chessEngine,
        timedOut: false,
        winner,
        reason: chessEngine.isCheckmate() ? 'checkmate' : chessEngine.isDraw() ? 'draw' : undefined,
      };
    } catch (error: unknown) {
      if (matchState.clock) matchState.clock.clearTurn();
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error during chess turn for match ${matchId}: ${message}`);
      return this.handleTimeout(matchState, chessEngine);
    }
  }

  private handleTimeout(matchState: ActiveMatchState, chessEngine: ChessEngine): ChessTurnResult {
    const { matchId } = matchState;
    const currentColor = chessEngine.getTurn();
    const currentSide = colorToSide(currentColor);

    const newTimeouts = { ...matchState.timeouts };
    newTimeouts[currentSide] += 1;
    this.activeMatches.updateMatch(matchId, { timeouts: newTimeouts });

    this.matchModel.updateOne(
      { _id: matchId },
      { [`timeouts.${currentSide}`]: newTimeouts[currentSide] },
    ).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to update timeout in DB for match ${matchId}: ${msg}`);
    });

    this.eventBus.emit('match:timeout', { matchId, side: currentSide, timeoutCount: newTimeouts[currentSide] });

    return { gameOver: false, chessEngine, timedOut: true, winner: null };
  }

  private async saveMove(
    matchId: string,
    agentId: string,
    side: Side,
    moveNumber: number,
    uciMove: string,
    boardStateAfter: number[][],
    scoreAfter: { a: number; b: number },
    thinkingTimeMs: number,
  ): Promise<void> {
    try {
      await this.moveModel.collection.insertOne({
        matchId: new Types.ObjectId(matchId),
        agentId: new Types.ObjectId(agentId),
        side, moveNumber,
        moveData: { row: 0, col: 0, uciMove },
        boardStateAfter, scoreAfter, thinkingTimeMs, timestamp: new Date(),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to save chess move #${moveNumber} for match ${matchId}: ${message}`);
    }
  }
}
