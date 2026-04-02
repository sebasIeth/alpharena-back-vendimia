import { Injectable, Logger } from '@nestjs/common';
import { TURN_TIMEOUT_MS } from '../common/constants/game.constants';
import { MoveRequest, MoveResponse, ChessMoveRequest, ChessMoveResponse } from '../common/types';
import { PokerMoveRequest, PokerMoveResponse } from '../common/types/poker.types';
import { OpenClawClientService, OpenClawAgentInfo } from './openclaw-client.service';

export interface AgentInfo {
  endpointUrl: string;
  type?: string;
  openclawUrl?: string;
  openclawToken?: string;
  openclawAgentId?: string;
}

@Injectable()
export class AgentClientService {
  private readonly logger = new Logger(AgentClientService.name);
  private readonly timeoutMs: number;

  constructor(private readonly openclawClient: OpenClawClientService) {
    this.timeoutMs = TURN_TIMEOUT_MS;
  }

  async requestMove(endpointUrl: string, moveRequest: Record<string, unknown>): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const startTime = Date.now();

    this.logger.log(
      `Requesting move from agent at ${endpointUrl} (match: ${moveRequest.matchId ?? '?'}, move #${moveRequest.moveNumber ?? '?'})`,
    );

    try {
      const response = await fetch(endpointUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(moveRequest),
        signal: controller.signal,
      });

      const elapsed = Date.now() - startTime;

      if (!response.ok) {
        const body = await response.text().catch(() => '<unreadable>');
        this.logger.error(
          `Agent returned HTTP ${response.status} (${elapsed}ms): ${body}`,
        );
        throw new Error(`Agent returned HTTP ${response.status}: ${body}`);
      }

      const data = (await response.json()) as Record<string, unknown>;
      this.logger.log(`Agent responded with move [${JSON.stringify(data.move ?? data.action ?? '?')}] (${elapsed}ms)`);
      return data;
    } catch (error: unknown) {
      const elapsed = Date.now() - startTime;

      if (
        (error instanceof DOMException && error.name === 'AbortError') ||
        (error instanceof Error && (error.name === 'AbortError' || error.message.includes('aborted')))
      ) {
        this.logger.error(`Agent request timed out after ${elapsed}ms`);
        throw new Error(`Agent at ${endpointUrl} did not respond within ${this.timeoutMs}ms`);
      }

      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Agent request failed (${elapsed}ms): ${message}`);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async requestReversiMoveFromOpenClaw(
    agent: AgentInfo,
    moveRequest: MoveRequest,
    context?: { side: string; agentId: string },
  ): Promise<MoveResponse> {
    const openclawAgent: OpenClawAgentInfo = {
      openclawUrl: agent.openclawUrl!,
      openclawToken: agent.openclawToken!,
      openclawAgentId: agent.openclawAgentId || 'main',
    };

    const result = await this.openclawClient.getReversiMove(openclawAgent, {
      matchId: moveRequest.matchId,
      board: moveRequest.board,
      yourPiece: moveRequest.yourPiece,
      legalMoves: moveRequest.legalMoves,
      moveNumber: moveRequest.moveNumber,
    }, context);

    this.logger.log(
      `OpenClaw reversi agent responded (source=${result.source}, match=${moveRequest.matchId})`,
    );

    return result.move as MoveResponse;
  }

  async requestChessMoveFromOpenClaw(
    agent: AgentInfo,
    moveRequest: ChessMoveRequest,
    context?: { side: string; agentId: string },
  ): Promise<ChessMoveResponse> {
    const openclawAgent: OpenClawAgentInfo = {
      openclawUrl: agent.openclawUrl!,
      openclawToken: agent.openclawToken!,
      openclawAgentId: agent.openclawAgentId || 'main',
    };

    const result = await this.openclawClient.getChessMove(openclawAgent, {
      matchId: moveRequest.matchId,
      fen: moveRequest.fen,
      board: moveRequest.board,
      yourColor: moveRequest.yourColor,
      legalMoves: moveRequest.legalMoves,
      moveNumber: moveRequest.moveNumber,
      isCheck: moveRequest.isCheck,
      moveHistory: moveRequest.moveHistory,
    }, context);

    this.logger.log(
      `OpenClaw chess agent responded (source=${result.source}, match=${moveRequest.matchId})`,
    );

    return result.move as ChessMoveResponse;
  }

  async requestPokerMoveFromOpenClaw(
    agent: AgentInfo,
    moveRequest: PokerMoveRequest,
    context?: { side: string; agentId: string },
  ): Promise<PokerMoveResponse> {
    const openclawAgent: OpenClawAgentInfo = {
      openclawUrl: agent.openclawUrl!,
      openclawToken: agent.openclawToken!,
      openclawAgentId: agent.openclawAgentId || 'main',
    };

    const result = await this.openclawClient.getPokerMove(openclawAgent, moveRequest, context);

    this.logger.log(
      `OpenClaw poker agent responded (source=${result.source}, match=${moveRequest.matchId})`,
    );

    // Throw on persistent errors so the turn controller increments timeouts
    // and eventually ends the match instead of looping folds forever
    if (result.source === 'error') {
      throw new Error(`OpenClaw poker error: ${result.error || 'unknown'}`);
    }

    return result.move as PokerMoveResponse;
  }

  getOpenClawClient(): OpenClawClientService {
    return this.openclawClient;
  }
}
