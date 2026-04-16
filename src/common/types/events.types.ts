import { Board } from './game.types';

export interface MatchCreatedEvent {
  matchId: string;
  agents: Record<string, { agentId: string; name: string }>;
  gameType: string;
  stakeAmount: number;
}

export interface MatchStartedEvent {
  matchId: string;
  gameType: string;
  board: Board;
  // Marrakech-specific
  assam?: { position: { row: number; col: number }; direction: string };
  players?: { id: number; name: string; dirhams: number; carpetsRemaining: number }[];
  // Chess-specific
  fen?: string;
  // Poker-specific
  pokerPlayerStacks?: Record<string, number>;
  pokerHandNumber?: number;
  // RPS-specific
  rpsTotalRounds?: number;
  rpsRound?: number;
  rpsPhase?: string;
  rpsScores?: { a: number; b: number };
  // UNO-specific
  unoState?: Record<string, unknown>;
  // Werewolf-specific
  werewolfState?: Record<string, unknown>;
}

export interface MatchMoveEvent {
  matchId: string;
  side?: string;
  move?: { row: number; col: number };
  boardState?: Board;
  score?: Record<string, number>;
  moveNumber?: number;
  thinkingTimeMs?: number;
  // Marrakech-specific
  assam?: { position: { row: number; col: number }; direction: string };
  diceResult?: { value: number; faces: number[] };
  movePath?: { row: number; col: number }[];
  phase?: string;
  tribute?: { fromPlayerId: number; toPlayerId: number; amount: number } | null;
  players?: { id: number; name: string; dirhams: number; carpetsRemaining: number; eliminated: boolean }[];
  // Chess-specific
  chessMove?: string;
  fen?: string;
  isCheck?: boolean;
  // Poker-specific
  pokerAction?: { type: string; amount?: number };
  pokerStreet?: string;
  pokerPot?: number;
  pokerCommunityCards?: { rank: string; suit: string }[];
  pokerPlayerStacks?: Record<string, number>;
  pokerHandNumber?: number;
  pokerPlayers?: { seatIndex: number; side: string; stack: number; holeCards: { rank: string; suit: string }[]; currentBet: number; hasFolded: boolean; isAllIn: boolean; isDealer: boolean }[];
  pokerShowdownResult?: { winnerSide: string; winnerHand?: { rank: number; description: string }; loserHand?: { rank: number; description: string } } | null;
  pokerHandResult?: { handNumber: number; holeCards: Record<string, { rank: string; suit: string }[]>; communityCards: { rank: string; suit: string }[]; result: string; winner: string | null; pot: number };
  // RPS-specific
  rpsRound?: number;
  rpsTotalRounds?: number;
  rpsPhase?: string;
  rpsScores?: { a: number; b: number };
  rpsResult?: { roundNumber: number; throwA: string; throwB: string; winner: string };
  // UNO-specific
  unoAction?: { type: string; cardId?: string; chosenColor?: string };
  unoPhase?: string;
  // Werewolf-specific
  werewolfAction?: { type: string; target?: string; role?: string };
  werewolfPhase?: string;
  cycle?: number;
  activeSide?: string | null;
  werewolfPlayers?: Record<string, unknown>;
  discussionLog?: unknown[];
  deaths?: unknown[];
  currentTurn?: string;
  currentColor?: string;
  topCard?: { id: string; color: string; type: string; value: number | null };
  drawPileCount?: number;
  handCounts?: Record<string, number>;
  status?: string;
  winner?: string | null;
  lastAction?: unknown;
  direction?: number;
}

export interface MatchTimeoutEvent {
  matchId: string;
  side: string;
  timeoutCount: number;
}

export interface MatchEndedEvent {
  matchId: string;
  agentIds: Record<string, string>;
  gameType: string;
  result: {
    winnerId: string | null;
    reason: string;
    finalScore: { a: number; b: number };
    totalMoves: number;
  };
}

export interface MatchErrorEvent {
  matchId: string;
  agentIds?: Record<string, string>;
  error: string;
}

export interface AgentThinkingEvent {
  matchId: string;
  side: string;
  agentId: string;
  raw: string;
  moveNumber: number;
}

export interface MatchmakingCountdownEvent {
  gameType: string;
  remainingMs: number;
  agents: { agentId: string; eloRating: number }[];
}

export interface MatchmakingMatchedEvent {
  matchId: string;
  gameType: string;
  agents: string[];
}

export interface MatchYourTurnEvent {
  matchId: string;
  side: string;
  gameType: string;
  board?: Board;
  legalMoves?: unknown[];
  fen?: string;
  moveNumber?: number;
  timeRemainingMs?: number;
  turnTimeoutMs?: number;
  // Poker-specific
  pokerHoleCards?: { rank: string; suit: string }[];
  pokerCommunityCards?: { rank: string; suit: string }[];
  pokerPot?: number;
  pokerPlayerStacks?: Record<string, number>;
  pokerStreet?: string;
  pokerHandNumber?: number;
  pokerIsDealer?: boolean;
  pokerActionHistory?: { type: string; amount?: number; playerSide: string; street: string }[];
  // RPS-specific
  rpsRound?: number;
  rpsTotalRounds?: number;
  rpsPhase?: string;
  rpsScores?: { a: number; b: number };
  // UNO-specific
  legalActions?: unknown[];
  hand?: unknown[];
  opponentCardCount?: number;
  topCard?: unknown;
  currentColor?: string;
  currentTurn?: string;
  drawPileCount?: number;
  handCounts?: Record<string, number>;
  // Werewolf-specific
  yourRole?: string;
  yourDisplayName?: string;
  knownWerewolves?: string[];
  seerMemory?: unknown[];
  werewolfPhase?: string;
  cycle?: number;
  activeSide?: string | null;
  werewolfPlayers?: Record<string, unknown>;
  discussionLog?: unknown[];
  deaths?: unknown[];
  status?: string;
}

export interface EventBusEvents {
  'match:created': MatchCreatedEvent;
  'match:started': MatchStartedEvent;
  'match:move': MatchMoveEvent;
  'match:timeout': MatchTimeoutEvent;
  'match:ended': MatchEndedEvent;
  'match:error': MatchErrorEvent;
  'agent:thinking': AgentThinkingEvent;
  'matchmaking:countdown': MatchmakingCountdownEvent;
  'matchmaking:matched': MatchmakingMatchedEvent;
  'match:your_turn': MatchYourTurnEvent;
}

export type EventName = keyof EventBusEvents;
