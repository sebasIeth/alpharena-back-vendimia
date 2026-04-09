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

// ── Initial State ───────────────────────────────────────────────────────────

export function createInitialState(): UnoGameState {
  let deck = shuffle(createDeck());

  // Deal 7 cards to each player
  const handA: UnoCard[] = deck.splice(0, 7);
  const handB: UnoCard[] = deck.splice(0, 7);

  // Flip starter card — if Wild Draw Four, reshuffle and redraw
  let starter: UnoCard;
  while (true) {
    starter = deck.shift()!;
    if (starter.type !== 'WILD_DRAW_FOUR') break;
    // Put it back, reshuffle
    deck.push(starter);
    deck = shuffle(deck);
  }

  const discardPile = [starter];
  const drawPile = deck;

  // Determine starting color
  let currentColor: UnoCardColor = starter.color;
  if (starter.color === 'BLACK') {
    // Wild as starter — pick random color
    currentColor = COLORS[Math.floor(Math.random() * 4)];
  }

  // Determine starting turn after applying starter card effects
  let currentTurn = 'a';
  if (starter.type === 'SKIP' || starter.type === 'REVERSE') {
    // With 2 players, both Skip and Reverse skip player a's turn
    currentTurn = 'b';
  }

  // If starter is Draw Two, player a draws 2 and turn goes to b
  if (starter.type === 'DRAW_TWO') {
    for (let i = 0; i < 2 && drawPile.length > 0; i++) {
      handA.push(drawPile.shift()!);
    }
    currentTurn = 'b';
  }

  return {
    players: {
      a: { hand: handA, isActive: true },
      b: { hand: handB, isActive: true },
    },
    drawPile,
    discardPile,
    currentTurn,
    currentColor,
    direction: 1,
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
        // Wild cards: one action per color choice
        for (const color of COLORS) {
          actions.push({ type: 'PLAY_CARD', cardId: card.id, chosenColor: color });
        }
      } else {
        actions.push({ type: 'PLAY_CARD', cardId: card.id });
      }
    }
  }

  // Can always draw a card
  actions.push({ type: 'DRAW_CARD' });

  return actions;
}

/** Check if a card can be played on the current discard. */
function canPlayCard(card: UnoCard, topCard: UnoCard, currentColor: UnoCardColor): boolean {
  // Wild and Wild Draw Four are always playable
  if (card.type === 'WILD' || card.type === 'WILD_DRAW_FOUR') return true;

  // Match color
  if (card.color === currentColor) return true;

  // Match number
  if (card.type === 'NUMBER' && topCard.type === 'NUMBER' && card.value === topCard.value) return true;

  // Match symbol (Skip on Skip, Reverse on Reverse, Draw Two on Draw Two)
  if (card.type !== 'NUMBER' && card.type === topCard.type) return true;

  return false;
}

// ── Apply Action ────────────────────────────────────────────────────────────

/** Apply an action to the game state. Returns the new state (mutates in place). */
export function applyAction(state: UnoGameState, action: UnoAction): UnoGameState {
  const side = state.currentTurn;
  const player = state.players[side];
  const opponentSide = side === 'a' ? 'b' : 'a';

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
        // Skip opponent — current player goes again? No — turn passes to opponent but they lose it.
        // With 2 players: skip = opponent loses turn, so current player keeps turn.
        // Actually: skip means next player is skipped. In 2-player, that's the opponent, so turn stays.
        state.currentTurn = side; // stay on current player
        break;

      case 'REVERSE':
        // With 2 players, Reverse acts as Skip
        state.direction = (state.direction === 1 ? -1 : 1) as 1 | -1;
        state.currentTurn = side; // stay on current player (2-player reverse = skip)
        break;

      case 'DRAW_TWO':
        // Opponent draws 2 and loses turn
        drawCards(state, opponentSide, 2);
        state.currentTurn = side; // stay on current player (opponent skipped)
        break;

      case 'WILD_DRAW_FOUR':
        // Opponent draws 4 and loses turn
        drawCards(state, opponentSide, 4);
        state.currentTurn = side; // stay on current player (opponent skipped)
        break;

      default:
        // Normal card or WILD without draw: advance turn
        state.currentTurn = opponentSide;
        break;
    }
  } else if (action.type === 'DRAW_CARD') {
    // Draw 1 card
    recycleIfEmpty(state);
    if (state.drawPile.length > 0) {
      const drawnCard = state.drawPile.shift()!;
      player.hand.push(drawnCard);

      const topCard = state.discardPile[state.discardPile.length - 1];
      // If drawn card is playable, the agent can play it on next action
      // But per rules: "draw 1 card, if not playable → pass"
      // We'll handle this: after draw, if the drawn card is playable we allow a PLAY or PASS
      // For simplicity: draw always ends turn, but we give an extra action if drawn card is playable
      if (canPlayCard(drawnCard, topCard, state.currentColor)) {
        // Return state with same turn — agent gets one more action (play drawn card or pass)
        // The turn controller will request another action
        state.lastAction = { type: 'DRAW_CARD' };
        return state; // Don't change turn — agent can play the drawn card
      }
    }
    // Can't play drawn card (or deck empty) — pass automatically
    state.currentTurn = opponentSide;
  } else if (action.type === 'PASS') {
    // Pass turn (only valid after drawing an unplayable card, handled by turn controller)
    state.currentTurn = opponentSide;
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
    handCounts: {
      a: state.players.a.hand.length,
      b: state.players.b.hand.length,
    },
  };
}

/** Create a player-specific view (shows only their hand). */
export function toPlayerView(state: UnoGameState, side: string): Record<string, unknown> {
  const opponentSide = side === 'a' ? 'b' : 'a';
  return {
    ...toSpectatorView(state),
    hand: state.players[side].hand,
    opponentCardCount: state.players[opponentSide].hand.length,
  };
}
