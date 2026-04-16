import { Injectable, Logger, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomBytes, createHash, randomUUID } from 'crypto';
import { Keypair } from '@solana/web3.js';
import * as bs58Module from 'bs58';
const bs58Mod = bs58Module as Record<string, unknown>;
const bs58Encode = ((bs58Mod.default as Record<string, unknown>)?.encode ?? bs58Mod.encode) as (input: Uint8Array) => string;
import { Agent, Match } from '../database/schemas';
import { ActiveMatchesService } from '../orchestrator/active-matches.service';
import { HumanMoveService } from '../orchestrator/human-move.service';
import { MatchmakingService } from '../matchmaking/matchmaking.service';
import { MatchManagerService } from '../orchestrator/match-manager.service';
import { SettlementRouterService } from '../settlement/settlement-router.service';
import { X402PaymentStore } from '../settlement/x402-payment-store.service';
import { getLegalActions } from '../game-engine/poker';
import {
  getLegalActions as getWerewolfLegalActions,
  toPlayerView as werewolfPlayerView,
} from '../game-engine/werewolf';
import { RegisterAgentDto } from './dto/register.dto';
import { JoinQueueDto } from './dto/queue.dto';
import { SubmitMoveDto } from './dto/move.dto';

@Injectable()
export class AgentApiService {
  private readonly logger = new Logger(AgentApiService.name);

  constructor(
    @InjectModel(Agent.name) private readonly agentModel: Model<Agent>,
    @InjectModel(Match.name) private readonly matchModel: Model<Match>,
    private readonly activeMatches: ActiveMatchesService,
    private readonly humanMoveService: HumanMoveService,
    private readonly matchmakingService: MatchmakingService,
    private readonly matchManager: MatchManagerService,
    private readonly settlementRouter: SettlementRouterService,
    private readonly x402PaymentStore: X402PaymentStore,
  ) {}

  async registerAgent(dto: RegisterAgentDto) {
    const rawKey = 'ak_' + randomBytes(32).toString('hex');
    const hash = createHash('sha256').update(rawKey).digest('hex');
    const prefix = rawKey.substring(0, 11); // "ak_" + 8 hex chars
    const claimToken = randomUUID();

    // Generate a dedicated Solana wallet for this agent
    const { encrypt } = require('../common/crypto.util');
    const keypair = Keypair.generate();
    const walletAddress = keypair.publicKey.toBase58();
    const walletPrivateKey = encrypt(bs58Encode(keypair.secretKey));

    const agent = await this.agentModel.create({
      userId: dto.userId ?? null,
      name: dto.name,
      type: 'pull',
      gameTypes: dto.gameTypes || [],
      walletAddress: dto.walletAddress ?? walletAddress,
      walletPrivateKey,
      chain: 'solana',
      apiKeyHash: hash,
      apiKeyPrefix: prefix,
      claimToken,
      claimStatus: 'unclaimed',
      status: 'idle',
      eloRating: 1200,
      stats: { wins: 0, losses: 0, draws: 0, totalMatches: 0, winRate: 0, totalEarnings: 0 },
    });

    this.logger.log(`Registered pull agent "${dto.name}" (id=${agent._id}, prefix=${prefix})`);

    // Create token accounts in background
    this.settlementRouter.ensureTokenAccounts('solana', agent.walletAddress).catch((err) =>
      this.logger.warn(`Failed to create ATAs for agent ${dto.name}: ${err.message}`),
    );

    return {
      agentId: agent._id.toString(),
      apiKey: rawKey,
      apiKeyPrefix: prefix,
      claimToken,
      claimUrl: `https://app.alpharena.ai/claim/${claimToken}`,
      name: dto.name,
      gameTypes: dto.gameTypes || [],
      walletAddress: agent.walletAddress,
    };
  }

  async getAgentStatus(agent: Agent) {
    const agentId = agent._id.toString();

    // Check if in an active match
    let activeMatchId: string | null = null;
    for (const [matchId, state] of this.activeMatches.entries()) {
      for (const side of Object.keys(state.agents)) {
        if (state.agents[side].agentId === agentId) {
          activeMatchId = matchId;
          break;
        }
      }
      if (activeMatchId) break;
    }

    // Check if in queue
    const queueEntry = await this.matchmakingService.getQueueStatus(agentId);

    return {
      agentId,
      name: agent.name,
      status: agent.status,
      eloRating: agent.eloRating,
      stats: agent.stats,
      gameTypes: agent.gameTypes,
      claimStatus: agent.claimStatus,
      xUsername: agent.xUsername,
      lastHeartbeat: agent.lastHeartbeat,
      activeMatchId,
      inQueue: !!queueEntry,
      queueGameType: queueEntry?.gameType,
    };
  }

  async joinQueue(agent: Agent, dto: JoinQueueDto) {
    const agentId = agent._id.toString();

    if (agent.status !== 'idle') {
      throw new BadRequestException(
        `Agent cannot join queue because its status is "${agent.status}". It must be "idle".`,
      );
    }

    // Also check in-memory queue (status may have been reset but queue entry persists)
    const existingEntry = await this.matchmakingService.getQueueStatus(agentId);
    if (existingEntry) {
      throw new BadRequestException(
        `Agent is already in the queue for ${existingEntry.gameType}. Call POST /v1/queue/leave first, or wait for the match.`,
      );
    }

    if (!agent.walletAddress) {
      throw new BadRequestException('Agent does not have a wallet.');
    }

    // Verify agent wallet has some balance
    const chain = agent.chain || 'solana';
    const [alphaBalance, usdcBalance, solBalance] = await Promise.all([
      this.settlementRouter.getAgentTokenBalance(chain, agent.walletAddress, 'ALPHA').catch(() => '0'),
      this.settlementRouter.getAgentTokenBalance(chain, agent.walletAddress, 'USDC').catch(() => '0'),
      this.settlementRouter.getAgentNativeBalance(chain, agent.walletAddress).catch(() => '0'),
    ]);
    const totalBalance = parseFloat(alphaBalance) + parseFloat(usdcBalance) + parseFloat(solBalance);
    if (totalBalance <= 0) {
      throw new BadRequestException(
        `Agent wallet has no balance. Deposit ALPHA, USDC, or SOL to ${agent.walletAddress} before playing.`,
      );
    }

    // Auto-calculate stake: $1 USD equivalent
    const matchToken = dto.token || 'USDC';
    let stakeAmount = dto.stakeAmount ?? 1;
    if (matchToken === 'ALPHA') {
      const alphaPrice = await this.settlementRouter.getAlphaPriceUsd();
      if (alphaPrice && alphaPrice > 0) {
        stakeAmount = Math.ceil(1 / alphaPrice);
      }
      if (parseFloat(alphaBalance) < stakeAmount) {
        throw new BadRequestException(
          `Insufficient ALPHA balance: ${alphaBalance} but need ${stakeAmount}. Deposit to ${agent.walletAddress}`,
        );
      }
    } else if (matchToken === 'USDC') {
      stakeAmount = 1;
      const x402Payment = this.x402PaymentStore.getPayment(agentId);
      if (!x402Payment) {
        throw new BadRequestException(
          'USDC matches require x402 payment. POST to /x402/stake first, transfer USDC, verify, then join.',
        );
      }
      if (x402Payment.amount < stakeAmount) {
        throw new BadRequestException(
          `x402 payment insufficient: paid ${x402Payment.amount} USDC but stake requires ${stakeAmount}`,
        );
      }
    }

    agent.status = 'queued';
    await agent.save();

    try {
      await this.matchmakingService.joinQueue(
        agentId,
        agent.userId?.toString() ?? agentId,
        agent.eloRating,
        stakeAmount,
        dto.gameType || 'any',
        'pull',
        dto.token,
      );

      return {
        message: 'Successfully joined queue',
        agentId,
        gameType: dto.gameType || 'any',
        stakeAmount,
        token: matchToken,
      };
    } catch (err) {
      agent.status = 'idle';
      await agent.save();
      throw err;
    }
  }

  async leaveQueue(agent: Agent) {
    const agentId = agent._id.toString();

    if (agent.status !== 'queued') {
      throw new BadRequestException(`Agent is not in the queue (current status: "${agent.status}")`);
    }

    await this.matchmakingService.leaveQueue(agentId);
    agent.status = 'idle';
    await agent.save();

    return { message: 'Successfully left the queue', agentId };
  }

  async getGameState(agent: Agent, matchId: string) {
    const agentId = agent._id.toString();
    const matchState = this.activeMatches.getMatch(matchId);

    if (!matchState) {
      throw new NotFoundException('Match not found or not active');
    }

    // Verify agent is in this match
    let agentSide: string | null = null;
    for (const side of Object.keys(matchState.agents)) {
      if (matchState.agents[side].agentId === agentId) {
        agentSide = side;
        break;
      }
    }

    if (!agentSide) {
      throw new BadRequestException('Agent is not a participant in this match');
    }

    const gameType = this.matchManager.getGameType(matchId);

    // In RPS, pending moves use key "matchId:side" since both players move simultaneously
    let isYourTurn = this.humanMoveService.getPendingAgentId(matchId) === agentId;
    if (!isYourTurn && gameType === 'rps' && agentSide) {
      isYourTurn = this.humanMoveService.getPendingAgentId(`${matchId}:${agentSide}`) === agentId;
    }

    const baseState: Record<string, unknown> = {
      matchId,
      gameType,
      yourSide: agentSide,
      status: matchState.status,
      isYourTurn,
      timeRemainingMs: matchState.clock?.getTimeRemainingMs() ?? 0,
    };

    if (gameType === 'chess') {
      const chessEngine = this.matchManager.getChessEngine(matchId);
      const moveHistory = this.matchManager.getChessMoveHistory(matchId);
      if (chessEngine) {
        baseState.fen = chessEngine.getFen();
        baseState.board = chessEngine.getBoard();
        baseState.moveHistory = moveHistory ?? [];
        baseState.moveNumber = chessEngine.getMoveNumber();
        baseState.isCheck = chessEngine.isCheck();
        baseState.isGameOver = chessEngine.isGameOver();
        if (isYourTurn) {
          baseState.legalMoves = chessEngine.getLegalMovesUci();
          baseState.yourColor = chessEngine.getTurn();
        }
      }
    } else if (gameType === 'poker') {
      const pokerState = this.matchManager.getPokerState(matchId);
      if (pokerState) {
        baseState.handNumber = pokerState.handNumber;
        baseState.street = pokerState.street;
        baseState.pot = pokerState.pot;
        baseState.communityCards = pokerState.communityCards;
        baseState.yourStack = pokerState.players[agentSide as 'a' | 'b']?.stack;
        baseState.yourHoleCards = pokerState.players[agentSide as 'a' | 'b']?.holeCards;
        baseState.isDealer = pokerState.players[agentSide as 'a' | 'b']?.isDealer;
        baseState.actionHistory = pokerState.actionHistory;
        if (isYourTurn) {
          baseState.legalActions = getLegalActions(pokerState);
        }
      }
    } else if (gameType === 'rps') {
      const rpsState = this.matchManager.getRpsState?.(matchId);
      if (rpsState) {
        baseState.currentRound = rpsState.currentRound;
        baseState.bestOf = rpsState.bestOf;
        baseState.scores = rpsState.scores;
        baseState.phase = rpsState.phase;
        if (isYourTurn) {
          baseState.legalMoves = ['rock', 'paper', 'scissors'];
        }
      }
    } else if (gameType === 'werewolf') {
      const wwState = this.matchManager.getWerewolfState?.(matchId);
      if (wwState && agentSide) {
        const view = werewolfPlayerView(wwState, agentSide) as Record<string, unknown>;
        Object.assign(baseState, view);
        if (isYourTurn) {
          baseState.legalActions = getWerewolfLegalActions(wwState, agentSide);
        }
      }
    } else {
      // Reversi/Marrakech — use generic game state
      baseState.board = matchState.gameState.board;
      baseState.scores = matchState.gameState.scores;
      baseState.moveNumber = matchState.gameState.moveNumber;
      baseState.isGameOver = matchState.gameState.gameOver;
      if (isYourTurn) {
        baseState.legalMoves = matchState.gameState.board;
      }
    }

    return baseState;
  }

  async submitMove(agent: Agent, matchId: string, dto: SubmitMoveDto) {
    const agentId = agent._id.toString();
    const matchState = this.activeMatches.getMatch(matchId);

    if (!matchState) {
      throw new NotFoundException('Match not found or not active');
    }

    // Verify agent is in this match
    let agentSide: string | null = null;
    for (const side of Object.keys(matchState.agents)) {
      if (matchState.agents[side].agentId === agentId) {
        agentSide = side;
        break;
      }
    }

    if (!agentSide) {
      throw new BadRequestException('Agent is not a participant in this match');
    }

    // Determine the move format based on game type
    const gameType = this.matchManager.getGameType(matchId);
    let move: unknown;

    if (gameType === 'chess') {
      // Support both "move" (UCI) and "from"+"to" formats
      if (dto.move) {
        move = dto.move;
      } else if (dto.from && dto.to) {
        move = dto.from + dto.to + (dto.promotion ?? '');
      } else {
        throw new BadRequestException('Chess move requires "move" (UCI format) or "from" + "to"');
      }
    } else if (gameType === 'poker') {
      if (!dto.action) {
        throw new BadRequestException('Poker move requires "action"');
      }
      move = { action: dto.action, amount: dto.amount };
    } else if (gameType === 'rps') {
      const rpsMove = dto.move || dto.action;
      if (!rpsMove || !['rock', 'paper', 'scissors'].includes(rpsMove)) {
        throw new BadRequestException('RPS move requires "move" with value "rock", "paper", or "scissors"');
      }
      move = rpsMove;
    } else if (gameType === 'werewolf') {
      const wwAction = (dto as unknown as { werewolfAction?: unknown }).werewolfAction
        ?? dto.action
        ?? dto.move;
      if (!wwAction || typeof wwAction !== 'object') {
        throw new BadRequestException('Werewolf move requires "werewolfAction" with a tagged action object');
      }
      move = wwAction;
    } else {
      // Reversi/Marrakech
      if (dto.row === undefined || dto.col === undefined) {
        throw new BadRequestException('Move requires "row" and "col"');
      }
      move = [dto.row, dto.col];
    }

    // In RPS, try the per-side key first (matchId:side) since both players move simultaneously
    let submitted = false;
    if (gameType === 'rps' && agentSide) {
      submitted = this.humanMoveService.submitMove(`${matchId}:${agentSide}`, agentId, move);
    }
    if (!submitted) {
      submitted = this.humanMoveService.submitMove(matchId, agentId, move);
    }
    if (!submitted) {
      throw new BadRequestException('Failed to submit move. It may not be your turn.');
    }

    return { success: true, matchId };
  }
}
