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
    const chain = agent.chain || 'solana';
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
      const user = await this.userModel.findById(userId).select('+walletPrivateKey');
      if (!user) throw new BadRequestException('User not found');

      const isExternal = user.walletType === 'external' && user.externalWalletAddress;

      if (isExternal) {
        // Non-custodial: require pre-payment via x402 (user already signed client-side)
        const x402Payment = this.x402PaymentStore.getPayment(agent._id.toString());
        if (!x402Payment) {
          throw new BadRequestException(
            `External wallet matches require pre-payment. POST to /x402/stake with your signed transaction first.`,
          );
        }
        if (x402Payment.amount < stakeAmount) {
          throw new BadRequestException(
            `x402 payment insufficient: paid ${x402Payment.amount} ${matchToken} but stake requires ${stakeAmount}`,
          );
        }
        this.logger.log(`Play pre-paid (external wallet): user=${userId}, amount=${stakeAmount} ${matchToken}, tx=${x402Payment.txSignature}`);
      } else {
        // Custodial: server-side escrow transfer
        const tokenBalance = await this.settlementRouter.getAgentTokenBalance(chain, agent.walletAddress, matchToken).catch(() => '0');

        if (parseFloat(tokenBalance) < stakeAmount) {
          throw new BadRequestException(
            `Insufficient ${matchToken} balance. You have ${tokenBalance} but need ${stakeAmount}. Deposit to ${agent.walletAddress}`,
          );
        }

        if (!user.walletPrivateKey) throw new BadRequestException('Wallet not configured');
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
        this.x402PaymentStore.setPayment(agent._id.toString(), {
          txSignature: escrowTx,
          amount: stakeAmount,
          token: matchToken,
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
    if (!user) throw new NotFoundException('User not found');

    const isExternal = user.walletType === 'external' && user.externalWalletAddress;
    const activeWallet = isExternal ? user.externalWalletAddress! : user.walletAddress;

    if (!activeWallet) {
      throw new NotFoundException('User wallet not found');
    }

    const chain = 'solana';
    const [alpha, usdc, sol] = await Promise.all([
      this.settlementRouter.getAgentTokenBalance(chain, activeWallet, 'ALPHA'),
      this.settlementRouter.getAgentTokenBalance(chain, activeWallet, 'USDC'),
      this.settlementRouter.getAgentNativeBalance(chain, activeWallet),
    ]);

    return {
      walletAddress: activeWallet,
      walletType: user.walletType ?? 'custodial',
      alpha,
      usdc,
      sol,
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

    if (agent) {
      // Sync wallet if user switched wallet type
      const user = await this.userModel.findById(userId);
      if (user) {
        const isExternal = user.walletType === 'external' && user.externalWalletAddress;
        const expectedWallet = isExternal ? user.externalWalletAddress! : user.walletAddress!;
        if (expectedWallet && agent.walletAddress !== expectedWallet) {
          agent.walletAddress = expectedWallet;
          if (isExternal) {
            agent.walletPrivateKey = null as any;
          } else {
            const userWithKey = await this.userModel.findById(userId).select('+walletPrivateKey');
            agent.walletPrivateKey = userWithKey?.walletPrivateKey ?? (null as any);
          }
          await agent.save();
          this.logger.log(`Synced human agent wallet for user ${userId} to ${user.walletType}`);
        }
      }
      return agent;
    }

    // Create a new human agent
    const user = await this.userModel.findById(userId).select('+walletPrivateKey');
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const isExternal = user.walletType === 'external' && user.externalWalletAddress;
    const walletAddress = isExternal ? user.externalWalletAddress : user.walletAddress;

    if (!walletAddress) {
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
      walletAddress,
      walletPrivateKey: isExternal ? null : user.walletPrivateKey,
      chain: 'solana',
    });

    this.logger.log(`Created human agent "${user.username}" (${user.walletType}) for user ${userId}`);
    return agent;
  }

  async withdraw(userId: string, amount: number, to: string, token: string = 'USDC') {
    const user = await this.userModel.findById(userId).select('+walletPrivateKey');
    if (!user) throw new NotFoundException('User not found');

    const isExternal = user.walletType === 'external' && user.externalWalletAddress;

    if (isExternal) {
      // Non-custodial: can still withdraw from custodial wallet if it has balance
      if (!user.walletAddress || !user.walletPrivateKey) {
        throw new BadRequestException(
          'Your active wallet is an external wallet. Manage funds directly from your wallet app, or switch to custodial wallet to withdraw from your custodial balance.',
        );
      }
      // Fall through to withdraw from custodial wallet
    }

    if (!user.walletAddress || !user.walletPrivateKey) {
      throw new BadRequestException('User does not have a custodial wallet');
    }

    if (token === 'SOL') {
      throw new BadRequestException('SOL withdrawals coming soon. Use ALPHA or USDC.');
    }

    if (token === 'USDC' && amount < 10) {
      throw new BadRequestException('Minimum USDC withdrawal is 10 USDC.');
    }

    const chain = 'solana';
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

  /**
   * Build a partially-signed withdraw transaction for external wallet users.
   * Platform signs as fee payer, user signs with their wallet on the frontend.
   */
  async buildWithdraw(userId: string, amount: number, to: string, token: string = 'USDC') {
    const user = await this.userModel.findById(userId);
    if (!user) throw new NotFoundException('User not found');

    if (user.walletType !== 'external' || !user.externalWalletAddress) {
      throw new BadRequestException('This endpoint is for external wallet users only. Use POST /play/withdraw instead.');
    }

    if (token === 'SOL') {
      throw new BadRequestException('SOL withdrawals coming soon. Use ALPHA or USDC.');
    }

    const chain = 'solana';
    const balanceStr = await this.settlementRouter.getAgentTokenBalance(chain, user.externalWalletAddress, token);
    const balance = parseFloat(balanceStr);
    if (balance < amount) {
      throw new BadRequestException(`Insufficient balance: you have ${balance.toFixed(2)} ${token} but tried to withdraw ${amount}`);
    }

    const decimals = this.settlementRouter.getTokenDecimals(chain, token);
    const amountAtomic = BigInt(Math.round(amount * 10 ** decimals));

    const result = await this.settlementRouter.buildPartiallySignedTransfer(
      chain, user.externalWalletAddress, to, amountAtomic, token,
    );

    if (!result) {
      throw new BadRequestException('Failed to build transaction. Settlement service may not be configured.');
    }

    this.logger.log(`Built withdraw tx: user=${userId}, amount=${amount} ${token}, to=${to}`);
    return { transaction: result.transaction, blockhash: result.blockhash, amount, to, token, chain };
  }
}
