import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import {
  MatchStartedEvent,
  MatchMoveEvent,
  MatchTimeoutEvent,
  MatchEndedEvent,
  AgentThinkingEvent,
  MatchmakingCountdownEvent,
  MatchmakingMatchedEvent,
  MatchYourTurnEvent,
} from '../common/types';
import { EventBusService } from '../orchestrator/event-bus.service';
import { RoomsService } from './rooms.service';

@Injectable()
export class BroadcasterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BroadcasterService.name);
  private readonly handlers = new Map<string, (...args: unknown[]) => void>();

  constructor(
    private readonly rooms: RoomsService,
    private readonly eventBus: EventBusService,
  ) {}

  onModuleInit(): void {
    this.start();
  }

  onModuleDestroy(): void {
    this.stop();
  }

  start(): void {
    this.logger.log('Broadcaster starting, subscribing to match events');

    const onMatchStarted = (data: MatchStartedEvent): void => {
      const payload: Record<string, unknown> = {
        matchId: data.matchId,
        gameType: data.gameType,
        board: data.board,
      };
      if (data.assam) payload.assam = data.assam;
      if (data.players) payload.players = data.players;
      if (data.fen) payload.fen = data.fen;
      // Poker-specific
      if (data.pokerPlayerStacks) payload.pokerPlayerStacks = data.pokerPlayerStacks;
      if (data.pokerHandNumber != null) payload.pokerHandNumber = data.pokerHandNumber;
      // RPS-specific
      if (data.rpsTotalRounds != null) payload.rpsTotalRounds = data.rpsTotalRounds;
      if (data.rpsRound != null) payload.rpsRound = data.rpsRound;
      if (data.rpsPhase) payload.rpsPhase = data.rpsPhase;
      if (data.rpsScores) payload.rpsScores = data.rpsScores;
      // UNO-specific
      if (data.unoState) payload.unoState = data.unoState;
      // Werewolf-specific
      if (data.werewolfState) payload.werewolfState = data.werewolfState;
      this.rooms.broadcast(data.matchId, { type: 'match:start', data: payload });
    };

    const onMatchMove = (data: MatchMoveEvent): void => {
      const payload: Record<string, unknown> = {
        matchId: data.matchId,
        side: data.side,
      };
      if (data.move) payload.move = { row: data.move.row, col: data.move.col };
      if (data.boardState) payload.boardState = data.boardState;
      if (data.score) payload.score = { a: data.score.a, b: data.score.b };
      if (data.moveNumber != null) payload.moveNumber = data.moveNumber;
      if (data.thinkingTimeMs != null) payload.thinkingTimeMs = data.thinkingTimeMs;
      // Marrakech-specific fields
      if (data.assam) payload.assam = data.assam;
      if (data.diceResult) payload.diceResult = data.diceResult;
      if (data.movePath) payload.movePath = data.movePath;
      if (data.phase) payload.phase = data.phase;
      if (data.tribute !== undefined) payload.tribute = data.tribute;
      if (data.players) payload.players = data.players;
      // Chess-specific fields
      if (data.chessMove) payload.chessMove = data.chessMove;
      if (data.fen) payload.fen = data.fen;
      if (data.isCheck !== undefined) payload.isCheck = data.isCheck;
      // Poker-specific fields
      if (data.pokerAction) payload.pokerAction = data.pokerAction;
      if (data.pokerStreet) payload.pokerStreet = data.pokerStreet;
      if (data.pokerPot != null) payload.pokerPot = data.pokerPot;
      if (data.pokerCommunityCards !== undefined) payload.pokerCommunityCards = data.pokerCommunityCards;
      if (data.pokerPlayerStacks) payload.pokerPlayerStacks = data.pokerPlayerStacks;
      if (data.pokerHandNumber != null) payload.pokerHandNumber = data.pokerHandNumber;
      if (data.pokerPlayers) payload.pokerPlayers = data.pokerPlayers;
      if (data.pokerShowdownResult !== undefined) payload.pokerShowdownResult = data.pokerShowdownResult;
      if (data.pokerHandResult) payload.pokerHandResult = data.pokerHandResult;
      // RPS-specific fields
      if (data.rpsRound != null) payload.rpsRound = data.rpsRound;
      if (data.rpsTotalRounds != null) payload.rpsTotalRounds = data.rpsTotalRounds;
      if (data.rpsPhase) payload.rpsPhase = data.rpsPhase;
      if (data.rpsScores) payload.rpsScores = data.rpsScores;
      if (data.rpsResult) payload.rpsResult = data.rpsResult;
      // UNO-specific fields
      if (data.unoAction) payload.unoAction = data.unoAction;
      if (data.unoPhase) payload.unoPhase = data.unoPhase;
      if (data.topCard) payload.topCard = data.topCard;
      if (data.currentColor) payload.currentColor = data.currentColor;
      if (data.currentTurn) payload.currentTurn = data.currentTurn;
      if (data.drawPileCount != null) payload.drawPileCount = data.drawPileCount;
      if (data.handCounts) payload.handCounts = data.handCounts;
      if (data.status) payload.status = data.status;
      if (data.winner !== undefined) payload.winner = data.winner;
      if (data.lastAction) payload.lastAction = data.lastAction;
      if (data.direction != null) payload.direction = data.direction;
      // Werewolf-specific
      if (data.werewolfAction) payload.werewolfAction = data.werewolfAction;
      if (data.werewolfPhase) payload.werewolfPhase = data.werewolfPhase;
      if (data.cycle != null) payload.cycle = data.cycle;
      if (data.activeSide !== undefined) payload.activeSide = data.activeSide;
      if (data.werewolfPlayers) payload.werewolfPlayers = data.werewolfPlayers;
      if (data.discussionLog) payload.discussionLog = data.discussionLog;
      if (data.deaths) payload.deaths = data.deaths;
      this.rooms.broadcast(data.matchId, { type: 'match:move', data: payload });
    };

    const onMatchTimeout = (data: MatchTimeoutEvent): void => {
      this.rooms.broadcast(data.matchId, {
        type: 'match:timeout',
        data: {
          matchId: data.matchId,
          side: data.side,
          timeoutCount: data.timeoutCount,
        },
      });
    };

    const onMatchEnded = (data: MatchEndedEvent): void => {
      this.rooms.broadcast(data.matchId, {
        type: 'match:end',
        data: {
          matchId: data.matchId,
          result: {
            winnerId: data.result.winnerId,
            reason: data.result.reason,
            finalScore: { a: data.result.finalScore.a, b: data.result.finalScore.b },
            totalMoves: data.result.totalMoves,
          },
        },
      });
      this.rooms.cleanup(data.matchId);
    };

    const onAgentThinking = (data: AgentThinkingEvent): void => {
      this.rooms.broadcast(data.matchId, {
        type: 'agent:thinking',
        data: {
          matchId: data.matchId,
          side: data.side,
          agentId: data.agentId,
          raw: data.raw,
          moveNumber: data.moveNumber,
        },
      });
    };

    const onMatchmakingCountdown = (data: MatchmakingCountdownEvent): void => {
      this.rooms.broadcastAll({
        type: 'matchmaking:countdown',
        data: {
          gameType: data.gameType,
          remainingMs: data.remainingMs,
          agents: data.agents,
        },
      });
    };

    const onMatchmakingMatched = (data: MatchmakingMatchedEvent): void => {
      this.rooms.broadcastAll({
        type: 'matchmaking:matched',
        data: {
          matchId: data.matchId,
          gameType: data.gameType,
          agents: data.agents,
        },
      });
    };

    const onMatchYourTurn = (data: MatchYourTurnEvent): void => {
      const ytPayload: Record<string, unknown> = {
        matchId: data.matchId,
        side: data.side,
        gameType: data.gameType,
        board: data.board,
        legalMoves: data.legalMoves,
        fen: data.fen,
        moveNumber: data.moveNumber,
        timeRemainingMs: data.timeRemainingMs,
        turnTimeoutMs: data.turnTimeoutMs,
      };
      // Poker-specific
      if (data.pokerHoleCards) ytPayload.pokerHoleCards = data.pokerHoleCards;
      if (data.pokerCommunityCards !== undefined) ytPayload.pokerCommunityCards = data.pokerCommunityCards;
      if (data.pokerPot != null) ytPayload.pokerPot = data.pokerPot;
      if (data.pokerPlayerStacks) ytPayload.pokerPlayerStacks = data.pokerPlayerStacks;
      if (data.pokerStreet) ytPayload.pokerStreet = data.pokerStreet;
      if (data.pokerHandNumber != null) ytPayload.pokerHandNumber = data.pokerHandNumber;
      if (data.pokerIsDealer != null) ytPayload.pokerIsDealer = data.pokerIsDealer;
      if (data.pokerActionHistory) ytPayload.pokerActionHistory = data.pokerActionHistory;
      // RPS-specific
      if (data.rpsRound != null) ytPayload.rpsRound = data.rpsRound;
      if (data.rpsTotalRounds != null) ytPayload.rpsTotalRounds = data.rpsTotalRounds;
      if (data.rpsPhase) ytPayload.rpsPhase = data.rpsPhase;
      if (data.rpsScores) ytPayload.rpsScores = data.rpsScores;
      // UNO-specific
      if (data.hand) ytPayload.hand = data.hand;
      if (data.legalActions) ytPayload.legalActions = data.legalActions;
      if (data.topCard) ytPayload.topCard = data.topCard;
      if (data.currentColor) ytPayload.currentColor = data.currentColor;
      if (data.currentTurn) ytPayload.currentTurn = data.currentTurn;
      if (data.drawPileCount != null) ytPayload.drawPileCount = data.drawPileCount;
      if (data.handCounts) ytPayload.handCounts = data.handCounts;
      if (data.opponentCardCount != null) ytPayload.opponentCardCount = data.opponentCardCount;
      // Werewolf-specific
      if (data.yourRole) ytPayload.yourRole = data.yourRole;
      if (data.yourDisplayName) ytPayload.yourDisplayName = data.yourDisplayName;
      if (data.knownWerewolves) ytPayload.knownWerewolves = data.knownWerewolves;
      if (data.seerMemory) ytPayload.seerMemory = data.seerMemory;
      if (data.werewolfPhase) ytPayload.werewolfPhase = data.werewolfPhase;
      if (data.cycle != null) ytPayload.cycle = data.cycle;
      if (data.activeSide !== undefined) ytPayload.activeSide = data.activeSide;
      if (data.werewolfPlayers) ytPayload.werewolfPlayers = data.werewolfPlayers;
      if (data.discussionLog) ytPayload.discussionLog = data.discussionLog;
      if (data.deaths) ytPayload.deaths = data.deaths;
      this.rooms.broadcast(data.matchId, { type: 'match:your_turn', data: ytPayload });
    };

    this.eventBus.on('match:started', onMatchStarted);
    this.eventBus.on('match:move', onMatchMove);
    this.eventBus.on('match:timeout', onMatchTimeout);
    this.eventBus.on('match:ended', onMatchEnded);
    this.eventBus.on('agent:thinking', onAgentThinking);
    this.eventBus.on('matchmaking:countdown', onMatchmakingCountdown);
    this.eventBus.on('matchmaking:matched', onMatchmakingMatched);
    this.eventBus.on('match:your_turn', onMatchYourTurn);

    this.handlers.set('match:started', onMatchStarted as (...args: unknown[]) => void);
    this.handlers.set('match:move', onMatchMove as (...args: unknown[]) => void);
    this.handlers.set('match:timeout', onMatchTimeout as (...args: unknown[]) => void);
    this.handlers.set('match:ended', onMatchEnded as (...args: unknown[]) => void);
    this.handlers.set('agent:thinking', onAgentThinking as (...args: unknown[]) => void);
    this.handlers.set('matchmaking:countdown', onMatchmakingCountdown as (...args: unknown[]) => void);
    this.handlers.set('matchmaking:matched', onMatchmakingMatched as (...args: unknown[]) => void);
    this.handlers.set('match:your_turn', onMatchYourTurn as (...args: unknown[]) => void);

    this.logger.log('Broadcaster started');
  }

  stop(): void {
    for (const [event, handler] of this.handlers) {
      this.eventBus.removeListener(event, handler);
    }
    this.handlers.clear();
    this.logger.log('Broadcaster stopped');
  }
}
