const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 内存数据库兜底 (防 MongoDB 连接超时卡死)
const memoryUsers = {};
const memoryItems = [
  { itemId: 'skin_cyber', name: '赛博霓虹牌背', type: 'SKIN', price: 500, description: '高质感赛博朋克发光牌背', icon: '🌌' },
  { itemId: 'skin_gold', name: '黑金暗纹牌背', type: 'SKIN', price: 800, description: '黑金奢华刺绣与亮金边框', icon: '🃏' },
  { itemId: 'avatar_dragon', name: '神龙专属头像', type: 'AVATAR', price: 600, description: '尊贵限定神龙框', icon: '🐉' },
  { itemId: 'avatar_robot', name: 'JR AI 极客头像', type: 'AVATAR', price: 300, description: 'JR AI 专属高阶人工智能头像', icon: '🤖' }
];

let isMongoConnected = false;
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/landlord_db";

mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 2000 })
  .then(() => { isMongoConnected = true; console.log('✅ [MongoDB Atlas] 连接成功！'); })
  .catch(() => { console.log('⚠️ 自动切换至内存高速数据库模式，保证畅快登录！'); });

const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  coins: { type: Number, default: 1000 },
  avatar: { type: String, default: '🤖' },
  equippedCardSkin: { type: String, default: 'skin_cyber' },
  inventory: { type: [String], default: ['skin_cyber'] },
  is2FAEnabled: { type: Boolean, default: false },
  twoFASecret: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

// 注册 API
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '账号和密码不能为空' });
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    if (isMongoConnected) {
      const existing = await User.findOne({ username });
      if (existing) return res.status(400).json({ error: '用户名已存在' });
      const user = new User({ username, password: hashedPassword });
      await user.save();
    } else {
      if (memoryUsers[username]) return res.status(400).json({ error: '用户名已存在' });
      memoryUsers[username] = {
        username, password: hashedPassword, coins: 1000, avatar: '🤖',
        equippedCardSkin: 'skin_cyber', inventory: ['skin_cyber'], is2FAEnabled: false, twoFASecret: ''
      };
    }
    res.json({ success: true, message: '注册成功，请直接登录！' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 登录 API
app.post('/api/auth/login', async (req, res) => {
  const { username, password, twoFAToken } = req.body;
  try {
    let user = isMongoConnected ? await User.findOne({ username }) : memoryUsers[username];
    if (!user) return res.status(400).json({ error: '账号不存在，请先注册！' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: '密码错误！' });

    if (user.is2FAEnabled) {
      if (!twoFAToken) return res.json({ success: false, require2FA: true, message: '请输入 2FA 动态验证码' });
      if (!authenticator.check(twoFAToken, user.twoFASecret)) return res.status(400).json({ error: '2FA 验证码错误！' });
    }

    res.json({
      success: true,
      user: { username: user.username, coins: user.coins, avatar: user.avatar, equippedCardSkin: user.equippedCardSkin, inventory: user.inventory, is2FAEnabled: user.is2FAEnabled }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/user/generate-2fa', async (req, res) => {
  const { username } = req.body;
  try {
    const secret = authenticator.generateSecret();
    const otpauth = authenticator.keyuri(username, 'JR_Cyber_Landlord', secret);
    const qrCodeUrl = await QRCode.toDataURL(otpauth);
    if (isMongoConnected) await User.findOneAndUpdate({ username }, { twoFASecret: secret });
    else if (memoryUsers[username]) memoryUsers[username].twoFASecret = secret;
    res.json({ success: true, secret, qrCodeUrl });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/user/verify-2fa', async (req, res) => {
  const { username, token } = req.body;
  try {
    let user = isMongoConnected ? await User.findOne({ username }) : memoryUsers[username];
    if (user && authenticator.check(token, user.twoFASecret)) {
      user.is2FAEnabled = true;
      if (isMongoConnected) await user.save();
      res.json({ success: true, user: { username: user.username, coins: user.coins, avatar: user.avatar, inventory: user.inventory, is2FAEnabled: true }, message: '2FA 绑定成功！' });
    } else {
      res.status(400).json({ error: '2FA 验证码错误！' });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/shop/items', (req, res) => res.json({ success: true, items: memoryItems }));

// Socket.IO 核心逻辑重构
const rooms = {};

io.on('connection', (socket) => {
  socket.on('create_room', ({ roomId, username, mode = 2 }) => {
    if (rooms[roomId]) return socket.emit('error_message', '房间号已使用，请更换！');
    const maxPlayers = parseInt(mode, 10);
    rooms[roomId] = {
      id: roomId, maxPlayers, players: [{ id: socket.id, username, coins: 1000, avatar: '🤖' }],
      status: 'waiting', turnIndex: 0, lastPlayedHand: null, passCount: 0
    };
    socket.join(roomId);
    socket.emit('room_created', { roomId, room: rooms[roomId] });
  });

  socket.on('join_room', ({ roomId, username }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('error_message', '房间不存在！');
    if (room.players.length >= room.maxPlayers) return socket.emit('error_message', '房间已满！');

    room.players.push({ id: socket.id, username, coins: 1000, avatar: '🤖' });
    socket.join(roomId);

    io.to(roomId).emit('room_updated', room);

    if (room.players.length === room.maxPlayers) {
      room.status = 'playing';
      room.turnIndex = Math.floor(Math.random() * room.maxPlayers);
      const firstPlayer = room.players[room.turnIndex];

      io.to(roomId).emit('game_start', {
        message: `🎉 人数已齐！【${room.maxPlayers}人局】由【${firstPlayer.username}】先手出牌！`,
        room, currentTurnSocketId: firstPlayer.id
      });
    }
  });

  // 严格安全的数据序列化清洗传输
  socket.on('play_cards', ({ roomId, handInfo }) => {
    const room = rooms[roomId];
    if (!room) return;

    const currentTurnPlayer = room.players[room.turnIndex];
    if (currentTurnPlayer.id !== socket.id) return socket.emit('error_message', '还没轮到你出牌！');

    // 精确清洗卡牌数据，防丢属性
    const cleanRawCards = Array.isArray(handInfo.rawCards) 
      ? handInfo.rawCards.map(c => ({ rank: c.rank, suit: c.suit || '', value: Number(c.value) }))
      : [];

    room.passCount = 0;
    room.lastPlayedHand = {
      playerId: socket.id,
      username: currentTurnPlayer.username,
      type: handInfo.type,
      value: Number(handInfo.value),
      length: Number(handInfo.length),
      rawCards: cleanRawCards
    };

    // 全局广播打牌数据
    io.to(roomId).emit('cards_played', room.lastPlayedHand);

    room.turnIndex = (room.turnIndex + 1) % room.maxPlayers;
    const nextPlayer = room.players[room.turnIndex];

    io.to(roomId).emit('turn_changed', {
      currentTurnSocketId: nextPlayer.id,
      username: nextPlayer.username,
      lastPlayedHand: room.lastPlayedHand
    });
  });

  socket.on('pass_turn', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    const currentTurnPlayer = room.players[room.turnIndex];
    if (currentTurnPlayer.id !== socket.id) return;

    room.passCount++;
    let isTableCleared = false;
    
    // 全员 Pass 清空桌面
    if (room.passCount >= room.maxPlayers - 1) {
      room.lastPlayedHand = null;
      room.passCount = 0;
      isTableCleared = true;
    }

    io.to(roomId).emit('cards_played', {
      playerId: socket.id,
      username: currentTurnPlayer.username,
      cardsText: 'PASS',
      isClear: isTableCleared
    });

    room.turnIndex = (room.turnIndex + 1) % room.maxPlayers;
    const nextPlayer = room.players[room.turnIndex];

    io.to(roomId).emit('turn_changed', {
      currentTurnSocketId: nextPlayer.id,
      username: nextPlayer.username,
      lastPlayedHand: room.lastPlayedHand
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 后端服务运行于端口: ${PORT}`));
