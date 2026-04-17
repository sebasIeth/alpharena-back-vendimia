import { randomUUID, createHash } from 'crypto';
import {
  WerewolfAction,
  WerewolfDeathEvent,
  WerewolfDiscussionEvent,
  WerewolfGameState,
  WerewolfPhase,
  WerewolfPlayerState,
  WerewolfRole,
  WerewolfSeerMemoryEntry,
  WEREWOLF_MAX_CYCLES,
  WEREWOLF_MAX_DISCUSSION_TURNS_PER_PLAYER,
  WEREWOLF_PLAYER_COUNT,
} from '../../common/types/werewolf.types';

const ROLE_DISTRIBUTION: WerewolfRole[] = [
  'WEREWOLF',
  'WEREWOLF',
  'SEER',
  'VILLAGER',
  'VILLAGER',
  'VILLAGER',
  'VILLAGER',
];

function sideFromIndex(i: number): string {
  return String.fromCharCode(97 + i);
}

function getSides(playerCount: number): string[] {
  return Array.from({ length: playerCount }, (_, i) => sideFromIndex(i));
}

function seededShuffle<T>(arr: T[], seed: string): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const hash = createHash('sha256').update(`${seed}:${i}`).digest();
    const j = hash.readUInt32BE(0) % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Deterministic tiebreak: given a seed, phase tag, and tied targets, pick one. */
function deterministicPick(seed: string, tag: string, tied: string[]): string {
  const sorted = [...tied].sort();
  if (sorted.length === 1) return sorted[0];
  const hash = createHash('sha256').update(`${seed}:${tag}`).digest();
  const idx = hash.readUInt32BE(0) % sorted.length;
  return sorted[idx];
}

// ── Initial State ───────────────────────────────────────────────────────────

export function createInitialState(seed?: string, names?: string[]): WerewolfGameState {
  const rngSeed = seed ?? randomUUID();
  const sides = getSides(WEREWOLF_PLAYER_COUNT);
  const shuffledRoles = seededShuffle(ROLE_DISTRIBUTION, rngSeed);

  const players: Record<string, WerewolfPlayerState> = {};
  sides.forEach((side, i) => {
    const name = (names?.[i] && names[i].trim()) || `Player${i + 1}`;
    players[side] = {
      side,
      displayName: name,
      role: shuffledRoles[i],
      isAlive: true,
      deathCycle: null,
      deathCause: null,
    };
  });

  // First active wolf (alphabetical order among wolves)
  const firstWolf = sides.find((s) => players[s].role === 'WEREWOLF')!;

  return {
    players,
    phase: 'NIGHT_WOLVES',
    cycle: 1,
    activeSide: firstWolf,
    nightWolfVotes: {},
    nightKillTarget: null,
    pendingSeerCheck: true,
    seerMemory: [],
    discussionLog: [],
    discussionTurnsTaken: {},
    dayVotes: {},
    deaths: [],
    status: 'playing',
    winner: null,
    lastAction: null,
    moveCount: 0,
    rngSeed,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function aliveSides(state: WerewolfGameState): string[] {
  return Object.values(state.players)
    .filter((p) => p.isAlive)
    .map((p) => p.side)
    .sort();
}

function aliveWolves(state: WerewolfGameState): string[] {
  return Object.values(state.players)
    .filter((p) => p.isAlive && p.role === 'WEREWOLF')
    .map((p) => p.side)
    .sort();
}

function aliveSeer(state: WerewolfGameState): string | null {
  const seer = Object.values(state.players).find(
    (p) => p.isAlive && p.role === 'SEER',
  );
  return seer ? seer.side : null;
}

function firstPendingWolf(state: WerewolfGameState): string | null {
  for (const side of aliveWolves(state)) {
    if (!(side in state.nightWolfVotes)) return side;
  }
  return null;
}

function firstPendingVoter(state: WerewolfGameState): string | null {
  for (const side of aliveSides(state)) {
    if (!(side in state.dayVotes)) return side;
  }
  return null;
}

function nextDiscussionSpeaker(state: WerewolfGameState): string | null {
  const alive = aliveSides(state);
  if (alive.length === 0) return null;

  const currentIdx = state.activeSide ? alive.indexOf(state.activeSide) : -1;
  const n = alive.length;

  // Walk forward from next slot, looking for someone with turns remaining
  for (let step = 1; step <= n; step++) {
    const idx = (currentIdx + step) % n;
    const candidate = alive[idx];
    const taken = state.discussionTurnsTaken[candidate] ?? 0;
    if (taken < WEREWOLF_MAX_DISCUSSION_TURNS_PER_PLAYER) return candidate;
  }
  return null;
}

function allDiscussionExhausted(state: WerewolfGameState): boolean {
  const alive = aliveSides(state);
  return alive.every(
    (s) => (state.discussionTurnsTaken[s] ?? 0) >= WEREWOLF_MAX_DISCUSSION_TURNS_PER_PLAYER,
  );
}

// ── Legal Actions ───────────────────────────────────────────────────────────

export function getLegalActions(state: WerewolfGameState, side: string): WerewolfAction[] {
  if (state.status === 'finished') return [];
  if (state.activeSide !== side) return [];
  const me = state.players[side];
  if (!me || !me.isAlive) return [];

  const alive = aliveSides(state);

  if (state.phase === 'NIGHT_WOLVES') {
    if (me.role !== 'WEREWOLF') return [];
    if (side in state.nightWolfVotes) return [];
    // Can target any alive non-wolf
    return alive
      .filter((s) => state.players[s].role !== 'WEREWOLF')
      .map((target) => ({ type: 'NIGHT_KILL_VOTE' as const, target }));
  }

  if (state.phase === 'NIGHT_SEER') {
    if (me.role !== 'SEER') return [];
    if (!state.pendingSeerCheck) return [];
    const alreadyChecked = new Set(state.seerMemory.map((e) => e.target));
    return alive
      .filter((s) => s !== side && !alreadyChecked.has(s))
      .map((target) => ({ type: 'SEER_INVESTIGATE' as const, target }));
  }

  if (state.phase === 'DAY_DISCUSSION') {
    const others = alive.filter((s) => s !== side);
    const actions: WerewolfAction[] = [];
    for (const target of others) {
      actions.push({ type: 'DAY_ACCUSE', target });
      actions.push({ type: 'DAY_DEFEND', target });
    }
    actions.push({ type: 'DAY_CLAIM', role: 'WEREWOLF' });
    actions.push({ type: 'DAY_CLAIM', role: 'SEER' });
    actions.push({ type: 'DAY_CLAIM', role: 'VILLAGER' });
    actions.push({ type: 'DAY_PASS' });
    return actions;
  }

  if (state.phase === 'DAY_VOTE') {
    if (side in state.dayVotes) return [];
    // Allow voting for self as abstention
    return alive.map((target) => ({ type: 'DAY_VOTE' as const, target }));
  }

  return [];
}

// ── Apply Action ────────────────────────────────────────────────────────────

export function applyAction(
  state: WerewolfGameState,
  side: string,
  action: WerewolfAction,
): WerewolfGameState {
  if (state.status === 'finished') return state;
  if (state.activeSide !== side) {
    throw new Error(`Not ${side}'s turn (active=${state.activeSide})`);
  }

  const legal = getLegalActions(state, side);
  const matches = (a: WerewolfAction, b: WerewolfAction) => JSON.stringify(a) === JSON.stringify(b);
  if (!legal.some((l) => matches(l, action))) {
    throw new Error(`Illegal ${action.type} for side ${side} in phase ${state.phase}`);
  }

  state.lastAction = action;
  state.moveCount++;

  if (action.type === 'NIGHT_KILL_VOTE') {
    state.nightWolfVotes[side] = action.target;
    const nextWolf = firstPendingWolf(state);
    if (nextWolf) {
      state.activeSide = nextWolf;
    } else {
      resolveWolfVote(state);
      advanceFromNightWolves(state);
    }
    return state;
  }

  if (action.type === 'SEER_INVESTIGATE') {
    const targetPlayer = state.players[action.target];
    state.seerMemory.push({
      cycle: state.cycle,
      target: action.target,
      targetDisplayName: targetPlayer.displayName,
      isWerewolf: targetPlayer.role === 'WEREWOLF',
    });
    state.pendingSeerCheck = false;
    resolveNightAndAdvanceToDay(state);
    return state;
  }

  if (
    action.type === 'DAY_ACCUSE' ||
    action.type === 'DAY_DEFEND' ||
    action.type === 'DAY_CLAIM' ||
    action.type === 'DAY_PASS'
  ) {
    const me = state.players[side];
    const ev: WerewolfDiscussionEvent = {
      cycle: state.cycle,
      speaker: side,
      speakerDisplayName: me.displayName,
      action:
        action.type === 'DAY_ACCUSE'
          ? { type: 'DAY_ACCUSE', target: action.target, targetDisplayName: state.players[action.target].displayName }
          : action.type === 'DAY_DEFEND'
          ? { type: 'DAY_DEFEND', target: action.target, targetDisplayName: state.players[action.target].displayName }
          : action.type === 'DAY_CLAIM'
          ? { type: 'DAY_CLAIM', role: action.role }
          : { type: 'DAY_PASS' },
    };
    state.discussionLog.push(ev);
    state.discussionTurnsTaken[side] = (state.discussionTurnsTaken[side] ?? 0) + 1;

    const nextSpeaker = nextDiscussionSpeaker(state);
    if (nextSpeaker && !allDiscussionExhausted(state)) {
      state.activeSide = nextSpeaker;
    } else {
      // Advance to vote
      state.phase = 'DAY_VOTE';
      state.dayVotes = {};
      state.activeSide = aliveSides(state)[0] ?? null;
    }
    return state;
  }

  if (action.type === 'DAY_VOTE') {
    state.dayVotes[side] = action.target;
    const nextVoter = firstPendingVoter(state);
    if (nextVoter) {
      state.activeSide = nextVoter;
    } else {
      resolveDayVote(state);
      advanceFromDayVote(state);
    }
    return state;
  }

  return state;
}

// ── Phase Resolution ────────────────────────────────────────────────────────

function resolveWolfVote(state: WerewolfGameState): void {
  const tallies: Record<string, number> = {};
  for (const target of Object.values(state.nightWolfVotes)) {
    tallies[target] = (tallies[target] ?? 0) + 1;
  }
  const entries = Object.entries(tallies);
  if (entries.length === 0) {
    state.nightKillTarget = null;
    return;
  }
  const max = Math.max(...entries.map(([, n]) => n));
  const tied = entries.filter(([, n]) => n === max).map(([t]) => t);
  state.nightKillTarget = deterministicPick(state.rngSeed, `wolfvote:${state.cycle}`, tied);
}

function advanceFromNightWolves(state: WerewolfGameState): void {
  const seer = aliveSeer(state);
  if (seer && seerHasUncheckedTargets(state, seer)) {
    state.phase = 'NIGHT_SEER';
    state.pendingSeerCheck = true;
    state.activeSide = seer;
  } else {
    resolveNightAndAdvanceToDay(state);
  }
}

function seerHasUncheckedTargets(state: WerewolfGameState, seerSide: string): boolean {
  const checked = new Set(state.seerMemory.map((e) => e.target));
  for (const s of aliveSides(state)) {
    if (s !== seerSide && !checked.has(s)) return true;
  }
  return false;
}

function resolveNightAndAdvanceToDay(state: WerewolfGameState): void {
  // Apply night kill
  if (state.nightKillTarget && state.players[state.nightKillTarget]?.isAlive) {
    killPlayer(state, state.nightKillTarget, 'night');
  }
  state.nightWolfVotes = {};
  state.nightKillTarget = null;
  state.pendingSeerCheck = false;

  if (checkWinCondition(state)) {
    finalizeMatch(state);
    return;
  }

  // Start day discussion
  state.phase = 'DAY_DISCUSSION';
  state.discussionTurnsTaken = {};
  state.activeSide = aliveSides(state)[0] ?? null;
}

function resolveDayVote(state: WerewolfGameState): void {
  const tallies: Record<string, number> = {};
  for (const [voter, target] of Object.entries(state.dayVotes)) {
    // Self-vote counts as abstention
    if (voter === target) continue;
    tallies[target] = (tallies[target] ?? 0) + 1;
  }
  const entries = Object.entries(tallies);
  if (entries.length === 0) return; // no lynch
  const max = Math.max(...entries.map(([, n]) => n));
  const tied = entries.filter(([, n]) => n === max).map(([t]) => t);
  if (tied.length > 1) return; // tie → no lynch
  killPlayer(state, tied[0], 'day');
}

function advanceFromDayVote(state: WerewolfGameState): void {
  state.dayVotes = {};
  if (checkWinCondition(state)) {
    finalizeMatch(state);
    return;
  }

  // Next cycle or safety cap
  if (state.cycle >= WEREWOLF_MAX_CYCLES) {
    state.winner = 'DRAW';
    finalizeMatch(state);
    return;
  }

  state.cycle++;
  state.phase = 'NIGHT_WOLVES';
  state.nightWolfVotes = {};
  state.nightKillTarget = null;
  state.pendingSeerCheck = true;
  const nextWolf = firstPendingWolf(state);
  state.activeSide = nextWolf ?? null;
  if (!state.activeSide) {
    // No wolves alive (shouldn't happen — checkWinCondition would have fired)
    finalizeMatch(state);
  }
}

function killPlayer(state: WerewolfGameState, side: string, cause: 'night' | 'day'): void {
  const player = state.players[side];
  if (!player || !player.isAlive) return;
  player.isAlive = false;
  player.deathCycle = state.cycle;
  player.deathCause = cause;
  const death: WerewolfDeathEvent = {
    cycle: state.cycle,
    side,
    displayName: player.displayName,
    role: player.role,
    cause,
  };
  state.deaths.push(death);
}

/** Returns true if the match is over. Sets state.winner if so. */
export function checkWinCondition(state: WerewolfGameState): boolean {
  const wolvesAlive = aliveWolves(state).length;
  const villagersAlive = aliveSides(state).length - wolvesAlive;

  if (wolvesAlive === 0) {
    state.winner = 'VILLAGERS';
    return true;
  }
  if (wolvesAlive >= villagersAlive) {
    state.winner = 'WEREWOLVES';
    return true;
  }
  return false;
}

function finalizeMatch(state: WerewolfGameState): void {
  state.status = 'finished';
  state.phase = 'FINISHED';
  state.activeSide = null;
}

// ── Views ───────────────────────────────────────────────────────────────────

/** Spectator view: hides all roles and secret info until match finishes. */
export function toSpectatorView(state: WerewolfGameState): Record<string, unknown> {
  const finished = state.status === 'finished';
  const publicPlayers: Record<string, Record<string, unknown>> = {};
  for (const [side, p] of Object.entries(state.players)) {
    publicPlayers[side] = {
      side: p.side,
      displayName: p.displayName,
      isAlive: p.isAlive,
      deathCycle: p.deathCycle,
      deathCause: p.deathCause,
      role: finished ? p.role : undefined,
    };
  }
  return {
    players: publicPlayers,
    phase: state.phase,
    cycle: state.cycle,
    activeSide: state.activeSide,
    discussionLog: state.discussionLog,
    deaths: state.deaths,
    status: state.status,
    winner: state.winner,
    lastAction: redactLastAction(state.lastAction),
    moveCount: state.moveCount,
  };
}

/** Redact night-phase actions to avoid leaking identities via the event log. */
function redactLastAction(action: WerewolfAction | null): WerewolfAction | null {
  if (!action) return null;
  if (action.type === 'NIGHT_KILL_VOTE' || action.type === 'SEER_INVESTIGATE') {
    return null;
  }
  return action;
}

/** Player view: includes own role and role-specific private info. */
export function toPlayerView(state: WerewolfGameState, side: string): Record<string, unknown> {
  const base = toSpectatorView(state);
  const me = state.players[side];
  if (!me) return base;

  const playersOut = base.players as Record<string, Record<string, unknown>>;
  // Reveal own role
  if (playersOut[side]) playersOut[side].role = me.role;

  // Werewolves know each other
  if (me.role === 'WEREWOLF') {
    const coWolves = Object.values(state.players)
      .filter((p) => p.role === 'WEREWOLF')
      .map((p) => p.side);
    for (const s of coWolves) {
      if (playersOut[s]) playersOut[s].role = 'WEREWOLF';
    }
    (base as Record<string, unknown>).knownWerewolves = coWolves.filter((s) => s !== side);
  }

  // Seer sees own memory
  if (me.role === 'SEER') {
    (base as Record<string, unknown>).seerMemory = state.seerMemory;
  }

  (base as Record<string, unknown>).yourRole = me.role;
  (base as Record<string, unknown>).yourDisplayName = me.displayName;
  return base;
}

// ── Persistence Helpers ─────────────────────────────────────────────────────

/** Public snapshot for storage in Mongo (never includes roles until finished). */
export function toPublicSnapshot(state: WerewolfGameState): Record<string, unknown> {
  const finished = state.status === 'finished';
  const playersOut: Record<string, Record<string, unknown>> = {};
  for (const [side, p] of Object.entries(state.players)) {
    playersOut[side] = {
      side: p.side,
      displayName: p.displayName,
      isAlive: p.isAlive,
      deathCycle: p.deathCycle,
      deathCause: p.deathCause,
      role: finished ? p.role : undefined,
    };
  }
  return {
    players: playersOut,
    phase: state.phase,
    cycle: state.cycle,
    activeSide: state.activeSide,
    discussionLog: state.discussionLog,
    deaths: state.deaths,
    status: state.status,
    winner: state.winner,
    lastAction: redactLastAction(state.lastAction),
    moveCount: state.moveCount,
  };
}
