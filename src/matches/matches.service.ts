import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Match, MoveDoc, Agent } from '../database/schemas';

@Injectable()
export class MatchesService {
  constructor(
    @InjectModel(Match.name) private readonly matchModel: Model<Match>,
    @InjectModel(MoveDoc.name) private readonly moveModel: Model<MoveDoc>,
    @InjectModel(Agent.name) private readonly agentModel: Model<Agent>,
  ) {}

  private async enrichMatchesWithXUsername(matches: any[]): Promise<any[]> {
    const agentIds = new Set<string>();
    for (const match of matches) {
      if (match.agents) {
        for (const side of Object.keys(match.agents)) {
          const agentId = match.agents[side]?.agentId?.toString();
          if (agentId) agentIds.add(agentId);
        }
      }
    }

    if (agentIds.size === 0) return matches;

    const agents = await this.agentModel.find(
      { _id: { $in: [...agentIds] } },
      { xUsername: 1 },
    ).lean();

    const xMap = new Map<string, string>();
    for (const agent of agents) {
      if (agent.xUsername) {
        xMap.set(agent._id.toString(), agent.xUsername);
      }
    }

    return matches.map((match) => {
      if (!match.agents) return match;
      const enriched = { ...match, agents: { ...match.agents } };
      for (const side of Object.keys(enriched.agents)) {
        const agentId = enriched.agents[side]?.agentId?.toString();
        if (agentId && xMap.has(agentId)) {
          enriched.agents[side] = { ...enriched.agents[side], xUsername: xMap.get(agentId) };
        }
      }
      return enriched;
    });
  }

  async findAll(status?: string, limit = 20, offset = 0) {
    const filter: Record<string, unknown> = { agents: { $exists: true } };
    if (status) filter.status = status;

    const [matches, total] = await Promise.all([
      this.matchModel.find(filter).sort({ createdAt: -1 }).skip(offset).limit(limit).lean(),
      this.matchModel.countDocuments(filter),
    ]);

    const enriched = await this.enrichMatchesWithXUsername(matches);
    return {
      matches: enriched,
      pagination: { total, limit, offset, hasMore: offset + limit < total },
    };
  }

  async findActive() {
    const matches = await this.matchModel
      .find({ status: { $in: ['active', 'starting'] }, agents: { $exists: true } })
      .sort({ createdAt: -1 })
      .lean();
    const enriched = await this.enrichMatchesWithXUsername(matches);
    return { matches: enriched, count: matches.length };
  }

  async findById(id: string) {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('Invalid match ID');
    const match = await this.matchModel.findById(id).lean();
    if (!match) throw new NotFoundException('Match not found');
    const [enriched] = await this.enrichMatchesWithXUsername([match]);
    return { match: enriched };
  }

  async findMoves(matchId: string) {
    if (!Types.ObjectId.isValid(matchId)) throw new BadRequestException('Invalid match ID');
    const match = await this.matchModel.findById(matchId).lean();
    if (!match) throw new NotFoundException('Match not found');

    // Use direct collection query — MoveDoc Mongoose model may map to 'movedocs' instead of 'moves'
    const moves = await this.moveModel.db.collection('moves')
      .find({ matchId: new Types.ObjectId(matchId) })
      .sort({ moveNumber: 1 })
      .toArray();
    return { matchId, moves, totalMoves: moves.length };
  }
}
