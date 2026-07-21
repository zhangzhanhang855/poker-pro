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
  .then(() => console.log('MongoDB Atlas 连接成功！'))
  .catch(err => console.error('MongoDB Atlas 连接失败:', err));

// 用户 Schema：存储用户名及金币数量
const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  coins: { type: Number, default: 1000 },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);

// REST API: 获取或创建用户（简单登录/注册逻辑）
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

// --- 2. 内存房间管理与 Socket.IO 广播 ---
const rooms = {};

io.on('connection', (socket) => {
  console.log(`[用户连接] Socket ID: ${socket.id}`);

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
    if (room.players.length >= 3) {
      return socket.emit('error_message', '房间已满（上限3人）！');
    }

    const user = await User.findOne({ username });
    const coins = user ? user.coins : 0;

    const position = room.players.length;
    room.players.push({ id: socket.id, username, coins, position });
    socket.join(roomId);

    io.to(roomId).emit('room_updated', room);

    // 满3人自动开局
    if (room.players.length === 3) {
      room.status = 'playing';
      io.to(roomId).emit('game_start', {
        message: '人员已到齐，游戏开始！',
        room
      });
    }
  });

  // 实时出牌广播 (Render 核心同步)
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

    // 向房间内所有客户端实时广播出牌信息
    io.to(roomId).emit('cards_played', playData);
  });

  // 游戏结算：胜者增加 300 金币并存入 MongoDB
  socket.on('game_over', async ({ roomId, winnerUsername }) => {
    const room = rooms[roomId];
    if (!room) return;

    try {
      // 在 MongoDB 中为胜者增加 300 金币
      const updatedUser = await User.findOneAndUpdate(
        { username: winnerUsername },
        { $inc: { coins: 300 } },
        { new: true }
      );

      // 广播结算信息给房间所有人
      io.to(roomId).emit('game_result', {
        winner: winnerUsername,
        reward: 300,
        newBalance: updatedUser ? updatedUser.coins : null,
        message: `恭喜 ${winnerUsername} 赢得了本局！获得 300 金币！`
      });

      delete rooms[roomId]; // 清理已完成的房间
    } catch (err) {
      console.error('更新金币失败:', err);
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
server.listen(PORT, () => console.log(`服务运行于端口: ${PORT}`));
