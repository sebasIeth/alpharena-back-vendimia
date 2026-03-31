import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as crypto from 'crypto';
import { Bet, Match, User } from '../database/schemas';
import { EventBusService } from '../orchestrator/event-bus.service';
import { SolanaSettlementService } from '../settlement/solana-settlement.service';
import { X402VerifierService } from '../settlement/x402-verifier.service';
import { X402PaymentStore } from '../settlement/x402-payment-store.service';
import { MatchEndedEvent } from '../common/types';

const BETTING_FEE_PERCENT = 5;
const MIN_BET = 0.01;

export interface AgentPool {
  agentId: string;
  totalBets: number;
  betCount: number;
  percent: number;
  odds: number;
}

interface PoolResult {
  totalPool: number;
  noContest: boolean;
  agents: AgentPool[];
  totalBetsA: number;
  totalBetsB: number;
}

interface MatchLike {
  _id: { toString(): string };
  agents: Record<string, { agentId: { toString(): string }; name: string; eloAtStart?: number; userId?: { toString(): string } }>;
  status: string;
  gameType: string;
  stakeAmount?: number;
  result?: { winnerId?: { toString(): string } };
  endedAt?: Date;
  updatedAt?: Date;
  createdAt?: Date;
}

@Injectable()
export class BettingService implements OnModuleInit {
  private readonly logger = new Logger(BettingService.name);

  constructor(
    @InjectModel(Bet.name) private readonly betModel: Model<Bet>,
    @InjectModel(Match.name) private readonly matchModel: Model<Match>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly eventBus: EventBusService,
    private readonly solanaSettlement: SolanaSettlementService,
    private readonly x402Verifier: X402VerifierService,
    private readonly x402PaymentStore: X402PaymentStore,
  ) {}

  onModuleInit() {
    this.eventBus.on('match:ended', (data: MatchEndedEvent) => {
      this.handleMatchSettlement(data).catch((err) => {
        this.logger.error(`Failed to settle bets for match ${data.matchId}: ${err.message}`);
      });
    });
  }

  /* ────────────────────────────────────────────────────────
     PLACE BET — requires x402 USDC payment first
     ──────────────────────────────────────────────────────── */
  async placeBet(userId: string, matchId: string, onAgentId: string, amount: number, x402TxSignature?: string) {
    if (amount < MIN_BET) {
      throw new BadRequestException(`Minimum bet is ${MIN_BET}`);
    }

    const match = await this.matchModel.findById(matchId).lean();
    if (!match) throw new NotFoundException('Match not found');

    if (!['pending', 'starting', 'active'].includes(match.status)) {
      throw new BadRequestException('Betting is closed for this match');
    }

    const agentIds = this.getMatchAgentIds(match);
    if (!agentIds.includes(onAgentId)) {
      throw new BadRequestException('Agent is not a participant in this match');
    }

    const user = await this.userModel.findById(userId);
    if (!user) throw new NotFoundException('User not found');

    const isExternal = user.walletType === 'external' && user.externalWalletAddress;
    const activeWallet = isExternal ? user.externalWalletAddress! : user.walletAddress;
    if (!activeWallet) throw new BadRequestException('No wallet linked to your account');

    // Spectator bets are always in USDC
    const platformWallet = this.solanaSettlement.getPlatformWalletAddress();
    if (!platformWallet) {
      throw new BadRequestException('Settlement not configured');
    }

    let betTxHash: string | null = null;

    if (x402TxSignature) {
      // Replay protection: check if tx was already used
      if (this.x402PaymentStore.isTxUsed(x402TxSignature)) {
        throw new BadRequestException('This transaction has already been used for a payment.');
      }

      // x402 flow: verify on-chain payment (used by external wallets and API agents)
      const decimals = this.solanaSettlement.getTokenDecimals('USDC');
      const expectedAmount = BigInt(Math.round(amount * 10 ** decimals));
      const verification = await this.x402Verifier.verifyStakePayment(x402TxSignature, expectedAmount, platformWallet);
      if (!verification.valid) {
        throw new BadRequestException(`Payment verification failed: ${verification.error}`);
      }

      // Mark tx as used to prevent replay
      this.x402PaymentStore.markTxUsed(x402TxSignature);
      betTxHash = x402TxSignature;
    } else if (isExternal) {
      // External wallet without x402 tx — they must pre-sign
      throw new BadRequestException(
        'External wallet bets require a signed transaction. Use the x402 flow or provide x402TxSignature.',
      );
    } else {
      // Custodial flow: transfer USDC from user wallet to platform
      const userDoc = await this.userModel.findById(userId).select('+walletPrivateKey');
      if (!userDoc?.walletPrivateKey) throw new BadRequestException('User wallet not configured');

      // Check USDC balance
      const usdcBalance = await this.solanaSettlement.getAgentTokenBalance(userDoc.walletAddress!, 'USDC');
      if (parseFloat(usdcBalance) < amount) {
        throw new BadRequestException(`Insufficient USDC balance: you have ${usdcBalance} but tried to bet ${amount}`);
      }

      const { decrypt } = require('../common/crypto.util');
      const privKey = decrypt(userDoc.walletPrivateKey);
      const decimals = this.solanaSettlement.getTokenDecimals('USDC');
      const amountAtomic = BigInt(Math.round(amount * 10 ** decimals));
      betTxHash = await this.solanaSettlement.transferTokenFromAgent(privKey, platformWallet, amountAtomic, 'USDC');
      if (!betTxHash) throw new BadRequestException('USDC transfer failed');
    }

    // Find which side the betted agent is on
    const agentSides = Object.entries(match.agents);
    const onAgentA = agentSides.find(([, v]) => v.agentId?.toString() === onAgentId)?.[0] === 'a';

    const bet = await this.betModel.create({
      matchId,
      userId: new Types.ObjectId(userId),
      walletAddress: activeWallet,
      onAgentId,
      onAgentA,
      amount,
      txHash: betTxHash,
      chain: 'solana',
      token: 'USDC',
    });

    this.logger.log(`Bet placed: user=${userId}, match=${matchId}, onAgent=${onAgentId}, amount=${amount} USDC, txHash=${betTxHash}`);

    return {
      txHash: betTxHash,
      matchId,
      onAgentId,
      amount,
      chain: 'solana',
      token: 'USDC',
    };
  }

  /* ────────────────────────────────────────────────────────
     GET BETTING INFO
     ──────────────────────────────────────────────────────── */
  async getBettingInfo(matchId: string) {
    const match = await this.matchModel.findById(matchId).lean();
    if (!match) throw new NotFoundException('Match not found');

    const pool = await this.calculatePool(matchId, match);
    const isOpen = ['pending', 'starting', 'active'].includes(match.status);
    const isSettled = match.status === 'completed';
    const isRefunded = match.status === 'cancelled';

    let onChainState: 'none' | 'escrowed' | 'settled' | 'refunded' = 'escrowed';
    if (isSettled) onChainState = 'settled';
    else if (isRefunded) onChainState = 'refunded';

    let winner: { side: string; agentName: string; agentId: string } | null = null;
    if (match.result?.winnerId) {
      const winningSide = match.result.winnerId.toString() === match.agents.a.agentId.toString() ? 'a' : 'b';
      winner = {
        side: winningSide,
        agentName: match.agents[winningSide].name,
        agentId: match.agents[winningSide].agentId.toString(),
      };
    }

    return {
      matchId,
      chain: 'solana',
      gameType: match.gameType,
      status: match.status,
      stakeAmount: match.stakeAmount,
      agents: {
        a: {
          agentId: match.agents.a.agentId.toString(),
          name: match.agents.a.name,
          eloAtStart: match.agents.a.eloAtStart,
        },
        b: {
          agentId: match.agents.b.agentId.toString(),
          name: match.agents.b.name,
          eloAtStart: match.agents.b.eloAtStart,
        },
      },
      betting: {
        open: isOpen,
        onChainState,
        pool: {
          totalPool: pool.totalPool,
          noContest: pool.noContest,
          agents: pool.agents,
          totalBetsA: pool.totalBetsA,
          totalBetsB: pool.totalBetsB,
          percentA: pool.agents.find((a) => a.agentId === match.agents.a.agentId.toString())?.percent ?? 50,
          percentB: pool.agents.find((a) => a.agentId === match.agents.b.agentId.toString())?.percent ?? 50,
        },
        odds: Object.fromEntries(pool.agents.map((a) => [a.agentId, a.odds])),
        feePercent: BETTING_FEE_PERCENT,
      },
      winner,
    };
  }

  /* ────────────────────────────────────────────────────────
     GET BETTING POOL
     ──────────────────────────────────────────────────────── */
  async getBettingPool(matchId: string) {
    const match = await this.matchModel.findById(matchId).lean();
    if (!match) throw new NotFoundException('Match not found');

    const pool = await this.calculatePool(matchId, match);
    const isOpen = ['pending', 'starting', 'active'].includes(match.status);

    return {
      matchId,
      chain: 'solana',
      status: match.status,
      bettingOpen: isOpen,
      pool: {
        totalPool: pool.totalPool,
        noContest: pool.noContest,
        agents: pool.agents,
        totalBetsA: pool.totalBetsA,
        totalBetsB: pool.totalBetsB,
      },
    };
  }

  /* ────────────────────────────────────────────────────────
     GET MY BETS
     ──────────────────────────────────────────────────────── */
  async getMyBets(userId: string, matchId: string) {
    const match = await this.matchModel.findById(matchId).lean();
    if (!match) throw new NotFoundException('Match not found');

    const userBets = await this.betModel.find({
      matchId,
      userId: new Types.ObjectId(userId),
    }).lean();

    const betsByAgent: Record<string, number> = {};
    for (const bet of userBets) {
      const agentId = bet.onAgentId || (bet.onAgentA ? match.agents.a?.agentId?.toString() : match.agents.b?.agentId?.toString()) || '';
      betsByAgent[agentId] = (betsByAgent[agentId] || 0) + bet.amount;
    }

    const total = Object.values(betsByAgent).reduce((s, v) => s + v, 0);
    const claimed = userBets.length > 0 && userBets.every((b) => b.claimed);

    const pool = await this.calculatePool(matchId, match);
    const netMultiplier = 1 - BETTING_FEE_PERCENT / 100;

    const potential: Record<string, number> = {};
    for (const ap of pool.agents) {
      const userBetOnThis = betsByAgent[ap.agentId] || 0;
      potential[ap.agentId] = ap.totalBets > 0 && userBetOnThis > 0
        ? (userBetOnThis / ap.totalBets) * pool.totalPool * netMultiplier
        : 0;
    }

    let outcome: 'won' | 'lost' | 'refund' | 'pending' | 'no_bet' = 'no_bet';
    let winnings = 0;

    if (total === 0) {
      outcome = 'no_bet';
    } else if (match.status === 'cancelled') {
      outcome = 'refund';
      winnings = total;
    } else if (match.status === 'completed' && match.result?.winnerId) {
      const winnerId = match.result.winnerId.toString();
      const userBetOnWinner = (betsByAgent[winnerId] || 0) > 0;
      outcome = userBetOnWinner ? 'won' : 'lost';
      if (userBetOnWinner) winnings = potential[winnerId] || 0;
    } else if (match.status === 'completed' && !match.result?.winnerId) {
      outcome = 'refund';
      winnings = total * (1 - BETTING_FEE_PERCENT / 100);
    } else {
      outcome = 'pending';
    }

    const canClaim = (outcome === 'won' || outcome === 'refund') && !claimed && total > 0;
    const user = await this.userModel.findById(userId).lean();
    const isExt = user?.walletType === 'external' && user?.externalWalletAddress;

    return {
      matchId,
      chain: 'solana',
      walletAddress: (isExt ? user?.externalWalletAddress : user?.walletAddress) || '',
      bets: {
        byAgent: betsByAgent,
        total: total.toFixed(2),
        claimed,
        onA: (betsByAgent[match.agents.a.agentId.toString()] || 0).toFixed(2),
        onB: (betsByAgent[match.agents.b.agentId.toString()] || 0).toFixed(2),
      },
      potential,
      outcome,
      winnings,
      canClaim,
    };
  }

  /* ────────────────────────────────────────────────────────
     CLAIM BET — pays out in USDC on Solana
     ──────────────────────────────────────────────────────── */
  async claimBet(userId: string, matchId: string) {
    const match = await this.matchModel.findById(matchId).lean();
    if (!match) throw new NotFoundException('Match not found');

    if (!['completed', 'cancelled'].includes(match.status)) {
      throw new BadRequestException('Match is not yet settled');
    }

    // Atomic claim: mark as claimed FIRST to prevent double-claim race condition
    const claimTag = `claim-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const claimResult = await this.betModel.updateMany(
      { matchId, userId: new Types.ObjectId(userId), claimed: false },
      { claimed: true, claimTag },
    );

    if (claimResult.modifiedCount === 0) {
      throw new BadRequestException('No unclaimed bets found');
    }

    // Fetch the bets we just claimed
    const userBets = await this.betModel.find({
      matchId,
      userId: new Types.ObjectId(userId),
      claimTag,
    });

    if (userBets.length === 0) {
      throw new BadRequestException('No unclaimed bets found');
    }

    const betsByAgent: Record<string, number> = {};
    for (const bet of userBets) {
      const agentId = bet.onAgentId || (bet.onAgentA ? match.agents.a?.agentId?.toString() : match.agents.b?.agentId?.toString()) || '';
      betsByAgent[agentId] = (betsByAgent[agentId] || 0) + bet.amount;
    }
    const total = Object.values(betsByAgent).reduce((s, v) => s + v, 0);

    let payout = 0;

    if (match.status === 'cancelled') {
      payout = total;
    } else if (match.status === 'completed' && !match.result?.winnerId) {
      payout = total * (1 - BETTING_FEE_PERCENT / 100);
    } else if (match.result?.winnerId) {
      const winnerId = match.result.winnerId.toString();
      const userBetOnWinner = (betsByAgent[winnerId] || 0) > 0;

      if (userBetOnWinner) {
        const pool = await this.calculatePool(matchId, match);
        const winnerPool = pool.agents.find((a) => a.agentId === winnerId);
        const userWinnerBet = betsByAgent[winnerId];
        payout = winnerPool && winnerPool.totalBets > 0
          ? (userWinnerBet / winnerPool.totalBets) * pool.totalPool * (1 - BETTING_FEE_PERCENT / 100)
          : 0;
      }
    }

    let txHash: string | null = null;
    let feeTxHash: string | null = null;

    if (payout > 0) {
      const user = await this.userModel.findById(userId);
      const isExt = user?.walletType === 'external' && user?.externalWalletAddress;
      const payoutWallet = isExt ? user.externalWalletAddress! : user?.walletAddress;

      if (payoutWallet) {
        const decimals = this.solanaSettlement.getTokenDecimals('USDC');
        const payoutAmount = BigInt(Math.round(payout * 10 ** decimals));

        // Pay winner in USDC to their active wallet
        txHash = await this.solanaSettlement.transferTokenFromPlatform(
          payoutWallet,
          payoutAmount,
          'USDC',
        );

        // Send fee to fee wallet
        const feeAmount = BigInt(Math.round((total - payout) * 10 ** decimals));
        if (feeAmount > BigInt(0)) {
          feeTxHash = await this.solanaSettlement.sendFeeToFeeWallet(feeAmount, 'USDC').catch((e) => {
            this.logger.error(`Failed to send betting fee: ${e.message}`);
            return null;
          });
        }
      }
    }

    // Update with tx hashes (already marked claimed atomically above)
    await this.betModel.updateMany(
      { matchId, userId: new Types.ObjectId(userId), claimTag },
      { claimTxHash: txHash, feeTxHash },
    );

    this.logger.log(`Bet claimed: user=${userId}, match=${matchId}, payout=${payout}, txHash=${txHash}, feeTxHash=${feeTxHash}`);

    return {
      txHash: txHash || `claim-${matchId}-${userId}`,
      matchId,
      chain: 'solana',
    };
  }

  /* ────────────────────────────────────────────────────────
     GET MY PENDING CLAIMS
     ──────────────────────────────────────────────────────── */
  async getMyPendingClaims(userId: string) {
    const unclaimedBets = await this.betModel.find({
      userId: new Types.ObjectId(userId),
      claimed: false,
    }).lean();

    if (unclaimedBets.length === 0) return { claims: [] };

    const matchIds = [...new Set(unclaimedBets.map((b) => b.matchId))];

    const matches = await this.matchModel.find({
      _id: { $in: matchIds },
      status: { $in: ['completed', 'cancelled'] },
    }).lean();

    const claims: Array<{
      matchId: string;
      chain: string;
      gameType: string;
      outcome: 'won' | 'refund';
      betsByAgent: Record<string, number>;
      winnings: number;
      endedAt: string;
    }> = [];

    for (const match of matches) {
      const mId = match._id.toString();
      const betsForMatch = unclaimedBets.filter((b) => b.matchId === mId);

      const betsByAgent: Record<string, number> = {};
      for (const bet of betsForMatch) {
        const agentId = bet.onAgentId || (bet.onAgentA ? match.agents.a?.agentId?.toString() : match.agents.b?.agentId?.toString()) || '';
        betsByAgent[agentId] = (betsByAgent[agentId] || 0) + bet.amount;
      }
      const total = Object.values(betsByAgent).reduce((s, v) => s + v, 0);

      let outcome: 'won' | 'refund' = 'refund';
      let winnings = match.status === 'cancelled' ? total : total * (1 - BETTING_FEE_PERCENT / 100);

      if (match.status === 'completed' && match.result?.winnerId) {
        const winnerId = match.result.winnerId.toString();
        const userBetOnWinner = (betsByAgent[winnerId] || 0) > 0;

        if (userBetOnWinner) {
          outcome = 'won';
          const pool = await this.calculatePool(mId, match);
          const winnerPool = pool.agents.find((a) => a.agentId === winnerId);
          const userWinnerBet = betsByAgent[winnerId];
          winnings = winnerPool && winnerPool.totalBets > 0
            ? (userWinnerBet / winnerPool.totalBets) * pool.totalPool * (1 - BETTING_FEE_PERCENT / 100)
            : 0;
        } else {
          continue;
        }
      }

      claims.push({
        matchId: mId,
        chain: 'solana',
        gameType: match.gameType,
        outcome,
        betsByAgent,
        winnings,
        endedAt: (match.endedAt || match.updatedAt || match.createdAt).toISOString(),
      });
    }

    return { claims };
  }

  private getMatchAgentIds(match: MatchLike): string[] {
    if (!match.agents) return [];
    return Object.values(match.agents)
      .filter((a) => a?.agentId)
      .map((a) => a.agentId.toString());
  }

  private async calculatePool(matchId: string, match?: MatchLike): Promise<PoolResult> {
    const bets = await this.betModel.find({ matchId }).lean();

    const resolvedBets = bets.map((b) => ({
      ...b,
      resolvedAgentId: b.onAgentId || (match && b.onAgentA != null
        ? (b.onAgentA ? match.agents.a.agentId.toString() : match.agents.b.agentId.toString())
        : 'unknown'),
    }));

    const agentTotals = new Map<string, { total: number; count: number }>();
    for (const bet of resolvedBets) {
      const curr = agentTotals.get(bet.resolvedAgentId) || { total: 0, count: 0 };
      curr.total += bet.amount;
      curr.count += 1;
      agentTotals.set(bet.resolvedAgentId, curr);
    }

    if (match) {
      for (const id of this.getMatchAgentIds(match)) {
        if (!agentTotals.has(id)) agentTotals.set(id, { total: 0, count: 0 });
      }
    }

    const totalPool = resolvedBets.reduce((s, b) => s + b.amount, 0);
    const netMultiplier = 1 - BETTING_FEE_PERCENT / 100;
    const agentCount = agentTotals.size || 1;

    const agents: AgentPool[] = [];
    for (const [agentId, { total, count }] of agentTotals) {
      agents.push({
        agentId,
        totalBets: total,
        betCount: count,
        percent: totalPool > 0 ? Math.round((total / totalPool) * 100) : Math.round(100 / agentCount),
        odds: total > 0 ? (totalPool / total) * netMultiplier : 0,
      });
    }

    agents.sort((x, y) => y.totalBets - x.totalBets);

    const agentA = match ? match.agents.a.agentId.toString() : '';
    const agentB = match ? match.agents.b.agentId.toString() : '';

    return {
      totalPool,
      noContest: totalPool === 0,
      agents,
      totalBetsA: agents.find((a) => a.agentId === agentA)?.totalBets ?? 0,
      totalBetsB: agents.find((a) => a.agentId === agentB)?.totalBets ?? 0,
    };
  }

  private async handleMatchSettlement(event: MatchEndedEvent): Promise<void> {
    const betsCount = await this.betModel.countDocuments({ matchId: event.matchId });
    if (betsCount === 0) return;

    this.logger.log(`Match ${event.matchId} ended — ${betsCount} bets to settle`);
  }
}
