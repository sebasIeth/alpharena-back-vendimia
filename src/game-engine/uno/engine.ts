import { randomUUID } from 'crypto';
import {
  UnoCard, UnoCardColor, UnoCardType, UnoAction,
  UnoGameState, UnoPlayerState,
} from '../../common/types/uno.types';

// ── Deck Building ───────────────────────────────────────────────────────────

const COLORS: UnoCardColor[] = ['RED', 'BLUE', 'GREEN', 'YELLOW'];

function makeCard(color: UnoCardColor, type: UnoCardType, value: number | null): UnoCard {
  return { id: randomUUID(), color, type, value };
}

/** Build a standard 108-card UNO deck. */
export function createDeck(): UnoCard[] {
  const cards: UnoCard[] = [];

  for (const color of COLORS) {
    // One 0 per color
    cards.push(makeCard(color, 'NUMBER', 0));
    // Two each of 1-9
    for (let n = 1; n <= 9; n++) {
      cards.push(makeCard(color, 'NUMBER', n));
      cards.push(makeCard(color, 'NUMBER', n));
    }
    // Two each of Skip, Reverse, Draw Two
    for (let i = 0; i < 2; i++) {
      cards.push(makeCard(color, 'SKIP', null));
      cards.push(makeCard(color, 'REVERSE', null));
      cards.push(makeCard(color, 'DRAW_TWO', null));
    }
  }

  // 4 Wild, 4 Wild Draw Four
  for (let i = 0; i < 4; i++) {
    cards.push(makeCard('BLACK', 'WILD', null));
    cards.push(makeCard('BLACK', 'WILD_DRAW_FOUR', null));
  }

  return cards;
}

/** Fisher-Yates shuffle (in-place). */
export function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── Turn Helpers ────────────────────────────────────────────────────────────

/** Side letter from index: 0->'a', 1->'b', etc. */
function sideFromIndex(i: number): string {
  return String.fromCharCode(97 + i);
}

/** Index from side letter: 'a'->0, 'b'->1, etc. */
function indexFromSide(side: string): number {
  return side.charCodeAt(0) - 97;
}

/** Get the next side in turn order, respecting direction. */
function getNextSide(current: string, direction: 1 | -1, playerCount: number): string {
  const idx = indexFromSide(current);
  const next = ((idx + direction) % playerCount + playerCount) % playerCount;
  return sideFromIndex(next);
}

/** Get all side letters for a given player count. */
function getSides(playerCount: number): string[] {
  return Array.from({ length: playerCount }, (_, i) => sideFromIndex(i));
}

// ── Initial State ───────────────────────────────────────────────────────────

export function createInitialState(playerCount: number = 2): UnoGameState {
  if (playerCount < 2 || playerCount > 4) throw new Error('UNO supports 2-4 players');

  let deck = shuffle(createDeck());
  const sides = getSides(playerCount);

  // Deal 7 cards to each player
  const players: Record<string, UnoPlayerState> = {};
  for (const side of sides) {
    players[side] = { hand: deck.splice(0, 7), isActive: true };
  }

  // Flip starter card — if Wild Draw Four, reshuffle and redraw
  let starter: UnoCard;
  while (true) {
    starter = deck.shift()!;
    if (starter.type !== 'WILD_DRAW_FOUR') break;
    deck.push(starter);
    deck = shuffle(deck);
  }

  const discardPile = [starter];
  const drawPile = deck;

  // Determine starting color
  let currentColor: UnoCardColor = starter.color;
  if (starter.color === 'BLACK') {
    currentColor = COLORS[Math.floor(Math.random() * 4)];
  }

  let direction: 1 | -1 = 1;
  let currentTurn = 'a';

  // Apply starter card effects
  if (starter.type === 'SKIP') {
    // Skip first player → next player
    currentTurn = getNextSide('a', direction, playerCount);
    if (playerCount === 2) currentTurn = getNextSide(currentTurn, direction, playerCount); // skip wraps back
  } else if (starter.type === 'REVERSE') {
    direction = -1;
    if (playerCount === 2) {
      // 2 players: reverse = skip
      currentTurn = 'b';
    } else {
      // N players: reverse direction, last player goes first
      currentTurn = getNextSide('a', direction, playerCount);
    }
  } else if (starter.type === 'DRAW_TWO') {
    // First player draws 2, turn goes to next
    for (let i = 0; i < 2 && drawPile.length > 0; i++) {
      players.a.hand.push(drawPile.shift()!);
    }
    currentTurn = getNextSide('a', direction, playerCount);
  }

  return {
    players,
    drawPile,
    discardPile,
    currentTurn,
    currentColor,
    direction,
    status: 'playing',
    winner: null,
    lastAction: null,
    moveCount: 0,
  };
}

// ── Legal Actions ───────────────────────────────────────────────────────────

/** Get all legal actions for the current player. */
export function getLegalActions(state: UnoGameState): UnoAction[] {
  const player = state.players[state.currentTurn];
  if (!player) return [];

  const topCard = state.discardPile[state.discardPile.length - 1];
  const actions: UnoAction[] = [];

  for (const card of player.hand) {
    if (canPlayCard(card, topCard, state.currentColor)) {
      if (card.type === 'WILD' || card.type === 'WILD_DRAW_FOUR') {
        for (const color of COLORS) {
          actions.push({ type: 'PLAY_CARD', cardId: card.id, chosenColor: color });
        }
      } else {
        actions.push({ type: 'PLAY_CARD', cardId: card.id });
      }
    }
  }

  actions.push({ type: 'DRAW_CARD' });
  return actions;
}

/** Check if a card can be played on the current discard. */
function canPlayCard(card: UnoCard, topCard: UnoCard, currentColor: UnoCardColor): boolean {
  if (card.type === 'WILD' || card.type === 'WILD_DRAW_FOUR') return true;
  if (card.color === currentColor) return true;
  if (card.type === 'NUMBER' && topCard.type === 'NUMBER' && card.value === topCard.value) return true;
  if (card.type !== 'NUMBER' && card.type === topCard.type) return true;
  return false;
}

// ── Apply Action ────────────────────────────────────────────────────────────

/** Apply an action to the game state. Returns the new state (mutates in place). */
export function applyAction(state: UnoGameState, action: UnoAction): UnoGameState {
  const side = state.currentTurn;
  const player = state.players[side];
  const playerCount = Object.keys(state.players).length;
  const nextSide = getNextSide(side, state.direction, playerCount);

  state.lastAction = action;
  state.moveCount++;

  if (action.type === 'PLAY_CARD') {
    const cardIdx = player.hand.findIndex((c) => c.id === action.cardId);
    if (cardIdx === -1) throw new Error(`Card ${action.cardId} not in hand`);

    const card = player.hand.splice(cardIdx, 1)[0];
    state.discardPile.push(card);

    // Update current color
    if (card.type === 'WILD' || card.type === 'WILD_DRAW_FOUR') {
      state.currentColor = action.chosenColor || COLORS[0];
    } else {
      state.currentColor = card.color;
    }

    // Check win condition
    if (player.hand.length === 0) {
      state.status = 'finished';
      state.winner = side;
      return state;
    }

    // Apply card effects
    switch (card.type) {
      case 'SKIP':
        // Skip next player → turn goes to the one after
        state.currentTurn = getNextSide(nextSide, state.direction, playerCount);
        break;

      case 'REVERSE':
        state.direction = (state.direction === 1 ? -1 : 1) as 1 | -1;
        if (playerCount === 2) {
          // 2 players: reverse = skip
          state.currentTurn = side;
        } else {
          // N players: reverse direction, next player in new direction
          state.currentTurn = getNextSide(side, state.direction, playerCount);
        }
        break;

      case 'DRAW_TWO':
        // Next player draws 2 and loses turn
        drawCards(state, nextSide, 2);
        state.currentTurn = getNextSide(nextSide, state.direction, playerCount);
        break;

      case 'WILD_DRAW_FOUR':
        // Next player draws 4 and loses turn
        drawCards(state, nextSide, 4);
        state.currentTurn = getNextSide(nextSide, state.direction, playerCount);
        break;

      default:
        // Normal card or WILD without draw: advance to next player
        state.currentTurn = nextSide;
        break;
    }
  } else if (action.type === 'DRAW_CARD') {
    recycleIfEmpty(state);
    if (state.drawPile.length > 0) {
      const drawnCard = state.drawPile.shift()!;
      player.hand.push(drawnCard);

      const topCard = state.discardPile[state.discardPile.length - 1];
      if (canPlayCard(drawnCard, topCard, state.currentColor)) {
        state.lastAction = { type: 'DRAW_CARD' };
        return state; // Don't change turn — agent can play the drawn card
      }
    }
    state.currentTurn = nextSide;
  } else if (action.type === 'PASS') {
    state.currentTurn = nextSide;
  }

  return state;
}

/** Draw N cards from the draw pile into a player's hand, recycling discard if needed. */
function drawCards(state: UnoGameState, side: string, count: number): void {
  for (let i = 0; i < count; i++) {
    recycleIfEmpty(state);
    if (state.drawPile.length === 0) break;
    state.players[side].hand.push(state.drawPile.shift()!);
  }
}

/** If draw pile is empty, recycle discard pile (keep top card). */
function recycleIfEmpty(state: UnoGameState): void {
  if (state.drawPile.length > 0) return;
  if (state.discardPile.length <= 1) return;

  const topCard = state.discardPile.pop()!;
  state.drawPile = shuffle([...state.discardPile]);
  state.discardPile = [topCard];
}

// ── Serialization Helpers ───────────────────────────────────────────────────

/** Create a spectator-safe view (hides hands). */
export function toSpectatorView(state: UnoGameState): Record<string, unknown> {
  const handCounts: Record<string, number> = {};
  for (const [side, p] of Object.entries(state.players)) {
    handCounts[side] = p.hand.length;
  }
  return {
    currentTurn: state.currentTurn,
    currentColor: state.currentColor,
    direction: state.direction,
    status: state.status,
    winner: state.winner,
    lastAction: state.lastAction,
    moveCount: state.moveCount,
    topCard: state.discardPile[state.discardPile.length - 1],
    drawPileCount: state.drawPile.length,
    handCounts,
    playerCount: Object.keys(state.players).length,
  };
}

/** Create a player-specific view (shows only their hand). */
export function toPlayerView(state: UnoGameState, side: string): Record<string, unknown> {
  return {
    ...toSpectatorView(state),
    hand: state.players[side].hand,
  };
}
