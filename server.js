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

// MongoDB Atlas
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

// 用户认证 & 2FA 接口
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '账号和密码不能为空' });
  try {
    const existing = await User.findOne({ username });
    if (existing) return res.status(400).json({ error: '用户名已存在' });
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ username, password: hashedPassword });
    await user.save();
    res.json({ success: true, message: '注册成功，请登录！' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password, twoFAToken } = req.body;
  try {
    const user = await User.findOne({ username });
    if (!user) return res.status(400).json({ error: '账号不存在' });
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: '密码错误' });

    if (user.is2FAEnabled) {
      if (!twoFAToken) return res.json({ success: false, require2FA: true, message: '请输入 2FA 验证码' });
      const isValid = authenticator.check(twoFAToken, user.twoFASecret);
      if (!isValid) return res.status(400).json({ error: '2FA 验证码错误或已过期！' });
    }

    const { password: _, twoFASecret: __, ...userInfo } = user.toObject();
    res.json({ success: true, user: userInfo });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/user/generate-2fa', async (req, res) => {
  const { username } = req.body;
  try {
    const secret = authenticator.generateSecret();
    const otpauth = authenticator.keyuri(username, 'JR_Cyber_Landlord', secret);
    const qrCodeUrl = await QRCode.toDataURL(otpauth);
    await User.findOneAndUpdate({ username }, { twoFASecret: secret });
    res.json({ success: true, secret, qrCodeUrl });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/user/verify-2fa', async (req, res) => {
  const { username, token } = req.body;
  try {
    const user = await User.findOne({ username });
    if (authenticator.check(token, user.twoFASecret)) {
      user.is2FAEnabled = true;
      await user.save();
      const { password: _, twoFASecret: __, ...userInfo } = user.toObject();
      res.json({ success: true, user: userInfo, message: '2FA 双因素认证激活成功！' });
    } else {
      res.status(400).json({ error: '2FA 验证码错误！' });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/shop/items', async (req, res) => {
  res.json({ success: true, items: await Item.find() });
});

app.post('/api/shop/buy', async (req, res) => {
  const { username, itemId } = req.body;
  const user = await User.findOne({ username });
  const item = await Item.findOne({ itemId });
  if (!user || !item) return res.status(400).json({ error: '数据不存在' });
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
  res.json({ success: true, users: await User.find({}, '-password -twoFASecret') });
});

app.post('/api/admin/update-coins', async (req, res) => {
  const { username, amount } = req.body;
  const user = await User.findOneAndUpdate({ username }, { $inc: { coins: amount } }, { new: true });
  res.json({ success: true, user });
});

// --- Socket.IO 房间系统（修复人数检测与多模式）---
const rooms = {};

io.on('connection', (socket) => {
  // 创建房间
  socket.on('create_room', async ({ roomId, username, mode = 2, subMode = 'LANDLORD' }) => {
    if (rooms[roomId]) return socket.emit('error_message', '房间号已使用，请更换！');
    const user = await User.findOne({ username });

    const maxPlayers = parseInt(mode, 10);
    rooms[roomId] = {
      id: roomId,
      maxPlayers: maxPlayers, // 关键：精准记录该房间的人数上限（2，3 或 5）
      subMode: subMode,
      players: [{ id: socket.id, username, coins: user ? user.coins : 0, avatar: user ? user.avatar : '🤖' }],
      status: 'waiting',
      turnIndex: 0,
      lastPlayedHand: null,
      passCount: 0
    };

    socket.join(roomId);
    socket.emit('room_created', { roomId, room: rooms[roomId] });
  });

  // 加入房间（严格检测人数）
  socket.on('join_room', async ({ roomId, username }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('error_message', '房间不存在！');
    
    // 【人数逻辑修复点 1】：加入前判断人数是否已满
    if (room.players.length >= room.maxPlayers) {
      return socket.emit('error_message', `该房间已被占满（当前设定为 ${room.maxPlayers} 人局）！`);
    }

    const user = await User.findOne({ username });
    room.players.push({ id: socket.id, username, coins: user ? user.coins : 0, avatar: user ? user.avatar : '🤖' });
    socket.join(roomId);

    io.to(roomId).emit('room_updated', room);

    // 【人数逻辑修复点 2】：仅在房间人数严格等于 maxPlayers 时才触发游戏开始！
    if (room.players.length === room.maxPlayers) {
      room.status = 'playing';
      room.turnIndex = Math.floor(Math.random() * room.maxPlayers);
      const firstPlayer = room.players[room.turnIndex];

      io.to(roomId).emit('game_start', {
        message: `🎉 所有人到齐！【${room.maxPlayers}人模式】由【${firstPlayer.username}】先手出牌！`,
        room,
        currentTurnSocketId: firstPlayer.id
      });
    }
  });

  socket.on('play_cards', ({ roomId, handInfo }) => {
    const room = rooms[roomId];
    if (!room) return;

    const currentTurnPlayer = room.players[room.turnIndex];
    if (currentTurnPlayer.id !== socket.id) return socket.emit('error_message', '还没轮到你出牌！');

    room.lastPlayedHand = {
      playerId: socket.id,
      username: currentTurnPlayer.username,
      type: handInfo.type,
      value: handInfo.value,
      length: handInfo.length,
      cardsText: handInfo.cardsText
    };
    room.passCount = 0;

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
    if (room.passCount >= room.maxPlayers - 1) {
      room.lastPlayedHand = null; // 所有人 Pass，清空上家出牌
    }

    io.to(roomId).emit('cards_played', {
      playerId: socket.id,
      username: currentTurnPlayer.username,
      cardsText: '不出 / 要不起'
    });

    room.turnIndex = (room.turnIndex + 1) % room.maxPlayers;
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
        message: `🏆 恭喜玩家 【${winnerUsername}】 获得胜利！结算加成 +300 金币！`
      });
      delete rooms[roomId];
    } catch (err) {
      console.error(err);
    }
  });

  socket.on('disconnect', () => {
    for (const roomId in rooms) {
      const room = rooms[roomId];
      const index = room.players.findIndex(p => p.id === socket.id);
      if (index !== -1) {
        room.players.splice(index, 1);
        if (room.players.length === 0) delete rooms[roomId];
        else io.to(roomId).emit('room_updated', room);
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 服务运行于端口: ${PORT}`));
