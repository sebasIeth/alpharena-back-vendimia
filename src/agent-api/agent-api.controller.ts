import {
  Controller, Post, Get, Body, Param, UseGuards, HttpCode, BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiKeyAuthGuard } from '../common/guards/api-key-auth.guard';
import { CurrentAgent } from '../common/decorators/current-agent.decorator';
import { Agent } from '../database/schemas';
import { SettlementRouterService } from '../settlement/settlement-router.service';
import { AgentApiService } from './agent-api.service';
import { HeartbeatService } from './heartbeat.service';
import { RegisterAgentDto } from './dto/register.dto';
import { JoinQueueDto } from './dto/queue.dto';
import { SubmitMoveDto } from './dto/move.dto';

@Controller('v1')
export class AgentApiController {
  constructor(
    @InjectModel(Agent.name) private readonly agentModel: Model<Agent>,
    private readonly agentApiService: AgentApiService,
    private readonly heartbeatService: HeartbeatService,
    private readonly settlementRouter: SettlementRouterService,
  ) {}

  @Post('register')
  @SkipThrottle()
  async register(@Body() dto: RegisterAgentDto) {
    return this.agentApiService.registerAgent(dto);
  }

  @Get('status')
  @UseGuards(ApiKeyAuthGuard)
  async status(@CurrentAgent() agent: Agent) {
    return this.agentApiService.getAgentStatus(agent);
  }

  /**
   * Link an unlinked agent to a user account.
   * The agent authenticates via API key and passes the userId to link to.
   */
  @Post('link')
  @UseGuards(ApiKeyAuthGuard)
  @HttpCode(200)
  async linkToUser(@CurrentAgent() agent: Agent, @Body() body: { userId: string }) {
    if (!body.userId) throw new BadRequestException('userId is required');
    const agentDoc = agent as any;
    if (agentDoc.userId) {
      throw new BadRequestException('Agent is already linked to a user. Unlink first or create a new agent.');
    }
    agentDoc.userId = new Types.ObjectId(body.userId);
    await agentDoc.save();
    return { message: 'Agent linked to user', agentId: agentDoc._id.toString(), userId: body.userId };
  }

  /**
   * Transfer tokens from agent wallet to any address.
   * Useful for x402 USDC payments — agent transfers USDC to platform, gets back the txSignature.
   */
  @Post('transfer')
  @UseGuards(ApiKeyAuthGuard)
  @HttpCode(200)
  async transfer(
    @CurrentAgent() agent: Agent,
    @Body() body: { to: string; amount: number; token?: string },
  ) {
    if (!body.to || !body.amount) throw new BadRequestException('to and amount are required');
    if (body.amount <= 0) throw new BadRequestException('amount must be > 0');
    if (!agent.walletAddress) throw new BadRequestException('Agent does not have a wallet');

    const { decrypt } = require('../common/crypto.util');
    const agentDoc = await this.agentModel.findById((agent as any)._id).select('+walletPrivateKey');
    if (!agentDoc?.walletPrivateKey) throw new BadRequestException('Agent wallet key not found');
    const privKey = decrypt(agentDoc.walletPrivateKey);
    const token = body.token || 'USDC';
    const chain = agentDoc.chain || 'bnb';

    const decimals = this.settlementRouter.getTokenDecimals(chain, token);
    const amountAtomic = BigInt(Math.round(body.amount * 10 ** decimals));

    const txHash = await this.settlementRouter.transferTokenFromAgent(chain, privKey, body.to, amountAtomic, token);
    if (!txHash) throw new BadRequestException('Transfer failed');

    return { txHash, from: agent.walletAddress, to: body.to, amount: body.amount, token };
  }

  @Post('queue/join')
  @UseGuards(ApiKeyAuthGuard)
  @HttpCode(200)
  async joinQueue(@CurrentAgent() agent: Agent, @Body() dto: JoinQueueDto) {
    return this.agentApiService.joinQueue(agent, dto);
  }

  @Post('queue/leave')
  @UseGuards(ApiKeyAuthGuard)
  @HttpCode(200)
  async leaveQueue(@CurrentAgent() agent: Agent) {
    return this.agentApiService.leaveQueue(agent);
  }

  @Post('heartbeat')
  @UseGuards(ApiKeyAuthGuard)
  @SkipThrottle()
  @HttpCode(200)
  async heartbeat(@CurrentAgent() agent: Agent) {
    return this.heartbeatService.heartbeat(agent);
  }

  @Get('games/:matchId')
  @UseGuards(ApiKeyAuthGuard)
  async getGameState(
    @CurrentAgent() agent: Agent,
    @Param('matchId') matchId: string,
  ) {
    return this.agentApiService.getGameState(agent, matchId);
  }

  @Post('games/:matchId/moves')
  @UseGuards(ApiKeyAuthGuard)
  @HttpCode(200)
  async submitMove(
    @CurrentAgent() agent: Agent,
    @Param('matchId') matchId: string,
    @Body() dto: SubmitMoveDto,
  ) {
    return this.agentApiService.submitMove(agent, matchId, dto);
  }

  @Get('wallet')
  @UseGuards(ApiKeyAuthGuard)
  async getWallet(@CurrentAgent() agent: Agent) {
    if (!agent.walletAddress) {
      throw new BadRequestException('Agent does not have a wallet');
    }

    const chain = (agent as any).chain || 'bnb';
    const [alpha, usdc, bnb] = await Promise.all([
      this.settlementRouter.getAgentTokenBalance(chain, agent.walletAddress, 'ALPHA').catch(() => '0'),
      this.settlementRouter.getAgentTokenBalance(chain, agent.walletAddress, 'USDC').catch(() => '0'),
      this.settlementRouter.getAgentNativeBalance(chain, agent.walletAddress).catch(() => '0'),
    ]);

    return {
      agentId: (agent as any)._id.toString(),
      walletAddress: agent.walletAddress,
      balances: { alpha, usdc, bnb },
      depositAddress: agent.walletAddress,
    };
  }
}
