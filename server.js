const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- MongoDB Atlas Connection ---
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/landlord_db";

mongoose.connect(MONGO_URI)
  .then(() => console.log('Connected to MongoDB Atlas'))
  .catch(err => console.error('MongoDB Atlas Connection Error:', err));

// Database Schema for Game History
const GameLogSchema = new mongoose.Schema({
  roomId: String,
  players: [String],
  playedCardLogs: Array,
  createdAt: { type: Date, default: Date.now }
});

const GameLog = mongoose.model('GameLog', GameLogSchema);

// --- In-Memory Room Management ---
const rooms = {};

io.on('connection', (socket) => {
  console.log(`[Connected] Socket ID: ${socket.id}`);

  // Create Room
  socket.on('create_room', ({ roomId, username }) => {
    if (rooms[roomId]) {
      return socket.emit('error_message', 'Room ID already exists!');
    }

    rooms[roomId] = {
      id: roomId,
      players: [{ id: socket.id, username, position: 0 }],
      status: 'waiting',
      logs: []
    };

    socket.join(roomId);
    socket.emit('room_created', { roomId, room: rooms[roomId] });
  });

  // Join Room
  socket.on('join_room', ({ roomId, username }) => {
    const room = rooms[roomId];

    if (!room) {
      return socket.emit('error_message', 'Room does not exist!');
    }
    if (room.players.length >= 3) {
      return socket.emit('error_message', 'Room is full (max 3 players)!');
    }

    const position = room.players.length;
    room.players.push({ id: socket.id, username, position });
    socket.join(roomId);

    // Notify all clients in the room
    io.to(roomId).emit('room_updated', room);

    // Auto-start when 3 players have joined
    if (room.players.length === 3) {
      room.status = 'playing';
      io.to(roomId).emit('game_start', {
        message: 'All players joined! The game has started.',
        room
      });
    }
  });

  // Play Cards Sync
  socket.on('play_cards', ({ roomId, cards }) => {
    const room = rooms[roomId];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    const actionLog = {
      playerId: socket.id,
      username: player ? player.username : 'Unknown',
      cards,
      timestamp: new Date().toLocaleTimeString()
    };

    room.logs.push(actionLog);

    // Broadcast played cards to everyone in the room
    io.to(roomId).emit('cards_played', actionLog);
  });

  // End Game and Save to MongoDB Atlas
  socket.on('finish_game', async ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    try {
      const record = new GameLog({
        roomId: room.id,
        players: room.players.map(p => p.username),
        playedCardLogs: room.logs
      });
      await record.save();

      io.to(roomId).emit('game_ended', { message: 'Game saved to MongoDB Atlas!' });
      delete rooms[roomId]; // Clear memory room
    } catch (err) {
      console.error('Failed to log game to DB:', err);
    }
  });

  // Disconnect Handling
  socket.on('disconnect', () => {
    console.log(`[Disconnected] Socket ID: ${socket.id}`);

    for (const roomId in rooms) {
      const room = rooms[roomId];
      const index = room.players.findIndex(p => p.id === socket.id);

      if (index !== -1) {
        room.players.splice(index, 1);

        if (room.players.length === 0) {
          delete rooms[roomId];
        } else {
          io.to(roomId).emit('room_updated', room);
        }
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
