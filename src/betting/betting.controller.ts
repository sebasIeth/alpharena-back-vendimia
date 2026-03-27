import {
  Controller, Get, Post, Body, Param, UseGuards, HttpCode,
} from '@nestjs/common';
import { IsString, IsNumber, Min, IsOptional } from 'class-validator';
import { BettingService } from './betting.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthPayload } from '../common/types';

class PlaceBetDto {
  @IsString() matchId: string;
  @IsString() onAgentId: string;
  @IsNumber() @Min(0.01) amount: number;
  @IsOptional() @IsString() x402TxSignature?: string;
}

class ClaimBetDto {
  @IsString() matchId: string;
}

@Controller('betting')
export class BettingController {
  constructor(private readonly service: BettingService) {}

  /** Public — get betting contract addresses (stub) */
  @Get('contracts')
  getContracts() {
    return { chain: 'bnb', token: 'USDC' };
  }

  /** Public — get full betting info for a match */
  @Get(':matchId/info')
  async getBettingInfo(@Param('matchId') matchId: string) {
    return this.service.getBettingInfo(matchId);
  }

  /** Public — get betting pool for a match */
  @Get(':matchId/pool')
  async getBettingPool(@Param('matchId') matchId: string) {
    return this.service.getBettingPool(matchId);
  }

  /** Auth — get my bets for a specific match */
  @Get('my-bets/:matchId')
  @UseGuards(JwtAuthGuard)
  async getMyBets(
    @CurrentUser() user: AuthPayload,
    @Param('matchId') matchId: string,
  ) {
    return this.service.getMyBets(user.userId, matchId);
  }

  /** Auth — get all my pending claims */
  @Get('my-pending-claims')
  @UseGuards(JwtAuthGuard)
  async getMyPendingClaims(@CurrentUser() user: AuthPayload) {
    return this.service.getMyPendingClaims(user.userId);
  }

  /** Auth — place a bet */
  @Post('place')
  @UseGuards(JwtAuthGuard)
  @HttpCode(201)
  async placeBet(
    @CurrentUser() user: AuthPayload,
    @Body() dto: PlaceBetDto,
  ) {
    return this.service.placeBet(user.userId, dto.matchId, dto.onAgentId, dto.amount, dto.x402TxSignature);
  }

  /** Auth — claim bet winnings/refund */
  @Post('claim')
  @UseGuards(JwtAuthGuard)
  async claimBet(
    @CurrentUser() user: AuthPayload,
    @Body() dto: ClaimBetDto,
  ) {
    return this.service.claimBet(user.userId, dto.matchId);
  }
}
