const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// MongoDB Atlas
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/landlord_db";
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB Atlas 连接成功！'))
  .catch(err => console.error('❌ MongoDB Atlas 连接失败:', err));

const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  coins: { type: Number, default: 1000 }
});
const User = mongoose.model('User', UserSchema);

app.post('/api/user/login', async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: '请输入用户名' });
  try {
    let user = await User.findOne({ username });
    if (!user) {
      user = new User({ username, coins: 1000 });
      await user.save();
    }
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const rooms = {};

io.on('connection', (socket) => {
  socket.on('create_room', async ({ roomId, username }) => {
    if (rooms[roomId]) return socket.emit('error_message', '房间号已存在！');
    const user = await User.findOne({ username });

    rooms[roomId] = {
      id: roomId,
      players: [{ id: socket.id, username, coins: user ? user.coins : 0, position: 0 }],
      status: 'waiting',
      turnIndex: 0,
      lastPlayedHand: null, // 保存桌面上待压过的牌 { playerId, username, type, value, length, cardsText }
      passCount: 0          // 记录连续 Pass 的次数
    };

    socket.join(roomId);
    socket.emit('room_created', { roomId, room: rooms[roomId] });
  });

  socket.on('join_room', async ({ roomId, username }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('error_message', '房间不存在！');
    if (room.players.length >= 2) return socket.emit('error_message', '房间已满！');

    const user = await User.findOne({ username });
    const position = room.players.length;
    room.players.push({ id: socket.id, username, coins: user ? user.coins : 0, position });
    socket.join(roomId);

    io.to(roomId).emit('room_updated', room);

    if (room.players.length === 2) {
      room.status = 'playing';
      room.turnIndex = Math.floor(Math.random() * 2);
      const firstPlayer = room.players[room.turnIndex];

      io.to(roomId).emit('game_start', {
        message: `对局开始！【${firstPlayer.username}】先出牌！`,
        room,
        currentTurnSocketId: firstPlayer.id
      });
    }
  });

  // 出牌事件 (带比牌逻辑)
  socket.on('play_cards', ({ roomId, handInfo }) => {
    const room = rooms[roomId];
    if (!room) return;

    const currentTurnPlayer = room.players[room.turnIndex];
    if (currentTurnPlayer.id !== socket.id) {
      return socket.emit('error_message', '还没轮到你出牌！');
    }

    // 更新房间桌面上最大的牌
    room.lastPlayedHand = {
      playerId: socket.id,
      username: currentTurnPlayer.username,
      type: handInfo.type,
      value: handInfo.value,
      length: handInfo.length,
      cardsText: handInfo.cardsText
    };
    room.passCount = 0; // 重置 pass 次数

    io.to(roomId).emit('cards_played', room.lastPlayedHand);

    // 切换回合
    room.turnIndex = (room.turnIndex + 1) % 2;
    const nextPlayer = room.players[room.turnIndex];

    io.to(roomId).emit('turn_changed', {
      currentTurnSocketId: nextPlayer.id,
      username: nextPlayer.username,
      lastPlayedHand: room.lastPlayedHand
    });
  });

  // 不出 Pass 事件
  socket.on('pass_turn', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    const currentTurnPlayer = room.players[room.turnIndex];
    if (currentTurnPlayer.id !== socket.id) return socket.emit('error_message', '还没轮到你操作！');

    room.passCount++;
    // 如果对方不出，清空桌面压牌，获得自由出牌权
    if (room.passCount >= 1) {
      room.lastPlayedHand = null;
    }

    io.to(roomId).emit('cards_played', {
      playerId: socket.id,
      username: currentTurnPlayer.username,
      cardsText: '要不起 / 不出'
    });

    room.turnIndex = (room.turnIndex + 1) % 2;
    const nextPlayer = room.players[room.turnIndex];

    io.to(roomId).emit('turn_changed', {
      currentTurnSocketId: nextPlayer.id,
      username: nextPlayer.username,
      lastPlayedHand: room.lastPlayedHand
    });
  });

  socket.on('game_over', async ({ roomId, winnerUsername }) => {
    const room = rooms[roomId];
    if (!room) return;

    try {
      const updatedUser = await User.findOneAndUpdate(
        { username: winnerUsername },
        { $inc: { coins: 300 } },
        { new: true }
      );

      io.to(roomId).emit('game_result', {
        winner: winnerUsername,
        reward: 300,
        message: `🏆 恭喜玩家 【${winnerUsername}】 获得胜利！加成 300 金币！`
      });
      delete rooms[roomId];
    } catch (err) {
      console.error(err);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 服务运行于端口: ${PORT}`));
