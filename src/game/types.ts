export type Suit = 'H' | 'D' | 'C' | 'S';
export type Rank = '2'|'3'|'4'|'5'|'6'|'7'|'8'|'9'|'10'|'J'|'Q'|'K'|'A';

export interface Card {
  suit: Suit;
  rank: Rank;
}

export interface PlayerState {
  id: string; // To będzie nasze clientId
  name: string;
  hand: Card[];
  connected: boolean; // NOWE
}

export interface GameState {
  roomId: string;
  players: PlayerState[];
  deck: Card[];
  discardPile: Card[];
  currentTurnIndex: number;
  pendingDraw: number;
  currentSuit: Suit;
  winnerId?: string;
  hasDrawnInTurn: boolean;
  makaoPlayers: string[];
  turnEndTime: number; // NOWE: Timestamp (w ms) kiedy kończy się tura
}