import { Controller, Post, Get, Body, UseGuards, HttpCode } from '@nestjs/common';
import { IsString, IsNumber, Min, Max, IsIn, IsOptional } from 'class-validator';
import { PlayService } from './play.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthPayload } from '../common/types';
import { MIN_STAKE, MAX_STAKE } from '../common/constants/game.constants';

class JoinDto {
  @IsOptional()
  @IsString()
  gameType?: string;

  @IsOptional()
  @IsNumber()
  stakeAmount?: number;

  @IsOptional()
  @IsString()
  token?: string;
}

class WithdrawDto {
  @IsNumber()
  @Min(0.001)
  amount: number;

  @IsString()
  to: string;

  @IsOptional()
  @IsString()
  token?: string;
}

class TestMatchDto {
  @IsString()
  gameType: string;
}

class MoveDto {
  @IsString()
  matchId: string;

  move: unknown;
}

@Controller('play')
@UseGuards(JwtAuthGuard)
export class PlayController {
  constructor(private readonly playService: PlayService) {}

  @Post('join')
  @HttpCode(201)
  async join(@CurrentUser() user: AuthPayload, @Body() dto: JoinDto) {
    return this.playService.joinQueue(user.userId, dto.gameType, dto.stakeAmount, dto.token);
  }

  @Post('cancel')
  async cancel(@CurrentUser() user: AuthPayload) {
    return this.playService.cancelQueue(user.userId);
  }

  @Get('status')
  async status(@CurrentUser() user: AuthPayload) {
    return this.playService.getStatus(user.userId);
  }

  @Get('agent')
  async getAgent(@CurrentUser() user: AuthPayload) {
    const agent = await this.playService.getOrCreateHumanAgent(user.userId);
    return { agentId: agent._id.toString(), walletAddress: agent.walletAddress };
  }

  @Get('balance')
  async balance(@CurrentUser() user: AuthPayload) {
    return this.playService.getBalance(user.userId);
  }

  @Post('withdraw')
  async withdraw(@CurrentUser() user: AuthPayload, @Body() dto: WithdrawDto) {
    return this.playService.withdraw(user.userId, dto.amount, dto.to, dto.token);
  }

  @Post('build-withdraw')
  async buildWithdraw(@CurrentUser() user: AuthPayload, @Body() dto: WithdrawDto) {
    return this.playService.buildWithdraw(user.userId, dto.amount, dto.to, dto.token);
  }

  @Post('move')
  async move(@CurrentUser() user: AuthPayload, @Body() dto: MoveDto) {
    return this.playService.submitMove(user.userId, dto.matchId, dto.move);
  }

  @Post('test-match')
  @HttpCode(201)
  async testMatch(@CurrentUser() user: AuthPayload, @Body() dto: TestMatchDto) {
    return this.playService.createTestMatch(user.userId, dto.gameType);
  }
}
