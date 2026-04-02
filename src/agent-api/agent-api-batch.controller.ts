import { Controller, Post, Body, HttpCode } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { SkipThrottle } from '@nestjs/throttler';
import { createHash } from 'crypto';
import { Agent } from '../database/schemas';
import { AgentApiService } from './agent-api.service';
import { HeartbeatService } from './heartbeat.service';
import { BatchRegisterDto, BatchHeartbeatDto, BatchMoveDto } from './dto/batch.dto';
import { SubmitMoveDto } from './dto/move.dto';

@Controller('v1/batch')
@SkipThrottle()
export class AgentApiBatchController {
  constructor(
    @InjectModel(Agent.name) private readonly agentModel: Model<Agent>,
    private readonly agentApiService: AgentApiService,
    private readonly heartbeatService: HeartbeatService,
  ) {}

  @Post('register')
  async batchRegister(@Body() dto: BatchRegisterDto) {
    const results: Record<string, unknown>[] = [];
    for (const entry of dto.agents) {
      try {
        const result = await this.agentApiService.registerAgent(entry);
        results.push({ success: true, ...result });
      } catch (err) {
        results.push({
          success: false,
          name: entry.name,
          error: err instanceof Error ? err.message : 'Registration failed',
        });
      }
    }
    return { results };
  }

  @Post('heartbeat')
  @HttpCode(200)
  async batchHeartbeat(@Body() dto: BatchHeartbeatDto) {
    const apiKeys = dto.agents.map((a) => a.apiKey);
    return this.heartbeatService.batchHeartbeat(apiKeys);
  }

  @Post('moves')
  @HttpCode(200)
  async batchMoves(@Body() dto: BatchMoveDto) {
    const results: Record<string, unknown>[] = [];

    for (const entry of dto.moves) {
      try {
        const hash = createHash('sha256').update(entry.apiKey).digest('hex');
        const agent = await this.agentModel.findOne({ apiKeyHash: hash });

        if (!agent) {
          results.push({
            success: false,
            matchId: entry.matchId,
            error: 'Invalid API key',
          });
          continue;
        }

        const moveDto = {
          move: entry.move,
          from: entry.from,
          to: entry.to,
          promotion: entry.promotion,
          row: entry.row,
          col: entry.col,
          action: entry.action,
          amount: entry.amount,
        };

        await this.agentApiService.submitMove(agent, entry.matchId, moveDto as SubmitMoveDto);
        results.push({ success: true, matchId: entry.matchId });
      } catch (err) {
        results.push({
          success: false,
          matchId: entry.matchId,
          error: err instanceof Error ? err.message : 'Move failed',
        });
      }
    }

    return { results };
  }
}
