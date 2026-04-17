import { Controller, Post, Get, Body, Param, Query, UseGuards, BadRequestException, ForbiddenException, NotFoundException, HttpCode, InternalServerErrorException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { MatchmakingService } from './matchmaking.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthPayload } from '../common/types';
import { Agent, Match, User } from '../database/schemas';
import { IsString, MinLength, IsNumber, Min, Max, IsIn, IsOptional } from 'class-validator';
import { MIN_STAKE, MAX_STAKE } from '../common/constants/game.constants';
import { SettlementRouterService } from '../settlement/settlement-router.service';
import { X402PaymentStore } from '../settlement/x402-payment-store.service';
import { ConfigService } from '../common/config/config.service';

class JoinQueueDto {
  @IsString() @MinLength(1) agentId: string;
  @IsOptional() @IsNumber() stakeAmount?: number;
  @IsOptional() @IsString() gameType?: string;
  @IsOptional() @IsIn(['ALPHA', 'USDC']) token?: string;
}

class CancelQueueDto {
  @IsString() @MinLength(1) agentId: string;
}

@Controller('matchmaking')
@UseGuards(JwtAuthGuard)
export class MatchmakingController {
  constructor(
    private readonly matchmakingService: MatchmakingService,
    @InjectModel(Agent.name) private readonly agentModel: Model<Agent>,
    @InjectModel(Match.name) private readonly matchModel: Model<Match>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly settlementRouter: SettlementRouterService,
    private readonly x402PaymentStore: X402PaymentStore,
    private readonly configService: ConfigService,
  ) {}

  @Post('join')
  @HttpCode(201)
  async join(@CurrentUser() user: AuthPayload, @Body() dto: JoinQueueDto) {
    const agent = await this.agentModel.findById(dto.agentId);
    if (!agent) throw new NotFoundException('Agent not found');
    if (agent.userId && agent.userId.toString() !== user.userId) throw new ForbiddenException('You do not own this agent');
    if (agent.status !== 'idle') throw new BadRequestException(`Agent cannot join queue because its status is "${agent.status}". It must be "idle".`);
    if (!agent.walletAddress) throw new BadRequestException('Agent does not have a wallet. Please recreate the agent.');

    // Verify agent wallet has on-chain balance
    const matchToken = dto.token || 'USDC';
    const chain = agent.chain || this.configService.chainDefault;

    // Auto-calculate stake: $1 USD equivalent
    let stakeAmount = dto.stakeAmount ?? 1;
    if (matchToken === 'ALPHA') {
      const alphaPrice = await this.settlementRouter.getAlphaPriceUsd();
      if (alphaPrice && alphaPrice > 0) {
        stakeAmount = Math.ceil(1 / alphaPrice);
      }
    } else {
      stakeAmount = 1; // 1 USDC = $1
    }

    if (stakeAmount > 0) {
      // Check if agent uses an external wallet (non-custodial)
      const isNonCustodial = !agent.walletPrivateKey && agent.type === 'human';

      if (matchToken === 'USDC' || isNonCustodial) {
        // USDC always requires x402 pre-payment
        // Non-custodial agents also require x402 pre-payment for ANY token
        const x402Payment = this.x402PaymentStore.getPayment(dto.agentId);
        if (!x402Payment) {
          throw new BadRequestException(
            isNonCustodial
              ? `External wallet matches require x402 pre-payment. POST to /x402/stake first with token=${matchToken}.`
              : 'USDC matches require x402 payment. POST to /x402/stake first, pay the USDC, then join the queue.',
          );
        }
        if (x402Payment.amount < stakeAmount) {
          throw new BadRequestException(
            `x402 payment insufficient: paid ${x402Payment.amount} ${matchToken} but stake requires ${stakeAmount}`,
          );
        }
      } else {
        // ALPHA with custodial agent: direct balance check
        const tokenBalance = await this.settlementRouter.getAgentTokenBalance(chain, agent.walletAddress, matchToken);
        if (parseFloat(tokenBalance) < stakeAmount) {
          throw new BadRequestException(
            `Insufficient ${matchToken} balance. Agent has ${tokenBalance} but needs ${stakeAmount}. Deposit to ${agent.walletAddress}`,
          );
        }
      }
    }

    try {
      // Join queue first, then update agent status to avoid desync
      const queueGameType = dto.gameType || 'any';
      await this.matchmakingService.joinQueue(dto.agentId, user.userId, agent.eloRating, stakeAmount, queueGameType, agent.type, matchToken);
      agent.status = 'queued';
      await agent.save();
      return { message: 'Successfully joined the matchmaking queue', agentId: dto.agentId, gameType: queueGameType, stakeAmount, token: matchToken };
    } catch (err) {
      // If queue join succeeded but status update failed, remove from queue
      try { await this.matchmakingService.leaveQueue(dto.agentId); } catch {}
      agent.status = 'idle';
      try { await agent.save(); } catch {}
      throw new InternalServerErrorException(err instanceof Error ? err.message : 'Failed to join queue');
    }
  }

  @Post('cancel')
  async cancel(@CurrentUser() user: AuthPayload, @Body() dto: CancelQueueDto) {
    const agent = await this.agentModel.findById(dto.agentId);
    if (!agent) throw new NotFoundException('Agent not found');
    if (agent.userId && agent.userId.toString() !== user.userId) throw new ForbiddenException('You do not own this agent');
    if (agent.status !== 'queued') throw new BadRequestException(`Agent is not in the queue (current status: "${agent.status}")`);

    await this.matchmakingService.leaveQueue(dto.agentId);
    agent.status = 'idle';
    await agent.save();
    return { message: 'Successfully left the matchmaking queue', agentId: dto.agentId };
  }

  @Get('status/:agentId')
  async status(@CurrentUser() user: AuthPayload, @Param('agentId') agentId: string) {
    const agent = await this.agentModel.findById(agentId);
    if (!agent) throw new NotFoundException('Agent not found');
    if (agent.userId && agent.userId.toString() !== user.userId) throw new ForbiddenException('You do not own this agent');

    const queueEntry = await this.matchmakingService.getQueueStatus(agentId);

    if (!queueEntry) {
      // Agent is not in queue — check if it's in an active match
      if (agent.status === 'in_match') {
        const activeMatch = await this.matchModel.findOne({
          $or: [{ 'agents.a.agentId': agentId }, { 'agents.b.agentId': agentId }],
          status: { $in: ['starting', 'active'] },
        }).select('_id gameType status').lean();

        if (activeMatch) {
          return { inQueue: false, agentId, agentStatus: agent.status, matchId: activeMatch._id.toString(), matchStatus: activeMatch.status, gameType: activeMatch.gameType };
        }
      }
      return { inQueue: false, agentId, agentStatus: agent.status };
    }

    return {
      inQueue: true, agentId, agentStatus: agent.status,
      queueEntry: { gameType: queueEntry.gameType, stakeAmount: queueEntry.stakeAmount, eloRating: queueEntry.eloRating, status: queueEntry.status, joinedAt: queueEntry.joinedAt },
    };
  }

  @Get('queue-size')
  async queueSize(@Query('gameType') gameType?: string) {
    const size = await this.matchmakingService.getQueueSize(gameType);
    return { queueSize: size, gameType: gameType ?? 'all' };
  }

  @Get('queue')
  async queue(@Query('gameType') gameType?: string) {
    const entries = this.matchmakingService.getQueueEntries(gameType);
    return {
      queue: entries.map((e) => ({
        agentId: e.agentId,
        eloRating: e.eloRating,
        gameType: e.gameType,
        stakeAmount: e.stakeAmount,
        status: e.status,
        joinedAt: e.joinedAt,
      })),
      total: entries.length,
      gameType: gameType ?? 'all',
    };
  }

  @Get('playing-count')
  async playingCount() {
    const count = await this.agentModel.countDocuments({ status: 'in_match' });
    return { playingCount: count };
  }

}
