import { Injectable, Logger, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ScheduledMatch, Agent, Match } from '../database/schemas';

@Injectable()
export class ScheduledMatchesService {
  private readonly logger = new Logger(ScheduledMatchesService.name);

  constructor(
    @InjectModel(ScheduledMatch.name) private readonly scheduledMatchModel: Model<ScheduledMatch>,
    @InjectModel(Agent.name) private readonly agentModel: Model<Agent>,
    @InjectModel(Match.name) private readonly matchModel: Model<Match>,
  ) {}

  async create(dto: {
    gameType: string;
    scheduledAt: Date;
    stakeAmount: number;
    agentIds: string[];
    userId: string;
  }) {
    if (dto.agentIds.length < 2) {
      throw new BadRequestException('At least 2 agents are required');
    }

    if (!dto.stakeAmount || dto.stakeAmount <= 0) {
      throw new BadRequestException('stakeAmount is required and must be greater than 0');
    }

    if (new Date(dto.scheduledAt).getTime() <= Date.now()) {
      throw new BadRequestException('scheduledAt must be in the future');
    }

    const agents = await this.agentModel.find({ _id: { $in: dto.agentIds } }).lean();
    if (agents.length !== dto.agentIds.length) {
      throw new BadRequestException('One or more agents not found');
    }

    // Validate game type support and chain consistency
    const matchChain = agents[0].chain || 'base';
    for (const agent of agents) {
      if (!agent.gameTypes.includes(dto.gameType)) {
        throw new BadRequestException(`Agent "${agent.name}" does not support game type "${dto.gameType}"`);
      }
      const agentChain = agent.chain || 'base';
      if (agentChain !== matchChain) {
        throw new BadRequestException(
          `Chain mismatch: agent "${agent.name}" is on "${agentChain}" but other agents are on "${matchChain}"`,
        );
      }
    }

    const COLORS = ['#E84855', '#4361EE', '#06D6A0', '#F7B32B', '#8338EC', '#2EC4B6', '#FF6B6B', '#6B5B95', '#88B04B'];

    const scheduledAgents = agents.map((agent, i) => ({
      agentId: agent._id,
      userId: agent.userId,
      name: agent.name,
      elo: agent.eloRating,
      color: COLORS[i % COLORS.length],
    }));

    // Create a placeholder Match so betting can open immediately
    const sides = 'abcdefghijklmnopqrstuvwxyz';
    const matchAgents: Record<string, { agentId: any; userId: any; name: string; eloAtStart: number }> = {};
    agents.forEach((agent, i) => {
      matchAgents[sides[i]] = {
        agentId: agent._id,
        userId: agent.userId,
        name: agent.name,
        eloAtStart: agent.eloRating,
      };
    });

    const matchDoc = await this.matchModel.create({
      gameType: dto.gameType,
      chain: matchChain,
      agents: matchAgents,
      stakeAmount: dto.stakeAmount,
      potAmount: dto.stakeAmount * agents.length,
      status: 'pending',
    });

    const doc = await this.scheduledMatchModel.create({
      gameType: dto.gameType,
      scheduledAt: new Date(dto.scheduledAt),
      stakeAmount: dto.stakeAmount,
      agents: scheduledAgents,
      matchId: matchDoc._id.toString(),
      createdBy: new Types.ObjectId(dto.userId),
    });

    this.logger.log(`Scheduled match created: ${doc._id} → match ${matchDoc._id} for ${dto.scheduledAt}`);
    return doc;
  }

  async findUpcoming(gameType?: string) {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const filter: Record<string, unknown> = {
      status: { $in: ['scheduled', 'starting'] },
      scheduledAt: { $gte: oneHourAgo },
    };
    if (gameType) filter.gameType = gameType;

    return this.scheduledMatchModel
      .find(filter)
      .sort({ scheduledAt: 1 })
      .limit(20)
      .lean();
  }

  async findById(id: string) {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('Invalid ID');
    const doc = await this.scheduledMatchModel.findById(id).lean();
    if (!doc) throw new NotFoundException('Scheduled match not found');
    return doc;
  }

  async cancel(id: string, userId: string): Promise<void> {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('Invalid ID');
    const doc = await this.scheduledMatchModel.findById(id);
    if (!doc) throw new NotFoundException('Scheduled match not found');
    if (doc.createdBy.toString() !== userId) throw new ForbiddenException('You did not create this scheduled match');
    if (doc.status !== 'scheduled') throw new BadRequestException(`Cannot cancel: status is "${doc.status}"`);

    doc.status = 'cancelled';
    doc.cancelReason = 'Cancelled by creator';
    await doc.save();
    this.logger.log(`Scheduled match ${id} cancelled by user ${userId}`);
  }

  async getDue() {
    return this.scheduledMatchModel
      .find({ status: 'scheduled', scheduledAt: { $lte: new Date() } })
      .sort({ scheduledAt: 1 })
      .lean();
  }

  async markStarting(id: string): Promise<void> {
    await this.scheduledMatchModel.updateOne({ _id: id }, { status: 'starting' });
  }

  async markCompleted(id: string, matchId: string): Promise<void> {
    await this.scheduledMatchModel.updateOne({ _id: id }, { status: 'completed', matchId });
  }

  async markCancelled(id: string, reason: string): Promise<void> {
    await this.scheduledMatchModel.updateOne({ _id: id }, { status: 'cancelled', cancelReason: reason });
  }
}
