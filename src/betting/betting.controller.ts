import {
  Controller, Get, Post, Body, Param, UseGuards, HttpCode, BadRequestException,
} from '@nestjs/common';
import { IsString, IsNumber, Min, IsOptional } from 'class-validator';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BettingService } from './betting.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthPayload } from '../common/types';
import { User } from '../database/schemas';
import { SolanaSettlementService } from '../settlement/solana-settlement.service';

class PlaceBetDto {
  @IsString() matchId: string;
  @IsString() onAgentId: string;
  @IsNumber() @Min(0.01) amount: number;
  @IsOptional() @IsString() x402TxSignature?: string;
}

class ClaimBetDto {
  @IsString() matchId: string;
}

class BuildBetDto {
  @IsNumber() @Min(0.01) amount: number;
}

@Controller('betting')
export class BettingController {
  constructor(
    private readonly service: BettingService,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly solanaSettlement: SolanaSettlementService,
  ) {}

  /** Public — get betting contract addresses (stub) */
  @Get('contracts')
  getContracts() {
    return { chain: 'solana', token: 'USDC' };
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

  /** Auth — build a partially-signed bet tx for external wallet users (gasless) */
  @Post('build-bet')
  @UseGuards(JwtAuthGuard)
  async buildBet(
    @CurrentUser() userAuth: AuthPayload,
    @Body() dto: BuildBetDto,
  ) {
    const user = await this.userModel.findById(userAuth.userId);
    if (!user) throw new BadRequestException('User not found');
    if (user.walletType !== 'external' || !user.externalWalletAddress) {
      throw new BadRequestException('This endpoint is for external wallet users. Use POST /betting/place directly.');
    }

    const platformWallet = this.solanaSettlement.getPlatformWalletAddress();
    if (!platformWallet) throw new BadRequestException('Settlement not configured');

    const decimals = this.solanaSettlement.getTokenDecimals('USDC');
    const amountAtomic = BigInt(Math.round(dto.amount * 10 ** decimals));

    const result = await this.solanaSettlement.buildPartiallySignedTransfer(
      user.externalWalletAddress, platformWallet, amountAtomic, 'USDC',
    );
    if (!result) throw new BadRequestException('Failed to build transaction');

    return { transaction: result.transaction, blockhash: result.blockhash, amount: dto.amount, token: 'USDC' };
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
