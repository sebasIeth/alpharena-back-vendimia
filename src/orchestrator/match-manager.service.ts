import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  GameState, Side, Board, Piece, PlayerColor,
  MarrakechGameState, ChessState, ChessUciMove,
  PokerGameState,
} from '../common/types';
import {
  MAX_TIMEOUTS, MATCH_DURATION_MS, TURN_TIMEOUT_MS,
  POKER_SMALL_BLIND, POKER_BIG_BLIND, getPokerMaxHands,
} from '../common/constants/game.constants';
import { Match, Agent } from '../database/schemas';
import { decrypt } from '../common/crypto.util';
import { GameEngineService } from '../game-engine/game-engine.service';
import { ChessEngine } from '../game-engine/chess';

import { ActiveMatchesService, ActiveMatchState } from './active-matches.service';
import { TurnControllerService } from './turn-controller.service';
import { MarrakechTurnControllerService } from './marrakech-turn-controller.service';
import { ChessTurnControllerService } from './chess-turn-controller.service';
import { PokerTurnControllerService } from './poker-turn-controller.service';
import { RpsTurnControllerService } from './rps-turn-controller.service';
import { createRpsInitialState, RpsGameState } from './rps-turn-controller.service';
import { createInitialState as createPokerInitialState, isMatchOver as isPokerMatchOver } from '../game-engine/poker';
import { ResultHandlerService } from './result-handler.service';
import { EventBusService } from './event-bus.service';
import { SettlementRouterService } from '../settlement/settlement-router.service';
import { MatchClock } from './match-clock';

export interface MatchAgentInput {
  agentId: string;
  userId: string;
  name: string;
  endpointUrl: string;
  eloRating: number;
  type?: string;
  chain?: string;
  token?: string;
  openclawUrl?: string;
  openclawToken?: string;
  openclawAgentId?: string;
}

/** Returns side letter for a given index: 0->'a', 1->'b', 2->'c', ... */
function sideLetterFromIndex(index: number): string {
  return String.fromCharCode(97 + index); // 97 = 'a'
}

@Injectable()
export class MatchManagerService {
  private readonly logger = new Logger(MatchManagerService.name);
  private readonly endedMatches = new Set<string>();
  private readonly marrakechStates = new Map<string, MarrakechGameState>();
  private readonly chessEngines = new Map<string, ChessEngine>();
  private readonly chessMoveHistories = new Map<string, ChessUciMove[]>();
  private readonly pokerStates = new Map<string, PokerGameState>();
  private readonly rpsStates = new Map<string, RpsGameState>();
  private readonly matchGameTypes = new Map<string, string>();

  constructor(
    @InjectModel(Match.name) private readonly matchModel: Model<Match>,
    @InjectModel(Agent.name) private readonly agentModel: Model<Agent>,
    private readonly activeMatches: ActiveMatchesService,
    private readonly turnController: TurnControllerService,
    private readonly marrakechTurnController: MarrakechTurnControllerService,
    private readonly chessTurnController: ChessTurnControllerService,
    private readonly pokerTurnController: PokerTurnControllerService,
    private readonly rpsTurnController: RpsTurnControllerService,
    private readonly resultHandler: ResultHandlerService,
    private readonly eventBus: EventBusService,
    private readonly settlementRouter: SettlementRouterService,
    private readonly gameEngine: GameEngineService,
  ) {}

  getChessMoveHistory(matchId: string): ChessUciMove[] | undefined {
    return this.chessMoveHistories.get(matchId);
  }

  /**
   * Create a match with exactly two agents (backwards-compatible).
   * Delegates to createMatchMulti internally.
   */
  async createMatch(
    agentA: MatchAgentInput,
    agentB: MatchAgentInput,
    stakeAmount: number,
    gameType: string = 'chess',
    existingMatchId?: string,
  ): Promise<string> {
    return this.createMatchMulti([agentA, agentB], stakeAmount, gameType, existingMatchId);
  }

  /**
   * Create a match with N agents.
   * For 2-player games (chess, reversi) exactly 2 agents are required.
   * For poker, 2+ agents are accepted.
   */
  async createMatchMulti(
    agents: MatchAgentInput[],
    stakeAmount: number,
    gameType: string = 'chess',
    existingMatchId?: string,
  ): Promise<string> {
    if (agents.length < 2) {
      throw new Error('At least 2 agents are required to create a match');
    }

    if (stakeAmount === undefined || stakeAmount === null || stakeAmount < 0) {
      throw new Error('stakeAmount is required and must be >= 0');
    }

    // Validate all agents are on the same chain
    const matchChain = agents[0].chain || 'base';
    const mismatch = agents.find((a) => (a.chain || 'base') !== matchChain);
    if (mismatch) {
      throw new Error(
        `Chain mismatch: agent "${mismatch.name}" is on "${mismatch.chain}" but match is on "${matchChain}"`,
      );
    }

    const agentIds = agents.map((a) => a.agentId).join(', ');
    this.logger.log(`Creating match: [${agentIds}], gameType=${gameType}, stake=${stakeAmount}${existingMatchId ? ` (reusing ${existingMatchId})` : ''}`);

    const potAmount = stakeAmount * agents.length;

    // 2-player games require exactly 2 agents
    if (gameType === 'chess' || gameType === 'marrakech' || gameType === 'reversi' || gameType === 'rps') {
      if (agents.length !== 2) {
        throw new Error(`Game type "${gameType}" requires exactly 2 agents, got ${agents.length}`);
      }
    }

    if (gameType === 'marrakech') {
      return this.createMarrakechMatch(agents[0], agents[1], stakeAmount, potAmount, existingMatchId);
    }

    if (gameType === 'chess') {
      return this.createChessMatch(agents[0], agents[1], stakeAmount, potAmount, existingMatchId);
    }

    if (gameType === 'rps') {
      return this.createRpsMatch(agents[0], agents[1], stakeAmount, potAmount, existingMatchId);
    }

    if (gameType === 'poker') {
      return this.createPokerMatch(agents, stakeAmount, potAmount, existingMatchId);
    }

    return this.createReversiMatch(agents[0], agents[1], stakeAmount, potAmount, gameType, existingMatchId);
  }

  private async createReversiMatch(
    agentA: MatchAgentInput,
    agentB: MatchAgentInput,
    stakeAmount: number,
    potAmount: number,
    gameType: string,
    existingMatchId?: string,
  ): Promise<string> {
    const initialState = this.gameEngine.createInitialState();
    const initialBoard = initialState.board;

    const matchData = {
      gameType,
      chain: agentA.chain || 'solana',
      token: agentA.token || 'USDC',
      agents: {
        a: { agentId: agentA.agentId, userId: agentA.userId, name: agentA.name, eloAtStart: agentA.eloRating },
        b: { agentId: agentB.agentId, userId: agentB.userId, name: agentB.name, eloAtStart: agentB.eloRating },
      },
      stakeAmount, potAmount, status: 'starting',
      currentBoard: initialBoard, currentTurn: 'a', moveCount: 0,
      timeouts: { a: 0, b: 0 }, txHashes: { escrow: null, payout: null },
    };

    let matchId: string;
    if (existingMatchId) {
      await this.matchModel.findByIdAndUpdate(existingMatchId, { $set: matchData });
      matchId = existingMatchId;
    } else {
      const matchDoc = await this.matchModel.create(matchData);
      matchId = matchDoc._id.toString();
    }

    const matchState: ActiveMatchState = {
      matchId, gameState: initialState, clock: null, turnDeadline: 0,
      timeouts: { a: 0, b: 0 }, status: 'starting',
      agents: {
        a: { agentId: agentA.agentId, endpointUrl: agentA.endpointUrl, piece: 'B', type: agentA.type, openclawUrl: agentA.openclawUrl, openclawToken: agentA.openclawToken, openclawAgentId: agentA.openclawAgentId },
        b: { agentId: agentB.agentId, endpointUrl: agentB.endpointUrl, piece: 'W', type: agentB.type, openclawUrl: agentB.openclawUrl, openclawToken: agentB.openclawToken, openclawAgentId: agentB.openclawAgentId },
      },
      startedAt: Date.now(),
    };

    this.activeMatches.addMatch(matchState);
    this.matchGameTypes.set(matchId, gameType);

    await Promise.all([
      this.agentModel.updateOne({ _id: agentA.agentId }, { status: 'in_match' }),
      this.agentModel.updateOne({ _id: agentB.agentId }, { status: 'in_match' }),
    ]);

    this.eventBus.emit('match:created', {
      matchId,
      agents: {
        a: { agentId: agentA.agentId, name: agentA.name },
        b: { agentId: agentB.agentId, name: agentB.name },
      },
      gameType, stakeAmount,
    });

    this.logger.log(`Reversi match ${matchId} created`);
    return matchId;
  }

  private async createMarrakechMatch(
    agentA: MatchAgentInput,
    agentB: MatchAgentInput,
    stakeAmount: number,
    potAmount: number,
    existingMatchId?: string,
  ): Promise<string> {
    const marrakech = this.gameEngine.getMarrakechEngine();
    const mkState = marrakech.createInitialState(2, [agentA.name, agentB.name]);

    const initialBoard = mkState.board.map((row) =>
      row.map((cell) => (cell ? cell.playerId + 1 : 0) as Piece),
    ) as Board;

    const matchData = {
      gameType: 'marrakech',
      chain: agentA.chain || 'solana',
      token: agentA.token || 'USDC',
      agents: {
        a: { agentId: agentA.agentId, userId: agentA.userId, name: agentA.name, eloAtStart: agentA.eloRating },
        b: { agentId: agentB.agentId, userId: agentB.userId, name: agentB.name, eloAtStart: agentB.eloRating },
      },
      stakeAmount, potAmount, status: 'starting',
      currentBoard: initialBoard, currentTurn: 'a', moveCount: 0,
      timeouts: { a: 0, b: 0 }, txHashes: { escrow: null, payout: null },
    };

    let matchId: string;
    if (existingMatchId) {
      await this.matchModel.findByIdAndUpdate(existingMatchId, { $set: matchData });
      matchId = existingMatchId;
    } else {
      const matchDoc = await this.matchModel.create(matchData);
      matchId = matchDoc._id.toString();
    }

    const compatState: GameState = {
      board: initialBoard, currentPlayer: 'B', moveNumber: 0,
      scores: { black: mkState.players[0].dirhams, white: mkState.players[1].dirhams },
      gameOver: false, winner: null,
    };

    const matchState: ActiveMatchState = {
      matchId, gameState: compatState, clock: null, turnDeadline: 0,
      timeouts: { a: 0, b: 0 }, status: 'starting',
      agents: {
        a: { agentId: agentA.agentId, endpointUrl: agentA.endpointUrl, piece: 'B', type: agentA.type, openclawUrl: agentA.openclawUrl, openclawToken: agentA.openclawToken, openclawAgentId: agentA.openclawAgentId },
        b: { agentId: agentB.agentId, endpointUrl: agentB.endpointUrl, piece: 'W', type: agentB.type, openclawUrl: agentB.openclawUrl, openclawToken: agentB.openclawToken, openclawAgentId: agentB.openclawAgentId },
      },
      startedAt: Date.now(),
    };

    this.activeMatches.addMatch(matchState);
    this.marrakechStates.set(matchId, mkState);
    this.matchGameTypes.set(matchId, 'marrakech');

    await Promise.all([
      this.agentModel.updateOne({ _id: agentA.agentId }, { status: 'in_match' }),
      this.agentModel.updateOne({ _id: agentB.agentId }, { status: 'in_match' }),
    ]);

    this.eventBus.emit('match:created', {
      matchId,
      agents: {
        a: { agentId: agentA.agentId, name: agentA.name },
        b: { agentId: agentB.agentId, name: agentB.name },
      },
      gameType: 'marrakech', stakeAmount,
    });

    this.logger.log(`Marrakech match ${matchId} created`);
    return matchId;
  }

  private async createChessMatch(
    agentA: MatchAgentInput,
    agentB: MatchAgentInput,
    stakeAmount: number,
    potAmount: number,
    existingMatchId?: string,
  ): Promise<string> {
    const chessEngine = this.gameEngine.createChessEngine();
    const initialBoard = chessEngine.getBoard();

    const matchData = {
      gameType: 'chess',
      chain: agentA.chain || 'solana',
      token: agentA.token || 'USDC',
      agents: {
        a: { agentId: agentA.agentId, userId: agentA.userId, name: agentA.name, eloAtStart: agentA.eloRating },
        b: { agentId: agentB.agentId, userId: agentB.userId, name: agentB.name, eloAtStart: agentB.eloRating },
      },
      stakeAmount, potAmount, status: 'starting',
      currentBoard: initialBoard, currentTurn: 'a', moveCount: 0,
      timeouts: { a: 0, b: 0 }, txHashes: { escrow: null, payout: null },
      chessState: { fen: chessEngine.getFen(), moveHistory: [], pgn: '' },
    };

    let matchId: string;
    if (existingMatchId) {
      await this.matchModel.findByIdAndUpdate(existingMatchId, { $set: matchData });
      matchId = existingMatchId;
    } else {
      const matchDoc = await this.matchModel.create(matchData);
      matchId = matchDoc._id.toString();
    }

    // Side 'a' = White (first mover), Side 'b' = Black
    const compatState: GameState = {
      board: initialBoard as unknown as Board, currentPlayer: 'B', moveNumber: 0,
      scores: { black: 0, white: 0 },
      gameOver: false, winner: null,
    };

    const matchState: ActiveMatchState = {
      matchId, gameState: compatState, clock: null, turnDeadline: 0,
      timeouts: { a: 0, b: 0 }, status: 'starting',
      agents: {
        a: { agentId: agentA.agentId, endpointUrl: agentA.endpointUrl, piece: 'B', type: agentA.type, openclawUrl: agentA.openclawUrl, openclawToken: agentA.openclawToken, openclawAgentId: agentA.openclawAgentId },
        b: { agentId: agentB.agentId, endpointUrl: agentB.endpointUrl, piece: 'W', type: agentB.type, openclawUrl: agentB.openclawUrl, openclawToken: agentB.openclawToken, openclawAgentId: agentB.openclawAgentId },
      },
      startedAt: Date.now(),
    };

    this.activeMatches.addMatch(matchState);
    this.chessEngines.set(matchId, chessEngine);
    this.chessMoveHistories.set(matchId, []);
    this.matchGameTypes.set(matchId, 'chess');

    await Promise.all([
      this.agentModel.updateOne({ _id: agentA.agentId }, { status: 'in_match' }),
      this.agentModel.updateOne({ _id: agentB.agentId }, { status: 'in_match' }),
    ]);

    this.eventBus.emit('match:created', {
      matchId,
      agents: {
        a: { agentId: agentA.agentId, name: agentA.name },
        b: { agentId: agentB.agentId, name: agentB.name },
      },
      gameType: 'chess', stakeAmount,
    });

    this.logger.log(`Chess match ${matchId} created`);
    return matchId;
  }

  private async createRpsMatch(
    agentA: MatchAgentInput, agentB: MatchAgentInput,
    stakeAmount: number, potAmount: number, existingMatchId?: string,
  ): Promise<string> {
    const rpsState = createRpsInitialState();
    const matchData = {
      gameType: 'rps', chain: agentA.chain || 'solana', token: agentA.token || 'USDC',
      agents: {
        a: { agentId: agentA.agentId, userId: agentA.userId, name: agentA.name, eloAtStart: agentA.eloRating },
        b: { agentId: agentB.agentId, userId: agentB.userId, name: agentB.name, eloAtStart: agentB.eloRating },
      },
      stakeAmount, potAmount, status: 'starting',
      currentBoard: [], currentTurn: 'a', moveCount: 0,
      timeouts: { a: 0, b: 0 }, txHashes: { escrow: null, payout: null }, rpsState,
    };
    let matchId: string;
    if (existingMatchId) {
      await this.matchModel.findByIdAndUpdate(existingMatchId, { $set: matchData });
      matchId = existingMatchId;
    } else {
      const matchDoc = await this.matchModel.create(matchData);
      matchId = matchDoc._id.toString();
    }
    const compatState: GameState = {
      board: [] as unknown as Board, currentPlayer: 'B', moveNumber: 0,
      scores: { black: 0, white: 0 }, gameOver: false, winner: null,
    };
    const matchState: ActiveMatchState = {
      matchId, gameState: compatState, clock: null, turnDeadline: 0,
      timeouts: { a: 0, b: 0 }, status: 'starting',
      agents: {
        a: { agentId: agentA.agentId, endpointUrl: agentA.endpointUrl, piece: 'B', type: agentA.type, openclawUrl: agentA.openclawUrl, openclawToken: agentA.openclawToken, openclawAgentId: agentA.openclawAgentId },
        b: { agentId: agentB.agentId, endpointUrl: agentB.endpointUrl, piece: 'W', type: agentB.type, openclawUrl: agentB.openclawUrl, openclawToken: agentB.openclawToken, openclawAgentId: agentB.openclawAgentId },
      },
      startedAt: Date.now(),
    };
    this.activeMatches.addMatch(matchState);
    this.rpsStates.set(matchId, rpsState);
    this.matchGameTypes.set(matchId, 'rps');
    await Promise.all([
      this.agentModel.updateOne({ _id: agentA.agentId }, { status: 'in_match' }),
      this.agentModel.updateOne({ _id: agentB.agentId }, { status: 'in_match' }),
    ]);
    this.eventBus.emit('match:created', {
      matchId, agents: {
        a: { agentId: agentA.agentId, name: agentA.name },
        b: { agentId: agentB.agentId, name: agentB.name },
      }, gameType: 'rps', stakeAmount,
    });
    this.logger.log(`RPS match ${matchId} created`);
    return matchId;
  }

  private async createPokerMatch(
    agents: MatchAgentInput[],
    stakeAmount: number,
    potAmount: number,
    existingMatchId?: string,
  ): Promise<string> {
    // Starting stack = 100 big blinds
    const startingStack = POKER_BIG_BLIND * 100;
    const pokerState = createPokerInitialState(startingStack, POKER_SMALL_BLIND, POKER_BIG_BLIND, agents.length);

    // Build agents Record keyed by side letter ('a', 'b', 'c', ...)
    const matchAgents: Record<string, { agentId: string; userId: string; name: string; eloAtStart: number }> = {};
    const timeouts: Record<string, number> = {};
    const activeAgents: Record<string, { agentId: string; endpointUrl: string; piece: PlayerColor; type?: string; openclawUrl?: string; openclawToken?: string; openclawAgentId?: string }> = {};
    const eventAgents: Record<string, { agentId: string; name: string }> = {};

    const pieceColors: PlayerColor[] = ['B', 'W'];
    agents.forEach((agent, i) => {
      const side = sideLetterFromIndex(i);
      matchAgents[side] = { agentId: agent.agentId, userId: agent.userId, name: agent.name, eloAtStart: agent.eloRating };
      timeouts[side] = 0;
      activeAgents[side] = {
        agentId: agent.agentId, endpointUrl: agent.endpointUrl,
        piece: pieceColors[i % pieceColors.length],
        type: agent.type, openclawUrl: agent.openclawUrl,
        openclawToken: agent.openclawToken, openclawAgentId: agent.openclawAgentId,
      };
      eventAgents[side] = { agentId: agent.agentId, name: agent.name };
    });

    const matchData = {
      gameType: 'poker',
      chain: agents[0].chain || 'solana',
      token: agents[0].token || 'USDC',
      agents: matchAgents,
      stakeAmount, potAmount, status: 'starting',
      currentBoard: [], currentTurn: 'a', moveCount: 0,
      timeouts, txHashes: { escrow: null, payout: null },
      pokerState: { ...pokerState, deck: [] },
    };

    let matchId: string;
    if (existingMatchId) {
      await this.matchModel.findByIdAndUpdate(existingMatchId, { $set: matchData });
      matchId = existingMatchId;
    } else {
      const matchDoc = await this.matchModel.create(matchData);
      matchId = matchDoc._id.toString();
    }

    const compatState: GameState = {
      board: [] as unknown as Board, currentPlayer: 'B', moveNumber: 0,
      scores: { black: startingStack, white: startingStack },
      gameOver: false, winner: null,
    };

    const matchState: ActiveMatchState = {
      matchId, gameState: compatState, clock: null, turnDeadline: 0,
      timeouts, status: 'starting',
      agents: activeAgents,
      startedAt: Date.now(),
    };

    this.activeMatches.addMatch(matchState);
    this.pokerStates.set(matchId, pokerState);
    this.matchGameTypes.set(matchId, 'poker');

    await Promise.all(
      agents.map((agent) => this.agentModel.updateOne({ _id: agent.agentId }, { status: 'in_match' })),
    );

    this.eventBus.emit('match:created', {
      matchId,
      agents: eventAgents,
      gameType: 'poker', stakeAmount,
    });

    this.logger.log(`Poker match ${matchId} created with ${agents.length} agents`);
    return matchId;
  }

  async startMatch(matchId: string): Promise<void> {
    const matchState = this.activeMatches.getMatch(matchId);
    if (!matchState) throw new Error(`Cannot start match ${matchId}: not found.`);
    if (matchState.status !== 'starting') {
      throw new Error(`Cannot start match ${matchId}: status is "${matchState.status}".`);
    }

    const gameType = this.matchGameTypes.get(matchId) ?? 'chess';
    this.logger.log(`Starting match ${matchId} (${gameType})`);

    // Fetch match doc for potAmount and user IDs
    const matchDoc = await this.matchModel.findById(matchId);
    if (!matchDoc) {
      throw new Error(`Match document ${matchId} not found in DB.`);
    }

    // Resolve wallet addresses from agent docs (agent-owned wallets)
    const agentEntries = Object.entries(matchState.agents);
    const agentDocs = await Promise.all(
      agentEntries.map(([, agentInfo]) =>
        this.agentModel.findById(agentInfo.agentId).select('+walletPrivateKey'),
      ),
    );

    // Build a map of side -> agentDoc for easy lookup
    const agentDocsBySide: Record<string, typeof agentDocs[0]> = {};
    const agentIdsBySide: Record<string, string> = {};
    for (let i = 0; i < agentEntries.length; i++) {
      const [side] = agentEntries[i];
      agentDocsBySide[side] = agentDocs[i];
      agentIdsBySide[side] = agentEntries[i][1].agentId;
    }

    // Check all wallets are present (only required when stakeAmount > 0)
    const stakeAmount = matchDoc.stakeAmount ?? 0;
    if (stakeAmount > 0) {
      const missingWallets = agentEntries.filter((_, i) => !agentDocs[i]?.walletAddress);
      if (missingWallets.length > 0) {
        const missing = missingWallets.map(([side]) => side.toUpperCase()).join(', ');
        this.logger.error(`Missing agent wallet for match ${matchId}: ${missing}`);
        await this.matchModel.updateOne({ _id: matchId }, { status: 'cancelled' });
        await Promise.all(
          agentEntries.map(([, agentInfo]) => this.agentModel.updateOne({ _id: agentInfo.agentId }, { status: 'idle' })),
        );
        this.eventBus.emit('match:error', { matchId, agentIds: agentIdsBySide, error: 'Missing wallet address for agent' });
        this.activeMatches.removeMatch(matchId);
        this.marrakechStates.delete(matchId);
        this.matchGameTypes.delete(matchId);
        return;
      }
    }

    // Store agent wallet addresses in active match state for settlement
    const updatedAgents: Record<string, any> = {};
    for (const [side, agentInfo] of agentEntries) {
      updatedAgents[side] = { ...agentInfo, walletAddress: agentDocsBySide[side]?.walletAddress };
    }
    this.activeMatches.updateMatch(matchId, { agents: updatedAgents });

    // Transfer stake from each agent wallet to platform, then escrow
    // Skip on-chain settlement for zero-stake matches
    const matchChain = matchDoc.chain || 'solana';
    const matchToken = matchDoc.token || 'USDC';
    if (matchDoc.stakeAmount > 0) {
      const tokenDecimals = this.settlementRouter.getTokenDecimals(matchChain, matchToken);
      const stakeAmountToken = BigInt(matchDoc.stakeAmount) * BigInt(10 ** tokenDecimals);
      const escrowAmount = BigInt(matchDoc.potAmount) * BigInt(10 ** tokenDecimals);
      const platformWallet = this.settlementRouter.getPlatformWalletAddress(matchChain);

      if (!platformWallet) {
        this.logger.error(`Platform wallet not available for match ${matchId} (chain=${matchChain})`);
        await this.matchModel.updateOne({ _id: matchId }, { status: 'cancelled' });
        await Promise.all(
          agentEntries.map(([, agentInfo]) => this.agentModel.updateOne({ _id: agentInfo.agentId }, { status: 'idle' })),
        );
        this.eventBus.emit('match:error', { matchId, agentIds: agentIdsBySide, error: 'Platform wallet not configured' });
        this.activeMatches.removeMatch(matchId);
        this.marrakechStates.delete(matchId);
        this.matchGameTypes.delete(matchId);
        return;
      }

      try {
        const transferTxHashes: string[] = [];

        if (matchToken === 'USDC') {
          // USDC: already paid via x402 — funds are in platform wallet
          this.logger.log(`USDC match ${matchId}: stake collected via x402`);
        } else {
          // ALPHA: transfer from each agent wallet to platform
          // Non-custodial agents (walletPrivateKey = null) already pre-paid via x402
          const agentPrivKeys: Record<string, string | null> = {};
          for (const [side] of agentEntries) {
            const doc = agentDocsBySide[side]!;
            const privKey = doc.walletPrivateKey ? decrypt(doc.walletPrivateKey) : null;
            agentPrivKeys[side] = privKey;
          }

          for (const [side] of agentEntries) {
            if (!agentPrivKeys[side]) {
              // Non-custodial agent: stake was pre-paid via x402
              this.logger.log(`ALPHA match ${matchId}: side ${side} pre-paid via x402 (external wallet)`);
              continue;
            }
            const txHash = await this.settlementRouter.transferTokenFromAgent(matchChain, agentPrivKeys[side]!, platformWallet, stakeAmountToken, matchToken);
            if (txHash) transferTxHashes.push(txHash);
          }
        }

        // Escrow via smart contract (EVM) or implicit (Solana — transfers already done)
        const walletA = agentDocsBySide['a']!.walletAddress;
        const walletB = agentDocsBySide['b']!.walletAddress;
        const escrowTxHash = await this.settlementRouter.escrow(
          matchChain, matchId, walletA, walletB, escrowAmount,
        );
        // Store all escrow tx hashes (agent transfers + contract escrow if EVM)
        const allEscrowHashes = [...transferTxHashes];
        if (escrowTxHash) allEscrowHashes.push(escrowTxHash);
        await this.matchModel.updateOne({ _id: matchId }, { 'txHashes.escrow': allEscrowHashes });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Escrow failed for match ${matchId}: ${message}`);
        await this.matchModel.updateOne({ _id: matchId }, { status: 'cancelled' });
        await Promise.all(
          agentEntries.map(([, agentInfo]) => this.agentModel.updateOne({ _id: agentInfo.agentId }, { status: 'idle' })),
        );
        this.eventBus.emit('match:error', { matchId, agentIds: agentIdsBySide, error: `Escrow failed: ${message}` });
        this.activeMatches.removeMatch(matchId);
        this.marrakechStates.delete(matchId);
        this.matchGameTypes.delete(matchId);
        return;
      }
    } else {
      this.logger.log(`Skipping escrow for zero-stake match ${matchId}`);
    }

    const clock = new MatchClock(matchId, {
      onMatchTimeout: (mId: string) => this.handleMatchTimeout(mId),
      onTurnTimeout: (mId: string) => {
        this.logger.warn(`Turn timeout callback for ${mId}`);
      },
    });

    this.activeMatches.updateMatch(matchId, { status: 'active', clock, startedAt: Date.now() });
    await this.matchModel.updateOne({ _id: matchId }, { status: 'active', startedAt: new Date() });
    clock.startMatch();

    const mkStartState = this.marrakechStates.get(matchId);
    const startedPayload: any = { matchId, gameType, board: matchState.gameState.board };
    if (gameType === 'marrakech' && mkStartState) {
      startedPayload.assam = {
        position: { row: mkStartState.assam.position.row, col: mkStartState.assam.position.col },
        direction: mkStartState.assam.direction,
      };
      startedPayload.players = mkStartState.players.map((p) => ({
        id: p.id, name: p.name, dirhams: p.dirhams, carpetsRemaining: p.carpetsRemaining,
      }));
    }
    if (gameType === 'chess') {
      const chessEng = this.chessEngines.get(matchId);
      if (chessEng) startedPayload.fen = chessEng.getFen();
    }
    if (gameType === 'poker') {
      const pkState = this.pokerStates.get(matchId);
      if (pkState) {
        const pokerPlayerStacks: Record<string, number> = {};
        for (const side of Object.keys(matchState.agents)) {
          pokerPlayerStacks[side] = pkState.startingStack;
        }
        startedPayload.pokerPlayerStacks = pokerPlayerStacks;
        startedPayload.pokerHandNumber = 0;
      }
    }
    if (gameType === 'rps') {
      const rpsSt = this.rpsStates.get(matchId);
      if (rpsSt) {
        startedPayload.rpsTotalRounds = rpsSt.bestOf;
        startedPayload.rpsRound = 1;
        startedPayload.rpsPhase = 'waiting_moves';
        startedPayload.rpsScores = { a: 0, b: 0 };
      }
    }
    this.eventBus.emit('match:started', startedPayload);

    // Give human players time to reconnect their sockets before starting the game loop
    const hasHumanPlayer = Object.values(matchState.agents).some((a: any) => a.type === 'human');
    const startDelay = hasHumanPlayer ? 3000 : 0;

    let loopFn: Promise<void>;
    if (gameType === 'marrakech') {
      loopFn = startDelay > 0
        ? new Promise<void>(r => setTimeout(r, startDelay)).then(() => this.runMarrakechGameLoop(matchId))
        : this.runMarrakechGameLoop(matchId);
    } else if (gameType === 'chess') {
      loopFn = startDelay > 0
        ? new Promise<void>(r => setTimeout(r, startDelay)).then(() => this.runChessGameLoop(matchId))
        : this.runChessGameLoop(matchId);
    } else if (gameType === 'poker') {
      loopFn = startDelay > 0
        ? new Promise<void>(r => setTimeout(r, startDelay)).then(() => this.runPokerGameLoop(matchId))
        : this.runPokerGameLoop(matchId);
    } else if (gameType === 'rps') {
      loopFn = startDelay > 0
        ? new Promise<void>(r => setTimeout(r, startDelay)).then(() => this.runRpsGameLoop(matchId))
        : this.runRpsGameLoop(matchId);
    } else {
      loopFn = startDelay > 0
        ? new Promise<void>(r => setTimeout(r, startDelay)).then(() => this.runGameLoop(matchId))
        : this.runGameLoop(matchId);
    }

    loopFn.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Game loop failed for ${matchId}: ${message}`);
      this.endMatchWithError(matchId, message);
    });
  }

  private async runGameLoop(matchId: string): Promise<void> {
    while (true) {
      const matchState = this.activeMatches.getMatch(matchId);
      if (!matchState || matchState.status !== 'active') return;
      if (this.gameEngine.isGameOver(matchState.gameState)) {
        const reason = matchState.gameState.winner === 'draw' ? 'draw' : 'score';
        await this.endMatch(matchId, reason);
        return;
      }
      if (matchState.timeouts.a >= MAX_TIMEOUTS) { await this.endMatch(matchId, 'timeout', 'b'); return; }
      if (matchState.timeouts.b >= MAX_TIMEOUTS) { await this.endMatch(matchId, 'timeout', 'a'); return; }

      await this.matchModel.updateOne({ _id: matchId }, { turnStartedAt: new Date() }).catch(() => {});
      const turnResult = await this.turnController.executeTurn(matchState);
      const updatedState = this.activeMatches.getMatch(matchId);
      if (!updatedState) return;

      if (turnResult.gameOver) {
        const reason = turnResult.gameState.winner === 'draw' ? 'draw' : 'score';
        await this.endMatch(matchId, reason);
        return;
      }
      if (updatedState.timeouts.a >= MAX_TIMEOUTS) { await this.endMatch(matchId, 'timeout', 'b'); return; }
      if (updatedState.timeouts.b >= MAX_TIMEOUTS) { await this.endMatch(matchId, 'timeout', 'a'); return; }

      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  private async runMarrakechGameLoop(matchId: string): Promise<void> {
    const marrakech = this.gameEngine.getMarrakechEngine();

    while (true) {
      const matchState = this.activeMatches.getMatch(matchId);
      if (!matchState || matchState.status !== 'active') return;

      let mkState = this.marrakechStates.get(matchId);
      if (!mkState) {
        await this.endMatchWithError(matchId, 'Marrakech state lost');
        return;
      }

      if (mkState.gameOver) {
        let winningSide: Side | undefined;
        if (mkState.winner === 0) winningSide = 'a';
        else if (mkState.winner === 1) winningSide = 'b';
        this.activeMatches.updateMatch(matchId, {
          gameState: {
            ...matchState.gameState,
            scores: { black: mkState.players[0]?.dirhams ?? 0, white: mkState.players[1]?.dirhams ?? 0 },
            gameOver: true,
            winner: winningSide === 'a' ? 'B' : winningSide === 'b' ? 'W' : 'draw',
          },
        });
        await this.endMatch(matchId, 'score', winningSide);
        return;
      }

      if (matchState.timeouts.a >= MAX_TIMEOUTS) { await this.endMatch(matchId, 'timeout', 'b'); return; }
      if (matchState.timeouts.b >= MAX_TIMEOUTS) { await this.endMatch(matchId, 'timeout', 'a'); return; }

      await this.matchModel.updateOne({ _id: matchId }, { turnStartedAt: new Date() }).catch(() => {});
      const turnResult = await this.marrakechTurnController.executeTurn(matchState, mkState);
      this.marrakechStates.set(matchId, turnResult.gameState);

      this.activeMatches.updateMatch(matchId, {
        gameState: {
          ...matchState.gameState,
          scores: { black: turnResult.gameState.players[0]?.dirhams ?? 0, white: turnResult.gameState.players[1]?.dirhams ?? 0 },
          moveNumber: turnResult.gameState.turnNumber,
          gameOver: turnResult.gameState.gameOver,
          winner: turnResult.gameState.winner === 0 ? 'B' : turnResult.gameState.winner === 1 ? 'W' : turnResult.gameState.gameOver ? 'draw' : null,
        },
      });

      const updated = this.activeMatches.getMatch(matchId);
      if (!updated) return;

      if (turnResult.gameOver) {
        let winningSide: Side | undefined;
        if (turnResult.gameState.winner === 0) winningSide = 'a';
        else if (turnResult.gameState.winner === 1) winningSide = 'b';
        await this.endMatch(matchId, 'score', winningSide);
        return;
      }

      if (updated.timeouts.a >= MAX_TIMEOUTS) { await this.endMatch(matchId, 'timeout', 'b'); return; }
      if (updated.timeouts.b >= MAX_TIMEOUTS) { await this.endMatch(matchId, 'timeout', 'a'); return; }

      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  private async runChessGameLoop(matchId: string): Promise<void> {
    while (true) {
      const matchState = this.activeMatches.getMatch(matchId);
      if (!matchState || matchState.status !== 'active') return;

      const chessEngine = this.chessEngines.get(matchId);
      if (!chessEngine) {
        await this.endMatchWithError(matchId, 'Chess engine state lost');
        return;
      }

      const moveHistory = this.chessMoveHistories.get(matchId) ?? [];

      if (chessEngine.isGameOver()) {
        const winner = chessEngine.getWinner();
        let winningSide: Side | undefined;
        if (winner === 'white') winningSide = 'a';
        else if (winner === 'black') winningSide = 'b';
        const reason = chessEngine.isDraw() ? 'draw' : 'score';
        await this.endMatch(matchId, reason, winningSide);
        return;
      }

      if (matchState.timeouts.a >= MAX_TIMEOUTS) { await this.endMatch(matchId, 'timeout', 'b'); return; }
      if (matchState.timeouts.b >= MAX_TIMEOUTS) { await this.endMatch(matchId, 'timeout', 'a'); return; }

      await this.matchModel.updateOne({ _id: matchId }, { turnStartedAt: new Date() }).catch(() => {});
      const turnResult = await this.chessTurnController.executeTurn(matchState, chessEngine, moveHistory);

      const updated = this.activeMatches.getMatch(matchId);
      if (!updated) return;

      if (turnResult.gameOver) {
        let winningSide: Side | undefined;
        if (turnResult.winner === 'white') winningSide = 'a';
        else if (turnResult.winner === 'black') winningSide = 'b';
        const reason = turnResult.winner === 'draw' ? 'draw' : 'score';
        await this.endMatch(matchId, reason, winningSide);
        return;
      }

      if (updated.timeouts.a >= MAX_TIMEOUTS) { await this.endMatch(matchId, 'timeout', 'b'); return; }
      if (updated.timeouts.b >= MAX_TIMEOUTS) { await this.endMatch(matchId, 'timeout', 'a'); return; }

      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  private async runPokerGameLoop(matchId: string): Promise<void> {
    while (true) {
      const matchState = this.activeMatches.getMatch(matchId);
      if (!matchState || matchState.status !== 'active') return;

      let pokerState = this.pokerStates.get(matchId);
      if (!pokerState) {
        await this.endMatchWithError(matchId, 'Poker state lost');
        return;
      }

      if (isPokerMatchOver(pokerState)) {
        const winningSide: Side | undefined = pokerState.winner && pokerState.winner !== 'draw' ? pokerState.winner as Side : undefined;
        const stacks = Object.fromEntries(Object.entries(pokerState.players).map(([s, p]) => [s, p.stack]));
        this.activeMatches.updateMatch(matchId, {
          gameState: {
            ...matchState.gameState,
            scores: { black: stacks['a'] || 0, white: stacks['b'] || 0 },
            gameOver: true,
            winner: winningSide ? 'B' : 'draw',
          },
        });
        await this.endMatch(matchId, 'score', winningSide);
        return;
      }

      // Check timeouts for all agents
      const timedOutSide = this.findTimedOutSide(matchState);
      if (timedOutSide) return;

      const handResult = await this.pokerTurnController.executeHand(matchState, pokerState);
      this.pokerStates.set(matchId, handResult.pokerState);

      this.activeMatches.updateMatch(matchId, {
        gameState: {
          ...matchState.gameState,
          scores: { black: handResult.pokerState.players['a']?.stack || 0, white: handResult.pokerState.players['b']?.stack || 0 },
          moveNumber: handResult.pokerState.actionHistory.length,
          gameOver: handResult.matchOver,
          winner: handResult.matchOver
            ? (handResult.winner && handResult.winner !== 'draw' ? 'B' : 'draw')
            : null,
        },
      });

      const updated = this.activeMatches.getMatch(matchId);
      if (!updated) return;

      if (handResult.matchOver) {
        const winningSide: Side | undefined = handResult.winner && handResult.winner !== 'draw' ? handResult.winner as Side : undefined;
        await this.endMatch(matchId, 'score', winningSide);
        return;
      }

      // Max hands limit to prevent infinite matches (scales with player count)
      const playerCount = Object.keys(handResult.pokerState.players).length;
      const maxHands = getPokerMaxHands(playerCount);
      if (handResult.pokerState.handNumber >= maxHands) {
        let bestSide: string | undefined;
        let bestStack = -1;
        let tied = false;
        for (const [side, player] of Object.entries(handResult.pokerState.players)) {
          if (player.stack > bestStack) { bestStack = player.stack; bestSide = side; tied = false; }
          else if (player.stack === bestStack) { tied = true; }
        }
        const winningSide: Side | undefined = bestSide && !tied ? bestSide as Side : undefined;
        this.logger.log(`Match ${matchId}: max hands (${maxHands}/${playerCount}p) reached, winner by stack: ${winningSide ?? 'draw'}`);
        await this.endMatch(matchId, 'max_hands' as any, winningSide);
        return;
      }

      // Check timeouts for all agents after hand
      const timedOutSideAfter = this.findTimedOutSide(updated);
      if (timedOutSideAfter) return;

      // Brief pause between hands
      await new Promise<void>((resolve) => setTimeout(resolve, 2000));
    }
  }

  private async runRpsGameLoop(matchId: string): Promise<void> {
    while (true) {
      const matchState = this.activeMatches.getMatch(matchId);
      if (!matchState || matchState.status !== 'active') return;
      const rpsState = this.rpsStates.get(matchId);
      if (!rpsState) { await this.endMatchWithError(matchId, 'RPS state lost'); return; }
      const result = await this.rpsTurnController.executeRound(matchState, rpsState);
      this.rpsStates.set(matchId, result.rpsState);
      this.activeMatches.updateMatch(matchId, {
        gameState: {
          ...matchState.gameState,
          scores: { black: result.rpsState.scores.a, white: result.rpsState.scores.b },
          moveNumber: result.rpsState.rounds.length,
          gameOver: result.matchOver,
          winner: result.matchOver ? (result.winner === 'a' ? 'B' : result.winner === 'b' ? 'W' : 'draw') : null,
        },
      });
      if (result.matchOver) {
        const winningSide: Side | undefined = result.winner && result.winner !== 'draw' ? result.winner as Side : undefined;
        await this.endMatch(matchId, 'score', winningSide);
        return;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  /**
   * Check if any agent has exceeded MAX_TIMEOUTS. If so, end the match.
   * For 2-player: the other side wins. For N-player: the non-timed-out side with
   * the best position wins (simplified: first non-timed-out side).
   * Returns true if a timeout was found and match was ended.
   */
  private findTimedOutSide(matchState: ActiveMatchState): boolean {
    const sides = Object.keys(matchState.timeouts);
    for (const side of sides) {
      if (matchState.timeouts[side] >= MAX_TIMEOUTS) {
        // Determine winner: for 2-player, it's the other side
        const otherSides = sides.filter((s) => s !== side);
        const winner = otherSides.length === 1 ? otherSides[0] as Side : undefined;
        this.endMatch(matchState.matchId, 'timeout', winner).catch(() => {});
        return true;
      }
    }
    return false;
  }

  async endMatch(matchId: string, reason: string, forcedWinnerSide?: Side): Promise<void> {
    if (this.endedMatches.has(matchId)) return;
    this.endedMatches.add(matchId);

    try {
      await this.resultHandler.handleMatchEnd(matchId, reason, forcedWinnerSide as any);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error ending match ${matchId}: ${message}`);
    } finally {
      this.marrakechStates.delete(matchId);
      this.chessEngines.delete(matchId);
      this.chessMoveHistories.delete(matchId);
      this.pokerStates.delete(matchId);
      this.rpsStates.delete(matchId);
      this.matchGameTypes.delete(matchId);
      setTimeout(() => this.endedMatches.delete(matchId), 5000);
    }
  }

  private handleMatchTimeout(matchId: string): void {
    this.logger.warn(`Match timer expired for ${matchId}`);
    const matchState = this.activeMatches.getMatch(matchId);
    if (!matchState) return;

    const gameType = this.matchGameTypes.get(matchId) ?? 'chess';
    let forcedWinner: Side | undefined;

    if (gameType === 'marrakech') {
      const mkState = this.marrakechStates.get(matchId);
      if (mkState) {
        const marrakech = this.gameEngine.getMarrakechEngine();
        const scores = marrakech.calculateFinalScores(mkState);
        if (scores.length >= 2) {
          if (scores[0].total > scores[1].total) {
            forcedWinner = scores[0].playerId === 0 ? 'a' : 'b';
          }
        }
      }
    } else if (gameType === 'chess') {
      const chessEng = this.chessEngines.get(matchId);
      if (chessEng) {
        const materialScore = chessEng.getMaterialScore();
        if (materialScore > 0) forcedWinner = 'a';
        else if (materialScore < 0) forcedWinner = 'b';
      }
    } else if (gameType === 'poker') {
      const pkState = this.pokerStates.get(matchId);
      if (pkState) {
        // Find the player with the highest stack
        let bestSide: string | undefined;
        let bestStack = -1;
        let tied = false;
        for (const [side, player] of Object.entries(pkState.players)) {
          if (player.stack > bestStack) {
            bestStack = player.stack;
            bestSide = side;
            tied = false;
          } else if (player.stack === bestStack) {
            tied = true;
          }
        }
        if (bestSide && !tied) forcedWinner = bestSide as Side;
      }
    } else if (gameType === 'rps') {
      const rpsState = this.rpsStates.get(matchId);
      if (rpsState) {
        if (rpsState.scores.a > rpsState.scores.b) forcedWinner = 'a';
        else if (rpsState.scores.b > rpsState.scores.a) forcedWinner = 'b';
      }
    } else {
      const { scores } = matchState.gameState;
      if (scores.black > scores.white) forcedWinner = 'a';
      else if (scores.white > scores.black) forcedWinner = 'b';
    }

    this.endMatch(matchId, 'timeout', forcedWinner).catch((error: unknown) => {
      this.logger.error(`Failed to end match ${matchId} after timeout`);
    });
  }

  async endMatchWithError(matchId: string, errorMessage: string): Promise<void> {
    if (this.endedMatches.has(matchId)) return;
    this.endedMatches.add(matchId);

    const matchState = this.activeMatches.getMatch(matchId);
    if (matchState?.clock) matchState.clock.stop();

    const agentIds = matchState
      ? Object.fromEntries(Object.entries(matchState.agents).map(([side, info]) => [side, info.agentId]))
      : undefined;
    this.eventBus.emit('match:error', { matchId, agentIds, error: errorMessage });

    try {
      await this.matchModel.updateOne({ _id: matchId }, { status: 'error', endedAt: new Date() });
      const erroredMatch = await this.matchModel.findById(matchId).lean();
      if (erroredMatch?.txHashes?.escrow) {
        try { await this.settlementRouter.refund('solana', matchId); } catch {}
      }
      if (matchState) {
        await Promise.all(
          Object.values(matchState.agents).map((agentInfo) =>
            this.agentModel.updateOne({ _id: agentInfo.agentId }, { status: 'idle' }),
          ),
        );
      }
    } catch {}

    this.activeMatches.removeMatch(matchId);
    this.marrakechStates.delete(matchId);
    this.chessEngines.delete(matchId);
    this.chessMoveHistories.delete(matchId);
    this.pokerStates.delete(matchId);
    this.matchGameTypes.delete(matchId);
    setTimeout(() => this.endedMatches.delete(matchId), 5000);
  }

  async recoverActiveMatches(): Promise<void> {
    // 1. Cancel matches stuck in 'starting' status
    const startingMatches = await this.matchModel.find({ status: 'starting' });
    for (const match of startingMatches) {
      const matchId = match._id.toString();
      this.logger.warn(`Cancelling stuck 'starting' match ${matchId}`);
      await this.matchModel.updateOne({ _id: matchId }, { status: 'cancelled', endedAt: new Date() });
      const agentEntries = Object.values(match.agents || {}) as any[];
      await Promise.all(
        agentEntries
          .filter((a) => a?.agentId)
          .map((a) => this.agentModel.updateOne({ _id: a.agentId, status: 'in_match' }, { status: 'idle' })),
      );
      if (match.txHashes?.escrow) {
        try { await this.settlementRouter.refund('solana', matchId); } catch {}
      } else {
        this.logger.log(`Skipping refund for match ${matchId} — no escrow was deposited`);
      }
    }

    // 2. Recover matches with 'active' status
    const activeMatches = await this.matchModel.find({ status: 'active' });
    let recovered = 0;

    for (const match of activeMatches) {
      const matchId = match._id.toString();
      const gameType = match.gameType ?? 'chess';

      try {
        // Load agent docs for endpoints, type, openclaw fields, walletAddress
        const [agentDocA, agentDocB] = await Promise.all([
          this.agentModel.findById(match.agents.a.agentId),
          this.agentModel.findById(match.agents.b.agentId),
        ]);

        if (!agentDocA || !agentDocB) {
          this.logger.error(`Cannot recover match ${matchId}: agent doc(s) missing`);
          await this.matchModel.updateOne({ _id: matchId }, { status: 'error', endedAt: new Date() });
          if (match.txHashes?.escrow) {
            try { await this.settlementRouter.refund('solana', matchId); } catch {}
          }
          await Promise.all([
            this.agentModel.updateOne({ _id: match.agents.a.agentId }, { status: 'idle' }),
            this.agentModel.updateOne({ _id: match.agents.b.agentId }, { status: 'idle' }),
          ]);
          continue;
        }

        // Calculate elapsed time
        const startedAt = match.startedAt ? match.startedAt.getTime() : match.createdAt.getTime();
        const elapsedMs = Date.now() - startedAt;

        // If match has exceeded total duration, end it immediately
        if (elapsedMs > MATCH_DURATION_MS) {
          this.logger.warn(`Match ${matchId} exceeded duration (${elapsedMs}ms), ending as timeout`);

          let forcedWinner: Side | undefined;
          const scores = match.scores;
          if (gameType === 'marrakech' && match.marrakechState) {
            const mkState = match.marrakechState as MarrakechGameState;
            const pA = mkState.players[0]?.dirhams ?? 0;
            const pB = mkState.players[1]?.dirhams ?? 0;
            if (pA > pB) forcedWinner = 'a';
            else if (pB > pA) forcedWinner = 'b';
          } else if (gameType === 'chess' && match.chessState) {
            const chessState = match.chessState as ChessState;
            const chessEng = this.gameEngine.createChessEngine(chessState.fen);
            const materialScore = chessEng.getMaterialScore();
            if (materialScore > 0) forcedWinner = 'a';
            else if (materialScore < 0) forcedWinner = 'b';
          } else if (gameType === 'poker' && match.pokerState) {
            const pkState = match.pokerState as PokerGameState;
            let bestS: string | undefined; let bestSt = -1; let tie = false;
            for (const [side, pl] of Object.entries(pkState.players)) {
              if (pl.stack > bestSt) { bestSt = pl.stack; bestS = side; tie = false; }
              else if (pl.stack === bestSt) { tie = true; }
            }
            if (bestS && !tie) forcedWinner = bestS as Side;
          } else if (scores) {
            if (scores.a > scores.b) forcedWinner = 'a';
            else if (scores.b > scores.a) forcedWinner = 'b';
          }

          // Build minimal active state so endMatch/resultHandler works
          const minimalGameState: GameState = {
            board: match.currentBoard as Board,
            currentPlayer: match.currentTurn === 'a' ? 'B' as PlayerColor : 'W' as PlayerColor,
            moveNumber: match.moveCount,
            scores: {
              black: scores?.a ?? 0,
              white: scores?.b ?? 0,
            },
            gameOver: true,
            winner: forcedWinner === 'a' ? 'B' : forcedWinner === 'b' ? 'W' : 'draw',
          };

          const minimalState: ActiveMatchState = {
            matchId,
            gameState: minimalGameState,
            clock: null,
            turnDeadline: 0,
            timeouts: match.timeouts ?? { a: 0, b: 0 },
            status: 'active',
            agents: {
              a: {
                agentId: match.agents.a.agentId.toString(),
                endpointUrl: agentDocA.endpointUrl,
                piece: 'B' as PlayerColor,
                walletAddress: agentDocA.walletAddress,
                type: agentDocA.type,
              },
              b: {
                agentId: match.agents.b.agentId.toString(),
                endpointUrl: agentDocB.endpointUrl,
                piece: 'W' as PlayerColor,
                walletAddress: agentDocB.walletAddress,
                type: agentDocB.type,
              },
            },
            startedAt,
          };

          this.activeMatches.addMatch(minimalState);
          this.matchGameTypes.set(matchId, gameType);
          await this.endMatch(matchId, 'timeout', forcedWinner);
          recovered++;
          continue;
        }

        // Reconstruct in-memory state
        const currentSide = match.currentTurn as Side;
        const currentColor: PlayerColor = currentSide === 'a' ? 'B' : 'W';

        let gameState: GameState;
        if (gameType === 'marrakech' && match.marrakechState) {
          const mkState = match.marrakechState as MarrakechGameState;
          this.marrakechStates.set(matchId, mkState);
          gameState = {
            board: match.currentBoard as Board,
            currentPlayer: currentColor,
            moveNumber: match.moveCount,
            scores: {
              black: mkState.players[0]?.dirhams ?? 0,
              white: mkState.players[1]?.dirhams ?? 0,
            },
            gameOver: false,
            winner: null,
          };
        } else if (gameType === 'chess' && match.chessState) {
          const chessState = match.chessState as ChessState;
          const chessEng = this.gameEngine.createChessEngine();
          const moveHistory: ChessUciMove[] = chessState.moveHistory || [];
          for (const uci of moveHistory) {
            chessEng.applyMoveUci(uci);
          }
          this.chessEngines.set(matchId, chessEng);
          this.chessMoveHistories.set(matchId, [...moveHistory]);

          const materialScore = chessEng.getMaterialScore();
          gameState = {
            board: chessEng.getBoard() as unknown as Board,
            currentPlayer: currentColor,
            moveNumber: moveHistory.length,
            scores: { black: Math.max(0, materialScore), white: Math.max(0, -materialScore) },
            gameOver: false,
            winner: null,
          };
        } else if (gameType === 'poker' && match.pokerState) {
          const pkState = match.pokerState as PokerGameState;
          this.pokerStates.set(matchId, pkState);
          gameState = {
            board: [] as unknown as Board,
            currentPlayer: currentColor,
            moveNumber: match.moveCount,
            scores: { black: pkState.players['a']?.stack || 0, white: pkState.players['b']?.stack || 0 },
            gameOver: false,
            winner: null,
          };
        } else {
          const scores = match.scores ?? { a: 0, b: 0 };
          gameState = {
            board: match.currentBoard as Board,
            currentPlayer: currentColor,
            moveNumber: match.moveCount,
            scores: { black: scores.a, white: scores.b },
            gameOver: false,
            winner: null,
          };
        }

        // Create clock with elapsed time
        const clock = new MatchClock(
          matchId,
          {
            onMatchTimeout: (mId: string) => this.handleMatchTimeout(mId),
            onTurnTimeout: (mId: string) => {
              this.logger.warn(`Turn timeout callback for ${mId}`);
            },
          },
          MATCH_DURATION_MS,
          TURN_TIMEOUT_MS,
          elapsedMs,
        );

        const matchState: ActiveMatchState = {
          matchId,
          gameState,
          clock,
          turnDeadline: 0,
          timeouts: match.timeouts ?? { a: 0, b: 0 },
          status: 'active',
          agents: {
            a: {
              agentId: match.agents.a.agentId.toString(),
              endpointUrl: agentDocA.endpointUrl,
              piece: 'B' as PlayerColor,
              walletAddress: agentDocA.walletAddress,
              type: agentDocA.type,
              openclawUrl: agentDocA.openclawUrl,
              openclawToken: agentDocA.openclawToken,
              openclawAgentId: agentDocA.openclawAgentId,
            },
            b: {
              agentId: match.agents.b.agentId.toString(),
              endpointUrl: agentDocB.endpointUrl,
              piece: 'W' as PlayerColor,
              walletAddress: agentDocB.walletAddress,
              type: agentDocB.type,
              openclawUrl: agentDocB.openclawUrl,
              openclawToken: agentDocB.openclawToken,
              openclawAgentId: agentDocB.openclawAgentId,
            },
          },
          startedAt,
        };

        this.activeMatches.addMatch(matchState);
        this.matchGameTypes.set(matchId, gameType);
        clock.startMatch();

        // Resume the game loop
        let loopFn: Promise<void>;
        if (gameType === 'marrakech') {
          loopFn = this.runMarrakechGameLoop(matchId);
        } else if (gameType === 'chess') {
          loopFn = this.runChessGameLoop(matchId);
        } else if (gameType === 'poker') {
          loopFn = this.runPokerGameLoop(matchId);
        } else {
          loopFn = this.runGameLoop(matchId);
        }

        loopFn.catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error(`Recovered game loop failed for ${matchId}: ${message}`);
          this.endMatchWithError(matchId, message);
        });

        recovered++;
        this.logger.log(`Recovered match ${matchId} (${gameType}, ${Math.round(elapsedMs / 1000)}s elapsed)`);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Failed to recover match ${matchId}: ${message}`);
        await this.matchModel.updateOne({ _id: matchId }, { status: 'error', endedAt: new Date() });
        if (match.txHashes?.escrow) {
          try { await this.settlementRouter.refund('solana', matchId); } catch {}
        }
        await Promise.all([
          this.agentModel.updateOne({ _id: match.agents.a.agentId }, { status: 'idle' }),
          this.agentModel.updateOne({ _id: match.agents.b.agentId }, { status: 'idle' }),
        ]);
      }
    }

    if (recovered > 0 || startingMatches.length > 0) {
      this.logger.log(`Match recovery complete: ${recovered} active matches recovered, ${startingMatches.length} starting matches cancelled`);
    }
  }

  async stopAll(): Promise<void> {
    const matchIds = this.activeMatches.getAllMatchIds();
    this.logger.log(`Stopping all ${matchIds.length} active matches`);
    for (const matchId of matchIds) {
      try {
        const matchState = this.activeMatches.getMatch(matchId);
        if (matchState?.clock) matchState.clock.stop();
        await this.endMatch(matchId, 'forfeit');
      } catch {}
    }
  }

  getMarrakechState(matchId: string): MarrakechGameState | undefined {
    return this.marrakechStates.get(matchId);
  }

  getChessEngine(matchId: string): ChessEngine | undefined {
    return this.chessEngines.get(matchId);
  }

  getPokerState(matchId: string): PokerGameState | undefined {
    return this.pokerStates.get(matchId);
  }

  getRpsState(matchId: string): RpsGameState | undefined {
    return this.rpsStates.get(matchId);
  }

  getGameType(matchId: string): string {
    return this.matchGameTypes.get(matchId) ?? 'chess';
  }
}
