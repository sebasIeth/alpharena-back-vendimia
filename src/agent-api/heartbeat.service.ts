import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createHash } from 'crypto';
import { Agent } from '../database/schemas';
import { ActiveMatchesService } from '../orchestrator/active-matches.service';
import { HumanMoveService } from '../orchestrator/human-move.service';

const MOVE_HEARTBEAT_SECONDS = 30;
const IN_MATCH_HEARTBEAT_SECONDS = 30;
const QUEUED_HEARTBEAT_SECONDS = 60;
const IDLE_HEARTBEAT_SECONDS = 60;

@Injectable()
export class HeartbeatService {
  private readonly logger = new Logger(HeartbeatService.name);

  constructor(
    @InjectModel(Agent.name) private readonly agentModel: Model<Agent>,
    private readonly activeMatches: ActiveMatchesService,
    private readonly humanMoveService: HumanMoveService,
  ) {}

  async heartbeat(agent: Agent) {
    const agentId = agent._id.toString();

    // Update last heartbeat
    await this.agentModel.updateOne(
      { _id: agentId },
      { lastHeartbeat: new Date() },
    );

    // Find all active matches this agent is in
    const dueGameIds: string[] = [];
    let shouldMoveNow = false;

    for (const [matchId, state] of this.activeMatches.entries()) {
      for (const side of Object.keys(state.agents)) {
        if (state.agents[side].agentId === agentId) {
          // Agent is in this match — check both standard key and RPS per-side key
          let pendingAgentId = this.humanMoveService.getPendingAgentId(matchId);
          if (!pendingAgentId) {
            pendingAgentId = this.humanMoveService.getPendingAgentId(`${matchId}:${side}`);
          }
          if (pendingAgentId === agentId) {
            dueGameIds.push(matchId);
            shouldMoveNow = true;
          }
          break;
        }
      }
    }

    // Find any active match this agent is in (even if not their turn yet)
    let activeMatchId: string | null = null;
    for (const [matchId, state] of this.activeMatches.entries()) {
      for (const side of Object.keys(state.agents)) {
        if (state.agents[side].agentId === agentId) {
          activeMatchId = matchId;
          break;
        }
      }
      if (activeMatchId) break;
    }

    // Should the agent queue up? Only if idle AND not in any active match
    const shouldQueueNow = agent.status === 'idle' && !activeMatchId && dueGameIds.length === 0;

    // Recommended heartbeat cadence (matches Clawleague style)
    let recommendedHeartbeatSeconds: number;
    if (shouldMoveNow) {
      recommendedHeartbeatSeconds = MOVE_HEARTBEAT_SECONDS;
    } else if (agent.status === 'in_match' || activeMatchId) {
      recommendedHeartbeatSeconds = IN_MATCH_HEARTBEAT_SECONDS;
    } else if (agent.status === 'queued') {
      recommendedHeartbeatSeconds = QUEUED_HEARTBEAT_SECONDS;
    } else {
      recommendedHeartbeatSeconds = IDLE_HEARTBEAT_SECONDS;
    }

    return {
      agentId,
      status: agent.status,
      shouldQueueNow,
      shouldMoveNow,
      activeMatchId,
      nextMatchId: dueGameIds[0] ?? null,
      dueGameIds,
      recommendedHeartbeatSeconds,
      timestamp: new Date().toISOString(),
    };
  }

  async batchHeartbeat(apiKeys: string[]) {
    const results: Record<string, unknown> = {};

    for (const apiKey of apiKeys) {
      try {
        const hash = createHash('sha256').update(apiKey).digest('hex');
        const agent = await this.agentModel.findOne({ apiKeyHash: hash });

        if (!agent) {
          results[apiKey.substring(0, 11)] = { error: 'Invalid API key' };
          continue;
        }

        results[agent._id.toString()] = await this.heartbeat(agent);
      } catch (err) {
        const prefix = apiKey.substring(0, 11);
        results[prefix] = { error: 'Heartbeat failed' };
      }
    }

    return { results };
  }
}
