import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Agent, Match, User } from '../database/schemas';

@Injectable()
export class LeaderboardService {
  constructor(
    @InjectModel(Agent.name) private readonly agentModel: Model<Agent>,
    @InjectModel(Match.name) private readonly matchModel: Model<Match>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
  ) {}

  async getAgentLeaderboard(limit = 20, gameType?: string) {
    const filter: Record<string, unknown> = { status: { $ne: 'disabled' }, 'stats.totalMatches': { $gt: 0 } };
    if (gameType) filter.gameTypes = gameType;

    // Fetch more agents than limit to score and re-rank
    const agents = await this.agentModel.find(filter)
      .sort({ eloRating: -1 })
      .limit(Math.max(limit * 3, 100))
      .select('name eloRating stats gameTypes userId createdAt xUsername claimStatus')
      .lean();

    // Composite score: weighted combination of multiple factors
    // - ELO (40%): skill rating
    // - Win rate (25%): consistency
    // - Total matches (15%): experience
    // - Earnings (20%): profitability
    const maxElo = Math.max(...agents.map((a: any) => a.eloRating || 1200), 1200);
    const minElo = Math.min(...agents.map((a: any) => a.eloRating || 1200), 1200);
    const eloRange = maxElo - minElo || 1;
    const maxMatches = Math.max(...agents.map((a: any) => a.stats?.totalMatches || 0), 1);
    const maxEarnings = Math.max(...agents.map((a: any) => a.stats?.totalEarnings || 0), 1);

    const scored = agents.map((agent: any) => {
      const elo = agent.eloRating || 1200;
      const wins = agent.stats?.wins || 0;
      const totalMatches = agent.stats?.totalMatches || 0;
      const winRate = totalMatches > 0 ? wins / totalMatches : 0;
      const earnings = agent.stats?.totalEarnings || 0;

      // Normalize each factor to 0-1 range
      const eloScore = (elo - minElo) / eloRange;
      const winRateScore = winRate;
      const matchesScore = totalMatches / maxMatches;
      const earningsScore = earnings / maxEarnings;

      const compositeScore =
        eloScore * 0.40 +
        winRateScore * 0.25 +
        matchesScore * 0.15 +
        earningsScore * 0.20;

      return { agent, compositeScore };
    });

    scored.sort((a, b) => b.compositeScore - a.compositeScore);

    const topAgents = scored.slice(0, limit);
    const topAgentIds = topAgents.map(({ agent }: any) => agent._id);
    const topAgentIdStrs = topAgentIds.map((id: any) => id.toString());

    // Bulk aggregation: stats by game type for all top agents
    // Unwind each match into per-agent records so both sides get counted
    const bulkStats = await this.matchModel.aggregate([
      {
        $match: {
          status: 'completed',
          agents: { $exists: true },
          $or: [
            { 'agents.a.agentId': { $in: [...topAgentIds, ...topAgentIdStrs] } },
            { 'agents.b.agentId': { $in: [...topAgentIds, ...topAgentIdStrs] } },
          ],
        },
      },
      {
        $addFields: {
          _sides: [
            { agentId: { $toString: '$agents.a.agentId' }, side: 'a' },
            { agentId: { $toString: '$agents.b.agentId' }, side: 'b' },
          ],
        },
      },
      { $unwind: '$_sides' },
      { $match: { '_sides.agentId': { $in: topAgentIdStrs } } },
      {
        $addFields: {
          outcome: {
            $cond: {
              if: { $eq: ['$result.winnerId', null] },
              then: 'draw',
              else: {
                $cond: {
                  if: { $eq: [{ $toString: '$result.winnerId' }, '$_sides.agentId'] },
                  then: 'win',
                  else: 'loss',
                },
              },
            },
          },
        },
      },
      {
        $group: {
          _id: { agentId: '$_sides.agentId', gameType: '$gameType' },
          wins: { $sum: { $cond: [{ $eq: ['$outcome', 'win'] }, 1, 0] } },
          losses: { $sum: { $cond: [{ $eq: ['$outcome', 'loss'] }, 1, 0] } },
          draws: { $sum: { $cond: [{ $eq: ['$outcome', 'draw'] }, 1, 0] } },
          totalMatches: { $sum: 1 },
        },
      },
    ]);

    // Build a map: agentId -> { gameType -> stats }
    const statsMap = new Map<string, Record<string, { wins: number; losses: number; draws: number; totalMatches: number }>>();
    for (const entry of bulkStats) {
      const agentId = entry._id.agentId;
      if (!statsMap.has(agentId)) statsMap.set(agentId, {});
      statsMap.get(agentId)![entry._id.gameType] = {
        wins: entry.wins, losses: entry.losses, draws: entry.draws, totalMatches: entry.totalMatches,
      };
    }

    const ranked = topAgents.map(({ agent, compositeScore }: any, index: number) => ({
      rank: index + 1, agentId: agent._id, name: agent.name, eloRating: agent.eloRating,
      stats: agent.stats, gameTypes: agent.gameTypes, userId: agent.userId,
      totalEarnings: agent.stats?.totalEarnings || 0,
      earningsAlpha: agent.stats?.earningsAlpha || 0,
      earningsUsdc: agent.stats?.earningsUsdc || 0,
      xUsername: agent.xUsername || null, claimStatus: agent.claimStatus || null,
      score: Math.round(compositeScore * 1000) / 10,
      statsByGameType: statsMap.get(agent._id.toString()) || {},
    }));

    return { leaderboard: ranked };
  }

  async getUserLeaderboard(limit = 20) {
    const userStats = await this.agentModel.aggregate([
      { $match: { status: { $ne: 'disabled' } } },
      {
        $group: {
          _id: '$userId',
          totalEarnings: { $sum: '$stats.totalEarnings' },
          earningsAlpha: { $sum: { $ifNull: ['$stats.earningsAlpha', 0] } },
          earningsUsdc: { $sum: { $ifNull: ['$stats.earningsUsdc', 0] } },
          totalWins: { $sum: '$stats.wins' },
          totalLosses: { $sum: '$stats.losses' },
          totalDraws: { $sum: '$stats.draws' },
          totalMatches: { $sum: '$stats.totalMatches' },
          agentCount: { $sum: 1 },
          bestElo: { $max: '$eloRating' },
        },
      },
      { $sort: { totalEarnings: -1 } },
      { $limit: limit },
    ]);

    const filteredStats = userStats.filter((entry: any) => entry._id != null);
    const userIds = filteredStats.map((entry: any) => entry._id);
    const users = await this.userModel.find({ _id: { $in: userIds } }).select('username walletAddress').lean();
    const userMap = new Map(users.map((u: any) => [u._id.toString(), u]));

    const ranked = filteredStats.map((entry: any, index: number) => {
      const user = userMap.get(entry._id.toString());
      return {
        rank: index + 1, userId: entry._id, username: (user as Record<string, string>)?.username ?? 'Unknown',
        walletAddress: (user as Record<string, string>)?.walletAddress ?? '', totalEarnings: entry.totalEarnings,
        earningsAlpha: entry.earningsAlpha || 0, earningsUsdc: entry.earningsUsdc || 0,
        totalWins: entry.totalWins, totalLosses: entry.totalLosses, totalDraws: entry.totalDraws,
        totalMatches: entry.totalMatches, agentCount: entry.agentCount, bestElo: entry.bestElo,
      };
    });

    return { leaderboard: ranked };
  }

  async getAgentStats(id: string) {
    const agent = await this.agentModel.findById(id).select('name eloRating stats gameTypes userId status createdAt xUsername claimStatus').lean();
    if (!agent) throw new NotFoundException('Agent not found');

    const recentMatches = await this.matchModel.find({
      $or: [{ 'agents.a.agentId': id }, { 'agents.b.agentId': id }],
      status: 'completed',
      agents: { $exists: true },
    }).sort({ endedAt: -1 }).limit(20).select('agents result stakeAmount potAmount gameType endedAt').lean();

    const matchHistory = recentMatches.map((match: any) => {
      const isAgentA = match.agents.a.agentId.toString() === id;
      const side = isAgentA ? 'a' : 'b';
      const opponentSide = isAgentA ? 'b' : 'a';
      let outcome: 'win' | 'loss' | 'draw';
      if (!match.result || match.result.winnerId === null) outcome = 'draw';
      else if (match.result.winnerId.toString() === id) outcome = 'win';
      else outcome = 'loss';

      return {
        matchId: match._id, gameType: match.gameType,
        opponent: { agentId: match.agents[opponentSide].agentId, name: match.agents[opponentSide].name },
        outcome, eloChange: match.result?.eloChange[side] ?? 0,
        finalScore: match.result?.finalScore ?? { a: 0, b: 0 },
        stakeAmount: match.stakeAmount, endedAt: match.endedAt,
      };
    });

    const owner = await this.userModel.findById(agent.userId).select('username').lean();

    // Aggregate wins/losses/draws per game type
    // Match on both string and ObjectId variants of agentId
    const agentOid = new Types.ObjectId(id);
    const statsByGameType = await this.matchModel.aggregate([
      {
        $match: {
          $or: [
            { 'agents.a.agentId': id }, { 'agents.a.agentId': agentOid },
            { 'agents.b.agentId': id }, { 'agents.b.agentId': agentOid },
          ],
          status: 'completed',
          agents: { $exists: true },
        },
      },
      {
        $addFields: {
          outcome: {
            $cond: {
              if: { $eq: ['$result.winnerId', null] },
              then: 'draw',
              else: {
                $cond: {
                  if: { $eq: [{ $toString: '$result.winnerId' }, id] },
                  then: 'win',
                  else: 'loss',
                },
              },
            },
          },
        },
      },
      {
        $group: {
          _id: '$gameType',
          wins: { $sum: { $cond: [{ $eq: ['$outcome', 'win'] }, 1, 0] } },
          losses: { $sum: { $cond: [{ $eq: ['$outcome', 'loss'] }, 1, 0] } },
          draws: { $sum: { $cond: [{ $eq: ['$outcome', 'draw'] }, 1, 0] } },
          totalMatches: { $sum: 1 },
        },
      },
    ]);

    const winsByGameType: Record<string, { wins: number; losses: number; draws: number; totalMatches: number }> = {};
    for (const entry of statsByGameType) {
      winsByGameType[entry._id] = {
        wins: entry.wins,
        losses: entry.losses,
        draws: entry.draws,
        totalMatches: entry.totalMatches,
      };
    }

    return {
      agent: {
        id: agent._id, name: agent.name, eloRating: agent.eloRating,
        stats: agent.stats, gameTypes: agent.gameTypes, status: agent.status,
        owner: { userId: agent.userId, username: owner?.username ?? 'Unknown' },
        xUsername: agent.xUsername || null,
        claimStatus: agent.claimStatus || null,
        createdAt: agent.createdAt,
      },
      recentMatches: matchHistory,
      statsByGameType: winsByGameType,
    };
  }
}
