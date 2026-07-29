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

// --- 1. MongoDB Atlas 数据库模型 ---
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/landlord_db";
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ [MongoDB Atlas] 连接成功！'))
  .catch(err => console.error('❌ [MongoDB Atlas] 连接失败:', err));

const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  coins: { type: Number, default: 1000 },
  avatar: { type: String, default: '🤖' },
  equippedCardSkin: { type: String, default: 'skin_cyber' },
  inventory: { type: [String], default: ['skin_cyber'] },
  // 2FA 字段
  is2FAEnabled: { type: Boolean, default: false },
  twoFASecret: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

const ItemSchema = new mongoose.Schema({
  itemId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  type: { type: String, enum: ['SKIN', 'AVATAR'], required: true },
  price: { type: Number, required: true },
  description: { type: String, default: '' },
  icon: { type: String, default: '🎁' }
});
const Item = mongoose.model('Item', ItemSchema);

async function initShopItems() {
  const count = await Item.countDocuments();
  if (count === 0) {
    await Item.insertMany([
      { itemId: 'skin_cyber', name: '赛博霓虹牌背', type: 'SKIN', price: 500, description: '高质感赛博朋克发光牌背', icon: '🌌' },
      { itemId: 'skin_gold', name: '黑金暗纹牌背', type: 'SKIN', price: 800, description: '黑金奢华刺绣与亮金边框', icon: '🃏' },
      { itemId: 'avatar_dragon', name: '神龙专属头像', type: 'AVATAR', price: 600, description: '尊贵限定神龙框', icon: '🐉' },
      { itemId: 'avatar_robot', name: 'JR AI 极客头像', type: 'AVATAR', price: 300, description: 'JR AI 专属高阶人工智能头像', icon: '🤖' }
    ]);
  }
}
initShopItems();

// --- 2. 账号认证与 2FA API ---

// 注册
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '账号和密码不能为空' });

  try {
    const existing = await User.findOne({ username });
    if (existing) return res.status(400).json({ error: '用户名已存在' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ username, password: hashedPassword });
    await user.save();

    res.json({ success: true, message: '注册成功，请直接登录！' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 登录 (支持 2FA 强校验)
app.post('/api/auth/login', async (req, res) => {
  const { username, password, twoFAToken } = req.body;
  try {
    const user = await User.findOne({ username });
    if (!user) return res.status(400).json({ error: '账号不存在' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: '密码错误' });

    // 2FA 校验逻辑
    if (user.is2FAEnabled) {
      if (!twoFAToken) {
        return res.json({ success: false, require2FA: true, message: '请输入 2FA 验证码' });
      }
      const isValid = authenticator.check(twoFAToken, user.twoFASecret);
      if (!isValid) {
        return res.status(400).json({ error: '2FA 验证码错误或已过期！' });
      }
    }

    const { password: _, twoFASecret: __, ...userInfo } = user.toObject();
    res.json({ success: true, user: userInfo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2FA 生成二维码请求
app.post('/api/user/generate-2fa', async (req, res) => {
  const { username } = req.body;
  try {
    const secret = authenticator.generateSecret();
    const otpauth = authenticator.keyuri(username, 'JR_Cyber_Landlord', secret);
    const qrCodeUrl = await QRCode.toDataURL(otpauth);

    await User.findOneAndUpdate({ username }, { twoFASecret: secret });
    res.json({ success: true, secret, qrCodeUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2FA 确认开启绑定
app.post('/api/user/verify-2fa', async (req, res) => {
  const { username, token } = req.body;
  try {
    const user = await User.findOne({ username });
    const isValid = authenticator.check(token, user.twoFASecret);

    if (isValid) {
      user.is2FAEnabled = true;
      await user.save();
      const { password: _, twoFASecret: __, ...userInfo } = user.toObject();
      res.json({ success: true, user: userInfo, message: '2FA 双因素安全验证绑定成功！' });
    } else {
      res.status(400).json({ error: '验证码错误，请重新输入 Authenticator 上的 6 位数字' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 商城与管理 API
app.get('/api/shop/items', async (req, res) => {
  const items = await Item.find();
  res.json({ success: true, items });
});

app.post('/api/shop/buy', async (req, res) => {
  const { username, itemId } = req.body;
  const user = await User.findOne({ username });
  const item = await Item.findOne({ itemId });

  if (!user || !item) return res.status(400).json({ error: '道具或用户不存在' });
  if (user.coins < item.price) return res.status(400).json({ error: '余额不足' });

  user.coins -= item.price;
  user.inventory.push(itemId);
  if (item.type === 'SKIN') user.equippedCardSkin = itemId;
  if (item.type === 'AVATAR') user.avatar = item.icon;

  await user.save();
  const { password: _, twoFASecret: __, ...userInfo } = user.toObject();
  res.json({ success: true, user: userInfo, message: `购买并装备【${item.name}】成功！` });
});

app.get('/api/admin/users', async (req, res) => {
  const users = await User.find({}, '-password -twoFASecret');
  res.json({ success: true, users });
});

app.post('/api/admin/update-coins', async (req, res) => {
  const { username, amount } = req.body;
  const user = await User.findOneAndUpdate({ username }, { $inc: { coins: amount } }, { new: true });
  res.json({ success: true, user });
});

// --- 3. Socket.IO 房间系统 ---
const rooms = {};

io.on('connection', (socket) => {
  socket.on('create_room', async ({ roomId, username }) => {
    if (rooms[roomId]) return socket.emit('error_message', '房间号已存在！');
    const user = await User.findOne({ username });

    rooms[roomId] = {
      id: roomId,
      players: [{ id: socket.id, username, coins: user ? user.coins : 0, avatar: user ? user.avatar : '🤖' }],
      status: 'waiting', turnIndex: 0, lastPlayedHand: null, passCount: 0
    };
    socket.join(roomId);
    socket.emit('room_created', { roomId, room: rooms[roomId] });
  });

  socket.on('join_room', async ({ roomId, username }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('error_message', '房间不存在！');
    if (room.players.length >= 2) return socket.emit('error_message', '房间已满！');

    const user = await User.findOne({ username });
    room.players.push({ id: socket.id, username, coins: user ? user.coins : 0, avatar: user ? user.avatar : '🤖' });
    socket.join(roomId);

    io.to(roomId).emit('room_updated', room);

    if (room.players.length === 2) {
      room.status = 'playing';
      room.turnIndex = Math.floor(Math.random() * 2);
      const firstPlayer = room.players[room.turnIndex];

      io.to(roomId).emit('game_start', {
        message: `对局开启！由【${firstPlayer.username}】先手出牌！`,
        room, currentTurnSocketId: firstPlayer.id
      });
    }
  });

  socket.on('play_cards', ({ roomId, handInfo }) => {
    const room = rooms[roomId];
    if (!room) return;
    const currentTurnPlayer = room.players[room.turnIndex];
    if (currentTurnPlayer.id !== socket.id) return socket.emit('error_message', '非你的出牌回合！');

    room.lastPlayedHand = {
      playerId: socket.id, username: currentTurnPlayer.username,
      type: handInfo.type, value: handInfo.value, length: handInfo.length, cardsText: handInfo.cardsText
    };
    room.passCount = 0;

    io.to(roomId).emit('cards_played', room.lastPlayedHand);
    room.turnIndex = (room.turnIndex + 1) % 2;
    const nextPlayer = room.players[room.turnIndex];

    io.to(roomId).emit('turn_changed', { currentTurnSocketId: nextPlayer.id, username: nextPlayer.username, lastPlayedHand: room.lastPlayedHand });
  });

  socket.on('pass_turn', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    const currentTurnPlayer = room.players[room.turnIndex];
    if (currentTurnPlayer.id !== socket.id) return;

    room.passCount++;
    if (room.passCount >= 1) room.lastPlayedHand = null;

    io.to(roomId).emit('cards_played', { playerId: socket.id, username: currentTurnPlayer.username, cardsText: '不出 / 要不起' });
    room.turnIndex = (room.turnIndex + 1) % 2;
    const nextPlayer = room.players[room.turnIndex];

    io.to(roomId).emit('turn_changed', { currentTurnSocketId: nextPlayer.id, username: nextPlayer.username, lastPlayedHand: room.lastPlayedHand });
  });

  socket.on('game_over', async ({ roomId, winnerUsername }) => {
    const room = rooms[roomId];
    if (!room) return;
    const updatedUser = await User.findOneAndUpdate({ username: winnerUsername }, { $inc: { coins: 300 } }, { new: true });
    io.to(roomId).emit('game_result', { winner: winnerUsername, reward: 300, message: `🏆 恭喜玩家 【${winnerUsername}】 获得胜利！获得 300 金币！` });
    delete rooms[roomId];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 服务运行于端口: ${PORT}`));
