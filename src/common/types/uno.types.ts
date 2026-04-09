// ── UNO Game Types ──────────────────────────────────────────────────────────

export type UnoCardColor = 'RED' | 'BLUE' | 'GREEN' | 'YELLOW' | 'BLACK';
export type UnoCardType = 'NUMBER' | 'SKIP' | 'REVERSE' | 'DRAW_TWO' | 'WILD' | 'WILD_DRAW_FOUR';
export type UnoActionType = 'PLAY_CARD' | 'DRAW_CARD' | 'PASS';

export interface UnoCard {
  id: string;
  color: UnoCardColor;
  type: UnoCardType;
  value: number | null; // 0-9 for NUMBER cards, null otherwise
}

export interface UnoAction {
  type: UnoActionType;
  cardId?: string;              // for PLAY_CARD
  chosenColor?: UnoCardColor;   // for WILD and WILD_DRAW_FOUR
}

export interface UnoPlayerState {
  hand: UnoCard[];
  isActive: boolean;
}

export interface UnoGameState {
  players: Record<string, UnoPlayerState>; // keyed by side: 'a', 'b'
  drawPile: UnoCard[];
  discardPile: UnoCard[];
  currentTurn: string;           // side letter
  currentColor: UnoCardColor;
  direction: 1 | -1;
  status: 'waiting' | 'playing' | 'finished';
  winner: string | null;
  lastAction: UnoAction | null;
  moveCount: number;
}

export interface UnoMoveRequest {
  matchId: string;
  gameType: 'uno';
  yourSide: string;
  hand: UnoCard[];
  topCard: UnoCard;
  currentColor: UnoCardColor;
  opponentCardCount: number;
  legalActions: UnoAction[];
  moveNumber: number;
  timeRemainingMs: number;
}

export interface UnoTurnResult {
  unoState: UnoGameState;
  matchOver: boolean;
  winner: string | null; // side letter
}
