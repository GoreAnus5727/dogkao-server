import { Card, GameState, PlayerState, Rank, Suit } from './types';

const SUITS: Suit[] = ['H', 'D', 'C', 'S'];
const RANKS: Rank[] = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank });
    }
  }
  return shuffle(deck);
}

function shuffle<T>(array: T[]): T[] {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function initGame(roomId: string, players: { id: string; name: string }[]): GameState {
  const deck = createDeck();
  const playerStates: PlayerState[] = players.map(p => ({ ...p, hand: [], connected: true }));

  for (let i = 0; i < 5; i++) {
    for (const p of playerStates) {
      p.hand.push(deck.pop()!);
    }
  }

  let firstCard = deck.pop()!;
  while (['2','3','4','K','A','J'].includes(firstCard.rank)) {
    deck.unshift(firstCard);
    firstCard = deck.pop()!;
  }

  return {
    roomId,
    players: playerStates,
    deck,
    discardPile: [firstCard],
    currentTurnIndex: 0,
    pendingDraw: 0,
    currentSuit: firstCard.suit,
    hasDrawnInTurn: false,
    makaoPlayers: [],
    turnEndTime: Date.now() + 30000, // 30 sekund
  };
}

export function canPlayCard(state: GameState, card: Card): boolean {
  const top = state.discardPile[state.discardPile.length - 1];
  if (state.pendingDraw > 0) return card.rank === top.rank; 
  if (card.rank === 'J') return true;
  if (card.suit === state.currentSuit) return true;
  if (card.rank === top.rank) return true;
  return false;
}

export function playCard(state: GameState, playerId: string, card: Card): GameState {
  if (state.winnerId) throw new Error('Gra już zakończona');
  const playerIndex = state.players.findIndex(p => p.id === playerId);
  if (playerIndex !== state.currentTurnIndex) throw new Error('Nie twoja kolej');

  const player = state.players[playerIndex];
  const cardIndex = player.hand.findIndex(c => c.suit === card.suit && c.rank === card.rank);
  
  if (cardIndex === -1) throw new Error('Nie masz tej karty');
  if (!canPlayCard(state, card)) throw new Error('Nie możesz zagrać tej karty');

  player.hand.splice(cardIndex, 1);
  state.discardPile.push(card);
  state.currentSuit = card.suit;
  state.hasDrawnInTurn = false; 

  let skipNext = false;
  if (card.rank === '2') state.pendingDraw += 2;
  if (card.rank === '3') state.pendingDraw += 3;
  if (card.rank === 'K' && card.suit === 'H') state.pendingDraw += 5;
  if (card.rank === '4' || card.rank === 'A') skipNext = true;

  let nextIndex = (state.currentTurnIndex + 1) % state.players.length;
  if (skipNext) nextIndex = (nextIndex + 1) % state.players.length;

  state.currentTurnIndex = nextIndex;
  if (player.hand.length === 0) state.winnerId = player.id;
  
  state.turnEndTime = Date.now() + 30000; // Reset czasu
  return state;
}

export function drawCard(state: GameState, playerId: string): GameState {
  if (state.winnerId) throw new Error('Gra już zakończona');
  const playerIndex = state.players.findIndex(p => p.id === playerId);
  if (playerIndex !== state.currentTurnIndex) throw new Error('Nie twoja kolej');

  const player = state.players[playerIndex];
  
  if (state.pendingDraw > 0) {
    for (let i = 0; i < state.pendingDraw; i++) {
      if (state.deck.length === 0) reshuffle(state);
      player.hand.push(state.deck.pop()!);
    }
    state.pendingDraw = 0;
    state.hasDrawnInTurn = false;
    state.currentTurnIndex = (state.currentTurnIndex + 1) % state.players.length;
  } else {
    if (state.deck.length === 0) reshuffle(state);
    player.hand.push(state.deck.pop()!);
    state.hasDrawnInTurn = true; 
  }
  state.turnEndTime = Date.now() + 30000; // Reset czasu
  return state;
}

export function passTurn(state: GameState, playerId: string): GameState {
  const playerIndex = state.players.findIndex(p => p.id === playerId);
  if (playerIndex !== state.currentTurnIndex) throw new Error('Nie twoja kolej');
  if (!state.hasDrawnInTurn) throw new Error('Musisz najpierw dobrać kartę, żeby spasować');

  state.hasDrawnInTurn = false;
  state.currentTurnIndex = (state.currentTurnIndex + 1) % state.players.length;
  state.turnEndTime = Date.now() + 30000; // Reset czasu
  return state;
}

export function callMakao(state: GameState, playerId: string): GameState {
  if (!state.makaoPlayers.includes(playerId)) {
    state.makaoPlayers.push(playerId);
  }
  return state;
}

export function catchMakao(state: GameState, catcherId: string, targetId: string): GameState {
  const target = state.players.find(p => p.id === targetId);
  const catcher = state.players.find(p => p.id === catcherId);
  if (!target || !catcher) throw new Error('Gracz nie istnieje');

  if (target.hand.length === 1 && !state.makaoPlayers.includes(targetId)) {
    for (let i = 0; i < 2; i++) {
      if (state.deck.length === 0) reshuffle(state);
      target.hand.push(state.deck.pop()!);
    }
    state.makaoPlayers.push(targetId); 
  } else {
    for (let i = 0; i < 2; i++) {
      if (state.deck.length === 0) reshuffle(state);
      catcher.hand.push(state.deck.pop()!);
    }
  }
  return state;
}

function reshuffle(state: GameState) {
  const top = state.discardPile.pop()!;
  state.deck = shuffle(state.discardPile);
  state.discardPile = [top];
}