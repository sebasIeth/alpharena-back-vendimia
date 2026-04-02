import {
  Controller, Get, Param, Query, DefaultValuePipe, ParseIntPipe, NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { SkipThrottle } from '@nestjs/throttler';
import { Agent, Match } from '../database/schemas';
import { ActiveMatchesService } from '../orchestrator/active-matches.service';
import { LeaderboardService } from '../leaderboard/leaderboard.service';

@Controller('v1/public')
@SkipThrottle()
export class AgentApiPublicController {
  constructor(
    @InjectModel(Agent.name) private readonly agentModel: Model<Agent>,
    @InjectModel(Match.name) private readonly matchModel: Model<Match>,
    private readonly activeMatches: ActiveMatchesService,
    private readonly leaderboardService: LeaderboardService,
  ) {}

  @Get('stats')
  async getStats() {
    const [totalAgents, totalMatches, activeMatches, totalPlayers, earningsAgg] = await Promise.all([
      this.agentModel.countDocuments({ status: { $ne: 'disabled' } }),
      this.matchModel.countDocuments({ status: 'completed' }),
      this.activeMatches.size,
      this.agentModel.countDocuments({ 'stats.totalMatches': { $gt: 0 } }),
      this.matchModel.aggregate([
        { $match: { status: 'completed', 'result.winnerId': { $ne: null } } },
        {
          $group: {
            _id: null,
            total: {
              $sum: {
                $subtract: [
                  '$potAmount',
                  { $add: [{ $floor: { $multiply: ['$potAmount', 0.05] } }, '$stakeAmount'] },
                ],
              },
            },
          },
        },
      ]),
    ]);

    return {
      totalAgents,
      totalMatches,
      activeMatches,
      totalPlayers,
      totalEarningsUsdc: earningsAgg[0]?.total ?? 0,
    };
  }

  @Get('leaderboard')
  async getLeaderboard(
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('gameType') gameType?: string,
  ) {
    return this.leaderboardService.getAgentLeaderboard(limit, gameType);
  }

  @Get('featured-matches')
  async getFeaturedMatches() {
    const activeMatchIds = this.activeMatches.getAllMatchIds();

    if (activeMatchIds.length === 0) {
      return { matches: [] };
    }

    const matches = await this.matchModel.find({
      _id: { $in: activeMatchIds },
      status: 'active',
    })
      .select('agents gameType stakeAmount status createdAt moveCount scores')
      .limit(10)
      .lean();

    return {
      matches: matches.map((m: any) => ({
        matchId: m._id.toString(),
        gameType: m.gameType,
        stakeAmount: m.stakeAmount,
        status: m.status,
        moveCount: m.moveCount,
        scores: m.scores,
        agents: {
          a: { name: m.agents?.a?.name, agentId: m.agents?.a?.agentId },
          b: { name: m.agents?.b?.name, agentId: m.agents?.b?.agentId },
        },
        createdAt: m.createdAt,
      })),
    };
  }

  @Get('matches/:matchId')
  async getMatchDetail(@Param('matchId') matchId: string) {
    const match = await this.matchModel.findById(matchId)
      .select('-__v')
      .lean();

    if (!match) {
      throw new NotFoundException('Match not found');
    }

    return {
      matchId: match._id.toString(),
      gameType: match.gameType,
      status: match.status,
      stakeAmount: match.stakeAmount,
      potAmount: match.potAmount,
      moveCount: match.moveCount,
      scores: match.scores,
      agents: match.agents,
      result: match.result,
      chessState: match.chessState,
      currentBoard: match.currentBoard,
      createdAt: match.createdAt,
      startedAt: match.startedAt,
      endedAt: match.endedAt,
    };
  }

  @Get('players/:username')
  async getPlayerProfile(@Param('username') username: string) {
    const agents = await this.agentModel.find({ name: username, status: { $ne: 'disabled' } })
      .select('name eloRating stats gameTypes type status createdAt')
      .lean();

    if (agents.length === 0) {
      throw new NotFoundException('Player not found');
    }

    return {
      username,
      agents: agents.map((a: any) => ({
        agentId: a._id.toString(),
        name: a.name,
        eloRating: a.eloRating,
        stats: a.stats,
        gameTypes: a.gameTypes,
        type: a.type,
        status: a.status,
        createdAt: a.createdAt,
      })),
    };
  }

  @Get('players/:username/games')
  async getPlayerGames(
    @Param('username') username: string,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ) {
    const agents = await this.agentModel.find({ name: username })
      .select('_id')
      .lean();

    if (agents.length === 0) {
      throw new NotFoundException('Player not found');
    }

    const agentIds = agents.map((a: any) => a._id.toString());

    const orClauses = agentIds.flatMap((id) => [
      { 'agents.a.agentId': id },
      { 'agents.b.agentId': id },
    ]);

    const matches = await this.matchModel.find({
      $or: orClauses,
      status: 'completed',
    })
      .sort({ endedAt: -1 })
      .skip(offset)
      .limit(limit)
      .select('agents result stakeAmount gameType endedAt moveCount scores')
      .lean();

    return {
      games: matches.map((m: any) => ({
        matchId: m._id.toString(),
        gameType: m.gameType,
        stakeAmount: m.stakeAmount,
        moveCount: m.moveCount,
        scores: m.scores,
        agents: {
          a: { name: m.agents?.a?.name, agentId: m.agents?.a?.agentId },
          b: { name: m.agents?.b?.name, agentId: m.agents?.b?.agentId },
        },
        result: m.result,
        endedAt: m.endedAt,
      })),
    };
  }
}
