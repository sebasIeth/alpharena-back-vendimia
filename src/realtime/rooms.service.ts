import { Injectable, Logger } from '@nestjs/common';
import { Socket } from 'socket.io';

interface AuthenticatedSocket extends Socket {
  user?: { userId: string; username: string };
  role?: string;
}

@Injectable()
export class RoomsService {
  private readonly logger = new Logger(RoomsService.name);
  private readonly rooms = new Map<string, Set<Socket>>();
  private readonly allClients = new Set<Socket>();
  /** userIds that are players (not spectators) in each match */
  private readonly matchPlayers = new Map<string, Set<string>>();

  registerClient(client: Socket): void {
    this.allClients.add(client);
  }

  unregisterClient(client: Socket): void {
    this.allClients.delete(client);
  }

  setMatchPlayers(matchId: string, userIds: string[]): void {
    this.matchPlayers.set(matchId, new Set(userIds));
  }

  broadcastAll(message: Record<string, unknown>): void {
    for (const client of this.allClients) {
      try {
        if (client.connected) {
          client.emit('message', message);
        }
      } catch {
        this.logger.warn(`Failed to broadcast to client ${client.id}`);
      }
    }
  }

  join(matchId: string, client: Socket): void {
    let room = this.rooms.get(matchId);
    if (!room) {
      room = new Set();
      this.rooms.set(matchId, room);
      this.logger.log(`Created new room for match ${matchId}`);
    }
    room.add(client);
    this.logger.debug(`Client ${client.id} joined room ${matchId} (size: ${room.size})`);
    this.broadcastViewers(matchId);
  }

  leave(matchId: string, client: Socket): void {
    const room = this.rooms.get(matchId);
    if (!room) return;

    room.delete(client);
    this.logger.debug(`Client ${client.id} left room ${matchId} (size: ${room.size})`);
    this.broadcastViewers(matchId);

    if (room.size === 0) {
      this.rooms.delete(matchId);
      this.matchPlayers.delete(matchId);
      this.logger.log(`Room ${matchId} removed (empty)`);
    }
  }

  leaveAll(client: Socket): void {
    for (const [matchId, room] of this.rooms) {
      if (room.has(client)) {
        room.delete(client);
        this.broadcastViewers(matchId);
        if (room.size === 0) {
          this.rooms.delete(matchId);
          this.matchPlayers.delete(matchId);
        }
      }
    }
  }

  private broadcastViewers(matchId: string): void {
    this.broadcast(matchId, {
      type: 'match:viewers',
      data: { matchId, viewers: this.getSpectatorCount(matchId) },
    });
  }

  getSpectatorCount(matchId: string): number {
    const room = this.rooms.get(matchId);
    if (!room) return 0;
    // Deduplicate by userId, only count spectators (exclude players from /play page)
    const uniqueSpectators = new Set<string>();
    for (const client of room) {
      if ((client as AuthenticatedSocket).role === 'player') continue;
      const userId = (client as AuthenticatedSocket).user?.userId;
      if (userId) uniqueSpectators.add(userId);
    }
    return uniqueSpectators.size;
  }

  broadcast(matchId: string, message: Record<string, unknown>): void {
    const room = this.rooms.get(matchId);
    if (!room || room.size === 0) return;

    let sentCount = 0;
    for (const client of room) {
      try {
        if (client.connected) {
          client.emit('message', message);
          sentCount++;
        }
      } catch (err) {
        this.logger.warn(`Failed to send message to client ${client.id}`);
      }
    }
    this.logger.debug(`Broadcast to ${sentCount}/${room.size} clients in room ${matchId}`);
  }

  getRoomSize(matchId: string): number {
    return this.rooms.get(matchId)?.size ?? 0;
  }

  getAllViewerCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const matchId of this.rooms.keys()) {
      const count = this.getSpectatorCount(matchId);
      if (count > 0) counts[matchId] = count;
    }
    return counts;
  }

  cleanup(matchId: string): void {
    const room = this.rooms.get(matchId);
    if (room) {
      this.logger.log(`Cleaning up room ${matchId} (${room.size} clients remaining)`);
      this.rooms.delete(matchId);
    }
    this.matchPlayers.delete(matchId);
  }
}
