import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Agent, User, Match } from '../database/schemas';
import { MatchmakingService } from '../matchmaking/matchmaking.service';
import { SettlementRouterService } from '../settlement/settlement-router.service';
import { X402PaymentStore } from '../settlement/x402-payment-store.service';
import { HumanMoveService } from '../orchestrator/human-move.service';
import { DEFAULT_ELO } from '../common/constants/game.constants';

@Injectable()
export class PlayService {
  private readonly logger = new Logger(PlayService.name);

  constructor(
    @InjectModel(Agent.name) private readonly agentModel: Model<Agent>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(Match.name) private readonly matchModel: Model<Match>,
    private readonly matchmakingService: MatchmakingService,
    private readonly settlementRouter: SettlementRouterService,
    private readonly x402PaymentStore: X402PaymentStore,
    private readonly humanMoveService: HumanMoveService,
  ) {}

  async joinQueue(userId: string, gameType?: string, stakeAmountInput?: number, token?: string) {
    const agent = await this.getOrCreateHumanAgent(userId);

    // If already queued, check if actually in the matchmaking queue
    if (agent.status === 'queued') {
      const inQueue = await this.matchmakingService.getQueueStatus(agent._id.toString());
      if (inQueue) {
        return {
          message: 'Already in the matchmaking queue',
          agentId: agent._id.toString(),
          stakeAmount: inQueue.stakeAmount,
        };
      }
      this.logger.log(`Recovering stale queued status for human agent ${agent._id}`);
      agent.status = 'idle';
      await agent.save();
    }

    if (agent.status !== 'idle') {
      throw new BadRequestException(`Your player agent is currently "${agent.status}". It must be "idle" to join the queue.`);
    }

    if (!agent.walletAddress) {
      throw new BadRequestException('Wallet not found. Please contact support.');
    }

    // Auto-calculate stake: $1 USD equivalent
    const matchToken = token || 'USDC';
    const chain = agent.chain || 'bnb';
    let stakeAmount = stakeAmountInput ?? 1;
    if (matchToken === 'ALPHA') {
      const alphaPrice = await this.settlementRouter.getAlphaPriceUsd();
      if (alphaPrice && alphaPrice > 0) {
        stakeAmount = Math.ceil(1 / alphaPrice);
      }
    } else {
      stakeAmount = 1;
    }

    if (stakeAmount > 0) {
      const tokenBalance = await this.settlementRouter.getAgentTokenBalance(chain, agent.walletAddress, matchToken).catch(() => '0');

      if (parseFloat(tokenBalance) < stakeAmount) {
        throw new BadRequestException(
          `Insufficient ${matchToken} balance. You have ${tokenBalance} but need ${stakeAmount}. Deposit to ${agent.walletAddress}`,
        );
      }

      // Custodial escrow: transfer stake from user wallet to platform
      const user = await this.userModel.findById(userId).select('+walletPrivateKey');
      if (!user?.walletPrivateKey) throw new BadRequestException('Wallet not configured');
      const { decrypt } = require('../common/crypto.util');
      const privKey = decrypt(user.walletPrivateKey);
      const decimals = this.settlementRouter.getTokenDecimals(chain, matchToken);
      const amountAtomic = BigInt(Math.round(stakeAmount * 10 ** decimals));
      const platformWallet = this.settlementRouter.getPlatformWalletAddress(chain);
      if (!platformWallet) throw new BadRequestException('Settlement not configured');

      const escrowTx = await this.settlementRouter.transferTokenFromAgent(chain, privKey, platformWallet, amountAtomic, matchToken);
      if (!escrowTx) throw new BadRequestException(`${matchToken} escrow transfer failed`);
      this.logger.log(`Play escrow: user=${userId}, amount=${stakeAmount} ${matchToken}, tx=${escrowTx}`);

      // Register payment in x402 store so matchmaking can validate it
      if (matchToken === 'USDC') {
        this.x402PaymentStore.setPayment(agent._id.toString(), {
          txSignature: escrowTx,
          amount: stakeAmount,
          token: 'USDC',
          verifiedAt: new Date(),
          gameType: 'any',
        });
      }
    }

    agent.status = 'queued';
    await agent.save();

    try {
      const queueGameType = gameType || 'any';
      await this.matchmakingService.joinQueue(agent._id.toString(), userId, agent.eloRating, stakeAmount, queueGameType, 'human', token);
      return {
        message: 'Successfully joined the matchmaking queue',
        agentId: agent._id.toString(),
        stakeAmount,
      };
    } catch (err) {
      agent.status = 'idle';
      await agent.save();
      throw err;
    }
  }

  async cancelQueue(userId: string) {
    const agent = await this.agentModel.findOne({
      userId,
      type: 'human',
      status: 'queued',
    });

    if (!agent) {
      throw new BadRequestException('You are not currently in the queue.');
    }

    await this.matchmakingService.leaveQueue(agent._id.toString());
    agent.status = 'idle';
    await agent.save();

    return { message: 'Successfully left the matchmaking queue' };
  }

  async getStatus(userId: string) {
    // Check for any human agent in queue or in match
    const agents = await this.agentModel.find({
      userId,
      type: 'human',
      status: { $in: ['queued', 'in_match'] },
    });

    if (agents.length === 0) {
      return { inQueue: false, inMatch: false };
    }

    for (const agent of agents) {
      if (agent.status === 'queued') {
        const queueEntry = await this.matchmakingService.getQueueStatus(agent._id.toString());
        return {
          inQueue: true,
          inMatch: false,
          agentId: agent._id.toString(),
          gameType: queueEntry?.gameType,
          stakeAmount: queueEntry?.stakeAmount,
        };
      }

      if (agent.status === 'in_match') {
        const activeMatch = await this.matchModel.findOne({
          $or: [
            { 'agents.a.agentId': agent._id.toString() },
            { 'agents.b.agentId': agent._id.toString() },
          ],
          status: { $in: ['starting', 'active'] },
        }).select('_id gameType status').lean();

        if (activeMatch) {
          return {
            inQueue: false,
            inMatch: true,
            agentId: agent._id.toString(),
            matchId: (activeMatch as any)._id.toString(),
            gameType: activeMatch.gameType,
            matchStatus: activeMatch.status,
          };
        }
      }
    }

    return { inQueue: false, inMatch: false };
  }

  async getBalance(userId: string) {
    const user = await this.userModel.findById(userId);
    if (!user || !user.walletAddress) {
      throw new NotFoundException('User wallet not found');
    }

    const chain = 'bnb';
    const [alpha, usdc, bnb] = await Promise.all([
      this.settlementRouter.getAgentTokenBalance(chain, user.walletAddress, 'ALPHA'),
      this.settlementRouter.getAgentTokenBalance(chain, user.walletAddress, 'USDC'),
      this.settlementRouter.getAgentNativeBalance(chain, user.walletAddress),
    ]);

    return {
      walletAddress: user.walletAddress,
      alpha,
      usdc,
      bnb,
    };
  }

  async submitMove(userId: string, matchId: string, move: unknown) {
    // Find the user's human agent involved in this match
    const pendingAgentId = this.humanMoveService.getPendingAgentId(matchId);
    if (!pendingAgentId) {
      throw new BadRequestException('No pending move for this match.');
    }

    const agent = await this.agentModel.findById(pendingAgentId);
    if (!agent || (agent.userId && agent.userId.toString() !== userId) || agent.type !== 'human') {
      throw new BadRequestException('You are not the human player in this match.');
    }

    const submitted = this.humanMoveService.submitMove(matchId, pendingAgentId, move);
    if (!submitted) {
      throw new BadRequestException('Failed to submit move. It may no longer be your turn.');
    }

    return { success: true };
  }

  async getOrCreateHumanAgent(userId: string): Promise<Agent> {
    // Find existing human agent for this user (one per user, plays all games)
    let agent = await this.agentModel.findOne({
      userId,
      type: 'human',
      status: { $ne: 'disabled' },
    });

    if (agent) return agent;

    // Create a new human agent
    const user = await this.userModel.findById(userId).select('+walletPrivateKey');
    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (!user.walletAddress) {
      throw new BadRequestException('User does not have a wallet.');
    }

    agent = await this.agentModel.create({
      userId,
      name: user.username,
      type: 'human',
      gameTypes: [],
      eloRating: DEFAULT_ELO,
      status: 'idle',
      stats: { wins: 0, losses: 0, draws: 0, totalMatches: 0, winRate: 0, totalEarnings: 0 },
      walletAddress: user.walletAddress,
      walletPrivateKey: user.walletPrivateKey,
      chain: 'bnb',
    });

    this.logger.log(`Created human agent "${user.username}" for user ${userId}`);
    return agent;
  }

  async withdraw(userId: string, amount: number, to: string, token: string = 'USDC') {
    const user = await this.userModel.findById(userId).select('+walletPrivateKey');
    if (!user) throw new NotFoundException('User not found');
    if (!user.walletAddress || !user.walletPrivateKey) {
      throw new BadRequestException('User does not have a wallet');
    }

    if (token === 'SOL') {
      throw new BadRequestException('SOL withdrawals coming soon. Use ALPHA or USDC.');
    }

    if (token === 'USDC' && amount < 10) {
      throw new BadRequestException('Minimum USDC withdrawal is 10 USDC.');
    }

    const chain = 'bnb';
    const balanceStr = await this.settlementRouter.getAgentTokenBalance(chain, user.walletAddress, token);
    const balance = parseFloat(balanceStr);
    if (balance < amount) {
      throw new BadRequestException(`Insufficient balance: you have ${balance.toFixed(2)} ${token} but tried to withdraw ${amount}`);
    }

    const decimals = this.settlementRouter.getTokenDecimals(chain, token);
    const amountWei = BigInt(Math.round(amount * 10 ** decimals));
    const { decrypt } = require('../common/crypto.util');
    const privKey = decrypt(user.walletPrivateKey);
    const txHash = await this.settlementRouter.transferTokenFromAgent(chain, privKey, to, amountWei, token);

    this.logger.log(`Withdraw: user=${userId}, amount=${amount} ${token}, to=${to}, txHash=${txHash}`);
    return { txHash, amount, to, token, chain };
  }
}
