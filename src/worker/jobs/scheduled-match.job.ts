import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ScheduledMatch, Agent, Match } from '../../database/schemas';
import { OrchestratorService } from '../../orchestrator/orchestrator.service';
import { MatchAgentInput } from '../../orchestrator/match-manager.service';

@Injectable()
export class ScheduledMatchJob {
  private readonly logger = new Logger(ScheduledMatchJob.name);

  constructor(
    @InjectModel(ScheduledMatch.name) private readonly scheduledMatchModel: Model<ScheduledMatch>,
    @InjectModel(Agent.name) private readonly agentModel: Model<Agent>,
    @InjectModel(Match.name) private readonly matchModel: Model<Match>,
    private readonly orchestrator: OrchestratorService,
  ) {}

  async run(): Promise<void> {
    const dueMatches = await this.scheduledMatchModel
      .find({ status: 'scheduled', scheduledAt: { $lte: new Date() } })
      .sort({ scheduledAt: 1 })
      .lean();

    if (dueMatches.length === 0) return;

    this.logger.log(`Found ${dueMatches.length} scheduled match(es) due for execution`);

    for (const scheduled of dueMatches) {
      const id = scheduled._id.toString();
      try {
        // Mark as starting to prevent double-execution
        await this.scheduledMatchModel.updateOne({ _id: id }, { status: 'starting' });

        // Allow zero-stake matches (auto-scheduled free play)

        if (scheduled.agents.length < 2) {
          this.logger.warn(`Scheduled match ${id}: not enough agents (${scheduled.agents.length})`);
          await this.scheduledMatchModel.updateOne({ _id: id }, { status: 'cancelled', cancelReason: 'Not enough agents' });
          continue;
        }

        // Fetch agent documents
        const agentA = await this.agentModel.findById(scheduled.agents[0].agentId);
        const agentB = await this.agentModel.findById(scheduled.agents[1].agentId);

        if (!agentA || !agentB) {
          this.logger.warn(`Scheduled match ${id}: agent(s) not found`);
          await this.scheduledMatchModel.updateOne({ _id: id }, { status: 'cancelled', cancelReason: 'Agent not found' });
          continue;
        }

        // Check agents are idle (not already in a match)
        if (agentA.status !== 'idle') {
          this.logger.warn(`Scheduled match ${id}: agent "${agentA.name}" is not idle (${agentA.status})`);
          await this.scheduledMatchModel.updateOne({ _id: id }, { status: 'cancelled', cancelReason: `Agent "${agentA.name}" is ${agentA.status}` });
          continue;
        }
        if (agentB.status !== 'idle') {
          this.logger.warn(`Scheduled match ${id}: agent "${agentB.name}" is not idle (${agentB.status})`);
          await this.scheduledMatchModel.updateOne({ _id: id }, { status: 'cancelled', cancelReason: `Agent "${agentB.name}" is ${agentB.status}` });
          continue;
        }

        // Validate both agents are on the same chain
        const chainA = agentA.chain || 'base';
        const chainB = agentB.chain || 'base';
        if (chainA !== chainB) {
          this.logger.warn(`Scheduled match ${id}: chain mismatch (${agentA.name}=${chainA}, ${agentB.name}=${chainB})`);
          await this.scheduledMatchModel.updateOne({ _id: id }, { status: 'cancelled', cancelReason: `Chain mismatch: ${chainA} vs ${chainB}` });
          continue;
        }

        // Build MatchAgentInput
        const inputA: MatchAgentInput = {
          agentId: agentA._id.toString(),
          userId: agentA.userId?.toString() ?? '',
          name: agentA.name,
          endpointUrl: agentA.endpointUrl || '',
          eloRating: agentA.eloRating,
          type: agentA.type,
          chain: chainA,
          openclawUrl: agentA.openclawUrl,
          openclawToken: agentA.openclawToken,
          openclawAgentId: agentA.openclawAgentId,
        };

        const inputB: MatchAgentInput = {
          agentId: agentB._id.toString(),
          userId: agentB.userId?.toString() ?? '',
          name: agentB.name,
          endpointUrl: agentB.endpointUrl || '',
          eloRating: agentB.eloRating,
          type: agentB.type,
          chain: chainB,
          openclawUrl: agentB.openclawUrl,
          openclawToken: agentB.openclawToken,
          openclawAgentId: agentB.openclawAgentId,
        };

        // Transition placeholder match from 'pending' to 'starting' before execution
        if (scheduled.matchId) {
          await this.matchModel.updateOne(
            { _id: scheduled.matchId, status: 'pending' },
            { status: 'starting' },
          );
        }

        // Start the match via orchestrator, reusing the placeholder match doc if it exists
        const placeholderMatchId = scheduled.matchId || undefined;
        const realMatchId = await this.orchestrator.startMatch(
          inputA,
          inputB,
          scheduled.stakeAmount,
          scheduled.gameType,
          placeholderMatchId,
        );

        // Mark as completed with the real matchId
        await this.scheduledMatchModel.updateOne({ _id: id }, { status: 'completed', matchId: realMatchId });
        this.logger.log(`Scheduled match ${id} started successfully → match ${realMatchId}`);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Failed to start scheduled match ${id}: ${message}`);
        await this.scheduledMatchModel.updateOne({ _id: id }, { status: 'cancelled', cancelReason: message });
      }
    }
  }
}
