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
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- 1. 连接 MongoDB Atlas ---
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/landlord_db";

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB Atlas 连接成功！'))
  .catch(err => console.error('❌ MongoDB Atlas 连接失败:', err));

const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  coins: { type: Number, default: 1000 },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);

// REST API: 账号登录/注册
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

// --- 2. 内存房间管理 (二人模式) ---
const rooms = {};

io.on('connection', (socket) => {
  console.log(`[Socket] 客户端连接: ${socket.id}`);

  // 创建房间
  socket.on('create_room', async ({ roomId, username }) => {
    if (rooms[roomId]) {
      return socket.emit('error_message', '房间号已存在！');
    }

    const user = await User.findOne({ username });
    const coins = user ? user.coins : 0;

    rooms[roomId] = {
      id: roomId,
      players: [{ id: socket.id, username, coins, position: 0 }],
      status: 'waiting'
    };

    socket.join(roomId);
    socket.emit('room_created', { roomId, room: rooms[roomId] });
  });

  // 加入房间
  socket.on('join_room', async ({ roomId, username }) => {
    const room = rooms[roomId];

    if (!room) {
      return socket.emit('error_message', '房间不存在！');
    }
    // 【修改点】上限改为 2 人
    if (room.players.length >= 2) {
      return socket.emit('error_message', '房间已满（上限2人）！');
    }

    const user = await User.findOne({ username });
    const coins = user ? user.coins : 0;

    const position = room.players.length;
    room.players.push({ id: socket.id, username, coins, position });
    socket.join(roomId);

    io.to(roomId).emit('room_updated', room);

    // 【修改点】满 2 人自动开始游戏
    if (room.players.length === 2) {
      room.status = 'playing';
      io.to(roomId).emit('game_start', {
        message: '两位玩家已就位，对局正式开始！',
        room
      });
    }
  });

  // 实时出牌广播
  socket.on('play_cards', ({ roomId, cards }) => {
    const room = rooms[roomId];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    const playData = {
      playerId: socket.id,
      username: player ? player.username : '未知玩家',
      cards,
      timestamp: new Date().toLocaleTimeString()
    };

    io.to(roomId).emit('cards_played', playData);
  });

  // 游戏结算
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
        newBalance: updatedUser ? updatedUser.coins : null,
        message: `🏆 恭喜玩家 【${winnerUsername}】 获得胜利！获得 300 金币！`
      });

      delete rooms[roomId];
    } catch (err) {
      console.error('更新资产失败:', err);
    }
  });

  // 断开连接处理
  socket.on('disconnect', () => {
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
server.listen(PORT, () => console.log(`🚀 服务运行于端口: ${PORT}`));
