import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import * as jwt from 'jsonwebtoken';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ConfigService } from '../common/config/config.service';
import { RoomsService } from './rooms.service';
import { HumanMoveService } from '../orchestrator/human-move.service';
import { MatchManagerService } from '../orchestrator/match-manager.service';
import { Agent, Match } from '../database/schemas';

interface AuthenticatedSocket extends Socket {
  user?: { userId: string; username: string };
  role?: string;
}

@WebSocketGateway({
  cors: { origin: '*' },
  namespace: '/ws',
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(RealtimeGateway.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly rooms: RoomsService,
    private readonly humanMoveService: HumanMoveService,
    private readonly matchManager: MatchManagerService,
    @InjectModel(Agent.name) private readonly agentModel: Model<Agent>,
    @InjectModel(Match.name) private readonly matchModel: Model<Match>,
  ) {}

  handleConnection(client: Socket): void {
    // Support token in: auth object, query string, or httpOnly cookie
    let token = (client.handshake.auth?.token || client.handshake.query.token) as string | undefined;
    if (!token && client.handshake.headers.cookie) {
      const match = client.handshake.headers.cookie.match(/arena_token=([^;]+)/);
      if (match) token = match[1];
    }

    if (!token) {
      client.emit('message', {
        type: 'error',
        data: { message: 'Authentication required.' },
      });
      client.disconnect();
      return;
    }

    try {
      const payload = jwt.verify(token, this.configService.jwtSecret) as { userId: string; username: string };
      (client as AuthenticatedSocket).user = payload;
      (client as AuthenticatedSocket).role = (client.handshake.query.role as string) || 'spectator';
      this.rooms.registerClient(client);
      this.logger.log(`Client ${client.id} connected (user: ${payload.username})`);
    } catch {
      client.emit('message', {
        type: 'error',
        data: { message: 'Invalid or expired authentication token.' },
      });
      client.disconnect();
      return;
    }

    // Auto-join match room if matchId provided in query
    const matchId = client.handshake.query.matchId as string | undefined;
    if (matchId) {
      this.ensureMatchPlayers(matchId);
      this.rooms.join(matchId, client);
      client.emit('message', {
        type: 'match:state',
        data: {
          matchId,
          subscribed: true,
          viewers: this.rooms.getSpectatorCount(matchId),
        },
      });
      // Re-send pending turn notification if this player's agent is waiting for a move
      this.resendPendingTurn(matchId, client);
    }
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`Client ${client.id} disconnected, cleaning up rooms`);
    this.rooms.unregisterClient(client);
    this.rooms.leaveAll(client);
  }

  @SubscribeMessage('subscribe')
  handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { matchId: string },
  ): void {
    if (!data?.matchId) {
      client.emit('message', {
        type: 'error',
        data: { message: 'matchId is required for subscribe.' },
      });
      return;
    }

    this.ensureMatchPlayers(data.matchId);
    this.rooms.join(data.matchId, client);
    this.logger.log(`Client ${client.id} subscribed to match ${data.matchId}`);
    client.emit('message', {
      type: 'match:state',
      data: {
        matchId: data.matchId,
        subscribed: true,
        viewers: this.rooms.getSpectatorCount(data.matchId),
      },
    });
  }

  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { matchId: string },
  ): void {
    if (!data?.matchId) return;
    this.rooms.leave(data.matchId, client);
    this.logger.log(`Client ${client.id} unsubscribed from match ${data.matchId}`);
  }

  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() client: Socket): void {
    client.emit('message', {
      type: 'pong',
      data: { timestamp: Date.now() },
    });
  }

  @SubscribeMessage('game:move')
  async handleGameMove(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { matchId: string; move: unknown },
  ): Promise<void> {
    const user = (client as AuthenticatedSocket).user;
    if (!user) {
      client.emit('message', { type: 'error', data: { message: 'Not authenticated.' } });
      return;
    }

    if (!data?.matchId || data.move === undefined) {
      client.emit('message', { type: 'error', data: { message: 'matchId and move are required.' } });
      return;
    }

    // Find the user's human agent that is currently playing in this match.
    // For RPS: simultaneous moves use keys "matchId:a" and "matchId:b"
    let pendingKey = data.matchId;
    let pendingAgentId = this.humanMoveService.getPendingAgentId(data.matchId);

    if (!pendingAgentId) {
      // Try RPS-style per-side keys
      for (const side of ['a', 'b']) {
        const sideKey = `${data.matchId}:${side}`;
        const sideAgentId = this.humanMoveService.getPendingAgentId(sideKey);
        if (sideAgentId) {
          const sideAgent = await this.agentModel.findById(sideAgentId);
          if (sideAgent && sideAgent.userId && sideAgent.userId.toString() === user.userId && sideAgent.type === 'human') {
            pendingKey = sideKey;
            pendingAgentId = sideAgentId;
            break;
          }
        }
      }
    }

    if (!pendingAgentId) {
      client.emit('message', { type: 'error', data: { message: 'No pending move for this match.' } });
      return;
    }

    // Verify the user owns the agent
    const agent = await this.agentModel.findById(pendingAgentId);
    if (!agent || (agent.userId && agent.userId.toString() !== user.userId) || agent.type !== 'human') {
      client.emit('message', { type: 'error', data: { message: 'You are not the human player in this match.' } });
      return;
    }

    const submitted = this.humanMoveService.submitMove(pendingKey, pendingAgentId, data.move);
    if (submitted) {
      client.emit('message', { type: 'game:move_accepted', data: { matchId: data.matchId } });
    } else {
      client.emit('message', { type: 'error', data: { message: 'Failed to submit move.' } });
    }
  }

  /** Load match player userIds into RoomsService (fire-and-forget, idempotent) */
  private ensureMatchPlayers(matchId: string): void {
    this.matchModel.findById(matchId).select('agents.a.userId agents.b.userId').lean().then((match) => {
      if (!match) return;
      const userIds: string[] = [];
      if (match.agents?.a?.userId) userIds.push(match.agents.a.userId.toString());
      if (match.agents?.b?.userId) userIds.push(match.agents.b.userId.toString());
      if (userIds.length > 0) this.rooms.setMatchPlayers(matchId, userIds);
    }).catch(() => {});
  }

  /** Re-send match:your_turn if there's a pending human move for this match */
  private resendPendingTurn(matchId: string, client: Socket): void {
    let pendingSide = this.humanMoveService.getPendingSide(matchId);
    if (!pendingSide) {
      for (const side of ['a', 'b']) {
        const sideKey = `${matchId}:${side}`;
        const sidePending = this.humanMoveService.getPendingSide(sideKey);
        if (sidePending) { pendingSide = sidePending; break; }
      }
    }
    if (!pendingSide) return;

    const user = (client as AuthenticatedSocket).user;
    if (!user) return;

    // Check if this user owns the agent that needs to move
    this.matchModel.findById(matchId).select('agents gameType currentTurn pokerState werewolfState').lean().then(async (match) => {
      if (!match) return;
      const agentDoc = match.agents?.[pendingSide];
      if (!agentDoc) return;

      // Verify this user owns the agent whose turn it is
      if (agentDoc.userId?.toString() !== user.userId) return;

      this.logger.log(`Re-sending match:your_turn to reconnected player (match=${matchId}, side=${pendingSide}, gameType=${match.gameType})`);
      const payload: Record<string, unknown> = {
        matchId,
        side: pendingSide,
        gameType: match.gameType,
        currentTurn: pendingSide,
        turnTimeoutMs: 20000,
      };

      // Add poker state if available
      if (match.gameType === 'poker' && match.pokerState) {
        const pk = match.pokerState as Record<string, unknown> & {
          communityCards?: string[];
          pot?: number;
          street?: string;
          handNumber?: number;
          players?: Record<string, { holeCards?: string[]; stack?: number }>;
        };
        if (pk.communityCards) payload.pokerCommunityCards = pk.communityCards;
        if (pk.pot != null) payload.pokerPot = pk.pot;
        if (pk.street) payload.pokerStreet = pk.street;
        if (pk.handNumber != null) payload.pokerHandNumber = pk.handNumber;
        if (pk.players) {
          const side = pendingSide;
          const myPlayer = pk.players[side];
          if (myPlayer?.holeCards) payload.pokerHoleCards = myPlayer.holeCards;
          if (pk.players.a?.stack != null && pk.players.b?.stack != null) {
            payload.pokerPlayerStacks = { a: pk.players.a.stack, b: pk.players.b.stack };
          }
        }
      }

      // Add werewolf state: private role + legal actions so the human UI
      // can render its action panel when reconnecting mid-match.
      if (match.gameType === 'werewolf') {
        const mm = this.matchManager as unknown as {
          getWerewolfState?: (id: string) => unknown;
        };
        const live = mm.getWerewolfState?.(matchId) as any;
        if (live && live.players?.[pendingSide]) {
          const me = live.players[pendingSide];
          payload.yourRole = me.role;
          payload.yourDisplayName = me.displayName;
          payload.werewolfPhase = live.phase;
          payload.cycle = live.cycle;
          payload.activeSide = live.activeSide;
          payload.discussionLog = live.discussionLog;
          payload.deaths = live.deaths;
          if (me.role === 'WEREWOLF') {
            payload.knownWerewolves = Object.values(live.players as Record<string, { side: string; role: string }>)
              .filter((p) => p.role === 'WEREWOLF' && p.side !== pendingSide)
              .map((p) => p.side);
          }
          if (me.role === 'SEER') {
            payload.seerMemory = live.seerMemory;
          }
          // Legal actions for current state
          try {
            const engine = await import('../game-engine/werewolf');
            payload.legalActions = engine.getLegalActions(live, pendingSide);
          } catch {}
          // Public players view (no roles revealed)
          payload.werewolfPlayers = Object.fromEntries(
            Object.entries(live.players as Record<string, any>).map(([side, p]) => [
              side,
              {
                side: p.side,
                displayName: p.displayName,
                isAlive: p.isAlive,
                deathCycle: p.deathCycle,
                deathCause: p.deathCause,
              },
            ]),
          );
        }
      }

      client.emit('message', { type: 'match:your_turn', data: payload });
    }).catch(() => {});
  }
}
