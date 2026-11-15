import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { initGame, playCard, drawCard, passTurn, callMakao, catchMakao } from './game/engine';
import { GameState } from './game/types';

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

interface Room {
  id: string;
  name: string;
  players: any[];
  game?: GameState;
}
const rooms = new Map<string, Room>();
const roomTimers = new Map<string, NodeJS.Timeout>();

app.get('/health', (_, res) => res.json({ ok: true, rooms: rooms.size }));

io.on('connection', (socket) => {
  socket.on('room:list', (cb) => {
    const openRooms = Array.from(rooms.values()).filter(r => !r.game).map(r => ({ id: r.id, name: r.name, count: r.players.length }));
    cb?.(openRooms);
  });

  socket.on('room:create', ({ name, roomName, clientId }, cb) => {
    const roomId = Math.random().toString(36).substring(2, 6).toUpperCase();
    rooms.set(roomId, { id: roomId, name: roomName || `Pokój ${name}`, players: [{ id: clientId, name, socketId: socket.id }] });
    socket.join(roomId);
    cb?.({ roomId, roomName });
  });

  socket.on('room:join', ({ roomId, name, clientId }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb?.({ error: 'Pokój nie istnieje' });
    if (room.game) return cb?.({ error: 'Gra już trwa' });
    
    let player = room.players.find(p => p.id === clientId);
    if (player) {
      player.socketId = socket.id;
    } else {
      if (room.players.length >= 4) return cb?.({ error: 'Pokój jest pełny' });
      room.players.push({ id: clientId, name, socketId: socket.id });
    }
    
    socket.join(roomId);
    io.to(roomId).emit('room:update', { players: room.players });
    cb?.({ success: true });
  });

  socket.on('game:reconnect', ({ roomId, clientId }, cb) => {
    const room = rooms.get(roomId);
    if (!room || !room.game) return cb?.({ error: 'Brak aktywnej gry' });
    
    const player = room.players.find(p => p.id === clientId);
    if (!player) return cb?.({ error: 'Nie ma Cię w tym pokoju' });

    player.socketId = socket.id;
    socket.join(roomId);
    
    const gamePlayer = room.game.players.find(p => p.id === clientId);
    if (gamePlayer) gamePlayer.connected = true;
    
    cb?.({ success: true });
    broadcastState(roomId, room.game);
  });

  socket.on('game:start', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.players.length < 2) return;
    room.game = initGame(roomId, room.players);
    io.to(roomId).emit('game:started');
    startTurnTimer(roomId);
    broadcastState(roomId, room.game);
  });

  socket.on('game:requestState', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (room?.game) broadcastState(roomId, room.game);
  });

  socket.on('game:play', ({ roomId, card, chosenSuit, clientId }) => {
    const room = rooms.get(roomId);
    if (!room?.game) return;
    try {
      const newState = playCard(room.game, clientId, card);
      if (card.rank === 'J' && chosenSuit) newState.currentSuit = chosenSuit;
      room.game = newState;
      startTurnTimer(roomId);
      broadcastState(roomId, room.game);
    } catch (e: any) { socket.emit('game:error', { message: e.message }); }
  });

  socket.on('game:draw', ({ roomId, clientId }) => {
    const room = rooms.get(roomId);
    if (!room?.game) return;
    try {
      room.game = drawCard(room.game, clientId);
      startTurnTimer(roomId);
      broadcastState(roomId, room.game);
    } catch (e: any) { socket.emit('game:error', { message: e.message }); }
  });

  socket.on('game:pass', ({ roomId, clientId }) => {
    const room = rooms.get(roomId);
    if (!room?.game) return;
    try {
      room.game = passTurn(room.game, clientId);
      startTurnTimer(roomId);
      broadcastState(roomId, room.game);
    } catch (e: any) { socket.emit('game:error', { message: e.message }); }
  });

  socket.on('game:makao', ({ roomId, clientId }) => {
    const room = rooms.get(roomId);
    if (!room?.game) return;
    room.game = callMakao(room.game, clientId);
    broadcastState(roomId, room.game);
  });

  socket.on('game:catch', ({ roomId, targetId, clientId }) => {
    const room = rooms.get(roomId);
    if (!room?.game) return;
    try {
      room.game = catchMakao(room.game, clientId, targetId);
      broadcastState(roomId, room.game);
    } catch (e: any) { socket.emit('game:error', { message: e.message }); }
  });

  socket.on('game:rematch', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || !room.game) return;
    room.game = initGame(roomId, room.players);
    startTurnTimer(roomId);
    broadcastState(roomId, room.game);
  });

  socket.on('chat:message', ({ roomId, text, senderName }) => {
    io.to(roomId).emit('chat:message', { senderName, text });
  });

  socket.on('disconnect', () => {
    rooms.forEach((room) => {
      const player = room.players.find(p => p.socketId === socket.id);
      if (player && room.game) {
        const gamePlayer = room.game.players.find(p => p.id === player.id);
        if (gamePlayer) gamePlayer.connected = false;
        broadcastState(room.id, room.game);
      }
    });
  });

  function startTurnTimer(roomId: string) {
    if (roomTimers.has(roomId)) clearTimeout(roomTimers.get(roomId));
    
    const timer = setTimeout(() => {
      const room = rooms.get(roomId);
      if (room?.game && !room.game.winnerId) {
        const currentPlayer = room.game.players[room.game.currentTurnIndex];
        try {
          // POPRAWKA: Jeśli gracz już dobrał i nie ma kary, to pasuje. Inaczej dobiera.
          if (room.game.hasDrawnInTurn && room.game.pendingDraw === 0) {
            room.game = passTurn(room.game, currentPlayer.id);
          } else {
            room.game = drawCard(room.game, currentPlayer.id);
          }
          startTurnTimer(roomId);
          broadcastState(roomId, room.game);
        } catch (e) { console.error('Timer error:', e); }
      }
    }, 31000);
    roomTimers.set(roomId, timer);
  }

  function broadcastState(roomId: string, state: GameState) {
    state.players.forEach(p => {
      const publicState = {
        players: state.players.map(pl => ({ id: pl.id, name: pl.name, cardCount: pl.hand.length, connected: pl.connected })),
        discardTop: state.discardPile[state.discardPile.length - 1],
        currentTurnIndex: state.currentTurnIndex,
        currentSuit: state.currentSuit,
        winnerId: state.winnerId,
        pendingDraw: state.pendingDraw,
        hasDrawnInTurn: state.hasDrawnInTurn,
        makaoPlayers: state.makaoPlayers,
        turnEndTime: state.turnEndTime,
      };
      const room = rooms.get(roomId);
      const playerSocket = room?.players.find(pl => pl.id === p.id)?.socketId;
      if (playerSocket) io.to(playerSocket).emit('game:state', { ...publicState, myHand: p.hand });
    });
  }
});

const PORT = 3000;
server.listen(PORT, () => console.log(`🚀 Serwer działa na http://localhost:${PORT}`));