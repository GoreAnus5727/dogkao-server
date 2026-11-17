import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { User } from './models/User';
import { initGame, playCard, drawCard, passTurn, callMakao, catchMakao, canPlayCard } from './game/engine';
import { GameState, Suit, Rank } from './game/types';

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// WPISZ TUTAJ SWOJ LINK Z MONGODB (pamietaj o podmienieniu hasla!)
const MONGO_URI = 'mongodb+srv://<db_username>:<db_password>@dogkao.wuzcmsl.mongodb.net/<database_name>'; 

mongoose.connect(MONGO_URI).then(() => console.log('✅ Połączono z bazą MongoDB')).catch(err => console.error('❌ Błąd bazy:', err));

interface Room {
  id: string;
  name: string;
  players: any[];
  game?: GameState;
}
const rooms = new Map<string, Room>();
const roomTimers = new Map<string, NodeJS.Timeout>();
const botTimers = new Map<string, NodeJS.Timeout>();

app.get('/health', (_, res) => res.json({ ok: true, rooms: rooms.size }));

io.on('connection', (socket) => {
  
  // --- OBSŁUGA KONT ---
  socket.on('auth:register', async ({ username, password }, cb) => {
    try {
      const existing = await User.findOne({ username });
      if (existing) return cb({ error: 'Ten nick jest już zajęty' });

      const hashedPassword = await bcrypt.hash(password, 10);
      const user = new User({ username, password: hashedPassword, wins: 0 });
      await user.save();
      
      cb({ success: true, userId: user._id.toString(), username: user.username, wins: user.wins });
    } catch (e) {
      cb({ error: 'Błąd serwera' });
    }
  });

  socket.on('auth:login', async ({ username, password }, cb) => {
    try {
      const user = await User.findOne({ username });
      if (!user) return cb({ error: 'Nie ma takiego użytkownika' });

      const isValid = await bcrypt.compare(password, user.password);
      if (!isValid) return cb({ error: 'Złe hasło' });

      cb({ success: true, userId: user._id.toString(), username: user.username, wins: user.wins });
    } catch (e) {
      cb({ error: 'Błąd serwera' });
    }
  });

  socket.on('auth:getLeaderboard', async (cb) => {
    try {
      const topUsers = await User.find().sort({ wins: -1 }).limit(10);
      cb(topUsers.map(u => ({ username: u.username, wins: u.wins })));
    } catch (e) {
      cb([]);
    }
  });

  // --- RESZTA GIER I POKOI ---
  socket.on('room:list', (cb) => {
    const openRooms = Array.from(rooms.values()).filter(r => !r.game).map(r => ({ id: r.id, name: r.name, count: r.players.length }));
    cb?.(openRooms);
  });

  socket.on('room:create', ({ name, roomName, clientId }, cb) => {
    const roomId = Math.random().toString(36).substring(2, 6).toUpperCase();
    const newRoom = { id: roomId, name: roomName || `Pokój ${name}`, players: [{ id: clientId, name, socketId: socket.id }] };
    rooms.set(roomId, newRoom);
    socket.join(roomId);
    io.to(roomId).emit('room:update', { players: newRoom.players });
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

  socket.on('room:addBot', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.game || room.players.length >= 4) return;
    const botNumber = room.players.filter(p => p.id.startsWith('bot_')).length + 1;
    const botId = `bot_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`;
    room.players.push({ id: botId, name: `Bot ${botNumber} 🤖`, socketId: null });
    io.to(roomId).emit('room:update', { players: room.players });
  });

  socket.on('room:leave', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (room) {
      room.game = undefined;
      if (roomTimers.has(roomId)) clearTimeout(roomTimers.get(roomId));
      if (botTimers.has(roomId)) clearTimeout(botTimers.get(roomId));
      socket.leave(roomId);
    }
  });

  // --- START GRY I AKCJE ---
  socket.on('game:rematch', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || !room.game) return;
    room.game = initGame(roomId, room.players);
    io.to(roomId).emit('game:started'); 
    broadcastState(roomId, room.game);
    handleNextTurn(roomId);
  });

  socket.on('game:start', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.players.length < 2) return socket.emit('game:error', { message: 'Potrzebujesz co najmniej 2 graczy!' });
    room.game = initGame(roomId, room.players);
    io.to(roomId).emit('game:started');
    broadcastState(roomId, room.game);
    handleNextTurn(roomId);
  });

  socket.on('game:requestState', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (room?.game) broadcastState(roomId, room.game);
  });

  socket.on('game:play', ({ roomId, card, chosenSuit, requestedRank, clientId }) => {
    const room = rooms.get(roomId);
    if (!room?.game) return;
    try {
      room.game = playCard(room.game, clientId, card, chosenSuit, requestedRank);
      if (roomTimers.has(roomId)) clearTimeout(roomTimers.get(roomId));
      broadcastState(roomId, room.game);
      handleNextTurn(roomId);
    } catch (e: any) { socket.emit('game:error', { message: e.message }); }
  });

  socket.on('game:draw', ({ roomId, clientId }) => {
    const room = rooms.get(roomId);
    if (!room?.game) return;
    try { 
      room.game = drawCard(room.game, clientId); 
      if (roomTimers.has(roomId)) clearTimeout(roomTimers.get(roomId));
      broadcastState(roomId, room.game); 
      handleNextTurn(roomId);
    } catch (e: any) { socket.emit('game:error', { message: e.message }); }
  });

  socket.on('game:pass', ({ roomId, clientId }) => {
    const room = rooms.get(roomId);
    if (!room?.game) return;
    try { 
      room.game = passTurn(room.game, clientId); 
      if (roomTimers.has(roomId)) clearTimeout(roomTimers.get(roomId));
      broadcastState(roomId, room.game); 
      handleNextTurn(roomId);
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
    try { room.game = catchMakao(room.game, clientId, targetId); broadcastState(roomId, room.game); } catch (e: any) { socket.emit('game:error', { message: e.message }); }
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

  // LOGIKA BOTÓW (bez zmian)
  function handleNextTurn(roomId: string) {
    const room = rooms.get(roomId);
    if (!room?.game || room.game.winnerId) return;
    const currentPlayer = room.game.players[room.game.currentTurnIndex];
    
    // NOWE: Jeśli ktoś wygrał, zapisujemy to w bazie!
    if (room.game.winnerId) {
        // Znajdź gracza, sprawdź czy to nie bot, i dodaj wygraną
        const winnerId = room.game.winnerId;
        if (!winnerId.startsWith('bot_')) {
            User.findByIdAndUpdate(winnerId, { $inc: { wins: 1 } }).catch(err => console.log(err));
        }
    }

    if (currentPlayer.id.startsWith('bot_')) {
      const timer = setTimeout(() => playBotMove(roomId), 2000);
      botTimers.set(roomId, timer);
    } else {
      startTurnTimer(roomId);
    }
  }

  function playBotMove(roomId: string) {
    const room = rooms.get(roomId);
    if (!room?.game || room.game.winnerId) return;
    const bot = room.game.players[room.game.currentTurnIndex];
    if (!bot.id.startsWith('bot_')) return;

    const playableCard = bot.hand.find(c => canPlayCard(room.game!, c));

    try {
      if (playableCard) {
        let suit: Suit | undefined = undefined;
        let rank: Rank | undefined = undefined;
        if (playableCard.rank === 'A') { const suits: Suit[] = ['H', 'D', 'C', 'S']; suit = suits[Math.floor(Math.random() * suits.length)]; }
        else if (playableCard.rank === 'J') { const ranks: Rank[] = ['2','3','4','5','6','7','8','9','10','Q','K','A']; rank = ranks[Math.floor(Math.random() * ranks.length)]; }

        room.game = playCard(room.game, bot.id, playableCard, suit, rank);
        if (bot.hand.length === 1) room.game = callMakao(room.game, bot.id);
      } else {
        room.game = drawCard(room.game, bot.id);
        const drawnCard = bot.hand[bot.hand.length - 1];
        if (room.game.hasDrawnInTurn && canPlayCard(room.game, drawnCard)) {
           let suit: Suit | undefined = undefined;
           let rank: Rank | undefined = undefined;
           if (drawnCard.rank === 'A') { const suits: Suit[] = ['H', 'D', 'C', 'S']; suit = suits[Math.floor(Math.random() * suits.length)]; }
           else if (drawnCard.rank === 'J') { const ranks: Rank[] = ['2','3','4','5','6','7','8','9','10','Q','K','A']; rank = ranks[Math.floor(Math.random() * ranks.length)]; }
           room.game = playCard(room.game, bot.id, drawnCard, suit, rank);
           if (bot.hand.length === 1) room.game = callMakao(room.game, bot.id);
        } else if (room.game.hasDrawnInTurn) {
           room.game = passTurn(room.game, bot.id);
        }
      }
      broadcastState(roomId, room.game);
      handleNextTurn(roomId);
    } catch (e) { console.error('Błąd bota:', e); }
  }

  function startTurnTimer(roomId: string) {
    if (roomTimers.has(roomId)) clearTimeout(roomTimers.get(roomId));
    const timer = setTimeout(() => {
      const room = rooms.get(roomId);
      if (room?.game && !room.game.winnerId) {
        const currentPlayer = room.game.players[room.game.currentTurnIndex];
        try {
          if (room.game.hasDrawnInTurn && room.game.pendingDraw === 0) room.game = passTurn(room.game, currentPlayer.id);
          else room.game = drawCard(room.game, currentPlayer.id);
          broadcastState(roomId, room.game);
          handleNextTurn(roomId);
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
        requestedRank: state.requestedRank,
      };
      const room = rooms.get(roomId);
      const playerSocket = room?.players.find(pl => pl.id === p.id)?.socketId;
      if (playerSocket) io.to(playerSocket).emit('game:state', { ...publicState, myHand: p.hand });
    });
  }
});

const PORT = 3000;
server.listen(PORT, () => console.log(`🚀 Serwer działa na http://localhost:${PORT}`));