// ── Werewolf Game Types ─────────────────────────────────────────────────────

export type WerewolfRole = 'WEREWOLF' | 'SEER' | 'VILLAGER';

export type WerewolfPhase =
  | 'NIGHT_WOLVES'
  | 'NIGHT_SEER'
  | 'DAY_DISCUSSION'
  | 'DAY_VOTE'
  | 'FINISHED';

export type WerewolfWinner = 'VILLAGERS' | 'WEREWOLVES' | 'DRAW' | null;

export type WerewolfActionType =
  | 'NIGHT_KILL_VOTE'
  | 'SEER_INVESTIGATE'
  | 'DAY_ACCUSE'
  | 'DAY_DEFEND'
  | 'DAY_CLAIM'
  | 'DAY_PASS'
  | 'DAY_VOTE';

export type WerewolfAction =
  | { type: 'NIGHT_KILL_VOTE'; target: string }
  | { type: 'SEER_INVESTIGATE'; target: string }
  | { type: 'DAY_ACCUSE'; target: string }
  | { type: 'DAY_DEFEND'; target: string }
  | { type: 'DAY_CLAIM'; role: WerewolfRole }
  | { type: 'DAY_PASS' }
  | { type: 'DAY_VOTE'; target: string };

export interface WerewolfPlayerState {
  side: string;
  displayName: string;
  role: WerewolfRole;
  isAlive: boolean;
  deathCycle: number | null;
  deathCause: 'night' | 'day' | null;
}

export interface WerewolfSeerMemoryEntry {
  cycle: number;
  target: string;
  targetDisplayName: string;
  isWerewolf: boolean;
}

export interface WerewolfDiscussionEvent {
  cycle: number;
  speaker: string;
  speakerDisplayName: string;
  action:
    | { type: 'DAY_ACCUSE'; target: string; targetDisplayName: string }
    | { type: 'DAY_DEFEND'; target: string; targetDisplayName: string }
    | { type: 'DAY_CLAIM'; role: WerewolfRole }
    | { type: 'DAY_PASS' };
}

export interface WerewolfDeathEvent {
  cycle: number;
  side: string;
  displayName: string;
  role: WerewolfRole;
  cause: 'night' | 'day';
}

export interface WerewolfGameState {
  players: Record<string, WerewolfPlayerState>;
  phase: WerewolfPhase;
  cycle: number;
  activeSide: string | null;

  // Night-phase scratch (cleared on phase advance)
  nightWolfVotes: Record<string, string>;
  nightKillTarget: string | null;
  pendingSeerCheck: boolean;

  // Seer private memory
  seerMemory: WerewolfSeerMemoryEntry[];

  // Day phase
  discussionLog: WerewolfDiscussionEvent[];
  discussionTurnsTaken: Record<string, number>;
  dayVotes: Record<string, string>;

  // Public history
  deaths: WerewolfDeathEvent[];

  // Meta
  status: 'waiting' | 'playing' | 'finished';
  winner: WerewolfWinner;
  lastAction: WerewolfAction | null;
  moveCount: number;
  rngSeed: string;
}

export interface WerewolfMoveRequest {
  matchId: string;
  gameType: 'werewolf';
  yourSide: string;
  yourDisplayName: string;
  yourRole: WerewolfRole;
  yourSeerMemory?: WerewolfSeerMemoryEntry[];
  knownWerewolves?: string[];
  phase: WerewolfPhase;
  cycle: number;
  alivePlayers: { side: string; displayName: string }[];
  deaths: WerewolfDeathEvent[];
  discussionLog: WerewolfDiscussionEvent[];
  legalActions: WerewolfAction[];
  moveNumber: number;
  timeRemainingMs: number;
}

export interface WerewolfTurnResult {
  werewolfState: WerewolfGameState;
  matchOver: boolean;
  winner: WerewolfWinner;
}

export const WEREWOLF_PLAYER_COUNT = 7;
export const WEREWOLF_MAX_CYCLES = 6;
export const WEREWOLF_MAX_DISCUSSION_TURNS_PER_PLAYER = 2;
