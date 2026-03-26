import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Match, Agent } from '../../database/schemas';
import { ActiveMatchesService } from '../../orchestrator/active-matches.service';
import { HumanMoveService } from '../../orchestrator/human-move.service';

const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — matches should end naturally via game logic

@Injectable()
export class MatchCleanupJob {
  private readonly logger = new Logger(MatchCleanupJob.name);

  constructor(
    @InjectModel(Match.name) private readonly matchModel: Model<Match>,
    @InjectModel(Agent.name) private readonly agentModel: Model<Agent>,
    private readonly activeMatches: ActiveMatchesService,
    private readonly humanMoveService: HumanMoveService,
  ) {}

  async run(): Promise<void> {
    const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS);

    const staleMatches = await this.matchModel.find({
      status: { $in: ['starting', 'active'] },
      updatedAt: { $lt: cutoff },
      agents: { $exists: true },
    });

    if (staleMatches.length === 0) {
      this.logger.log('No stale matches found');
      return;
    }

    const staleMatchIds = staleMatches.map((m) => m._id);

    const agentIds = staleMatches.flatMap((m) =>
      Object.values(m.agents).map((a) => a.agentId),
    );

    const matchUpdateResult = await this.matchModel.updateMany(
      { _id: { $in: staleMatchIds } },
      {
        $set: {
          status: 'error',
          result: {
            winnerId: null,
            reason: 'disconnect',
            finalScore: { a: 0, b: 0 },
            totalMoves: 0,
            eloChange: { a: 0, b: 0 },
          },
          endedAt: new Date(),
        },
      },
    );

    const agentUpdateResult = await this.agentModel.updateMany(
      {
        _id: { $in: agentIds },
        status: { $in: ['queued', 'in_match'] },
      },
      { $set: { status: 'idle' } },
    );

    // Clean up in-memory state for stale matches
    let removedFromMemory = 0;
    for (const match of staleMatches) {
      const matchId = match._id.toString();
      const matchState = this.activeMatches.getMatch(matchId);
      if (matchState?.clock) matchState.clock.stop();
      this.humanMoveService.cancelPending(matchId);
      if (this.activeMatches.removeMatch(matchId)) {
        removedFromMemory++;
      }
    }

    this.logger.log(
      `Cleaned up ${matchUpdateResult.modifiedCount} stale match(es), reset ${agentUpdateResult.modifiedCount} agent(s), removed ${removedFromMemory} from memory`,
    );
  }
}
