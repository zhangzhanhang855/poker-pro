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

// ==========================================
// 1. MongoDB Atlas 数据库模型定义与连接
// ==========================================
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/landlord_db";
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ [MongoDB Atlas] 数据库连接成功！'))
  .catch(err => console.error('❌ [MongoDB Atlas] 连接失败:', err));

// 用户 Schema
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

// 商城道具 Schema
const ItemSchema = new mongoose.Schema({
  itemId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  type: { type: String, enum: ['SKIN', 'AVATAR'], required: true },
  price: { type: Number, required: true },
  description: { type: String, default: '' },
  icon: { type: String, default: '🎁' }
});
const Item = mongoose.model('Item', ItemSchema);

// 初始化商城数据
async function initShopItems() {
  const count = await Item.countDocuments();
  if (count === 0) {
    await Item.insertMany([
      { itemId: 'skin_cyber', name: '赛博霓虹牌背', type: 'SKIN', price: 500, description: '高质感赛博朋克发光牌背', icon: '🌌' },
      { itemId: 'skin_gold', name: '黑金暗纹牌背', type: 'SKIN', price: 800, description: '黑金奢华刺绣与亮金边框', icon: '🃏' },
      { itemId: 'avatar_dragon', name: '神龙专属头像', type: 'AVATAR', price: 600, description: '尊贵限定神龙框', icon: '🐉' },
      { itemId: 'avatar_robot', name: 'JR AI 极客头像', type: 'AVATAR', price: 300, description: 'JR AI 专属高阶人工智能头像', icon: '🤖' }
    ]);
    console.log('🛒 [Shop] 商城默认初始化完成！');
  }
}
initShopItems();

// ==========================================
// 2. HTTP RESTful API (注册/登录/2FA/商城/后台)
// ==========================================

// 账号注册
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '账号和密码不能为空' });
  try {
    const existing = await User.findOne({ username });
    if (existing) return res.status(400).json({ error: '该用户名已被占用' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ username, password: hashedPassword });
    await user.save();
    res.json({ success: true, message: '注册成功，请直接登录！' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 账号登录 (包含 2FA 校验)
app.post('/api/auth/login', async (req, res) => {
  const { username, password, twoFAToken } = req.body;
  try {
    const user = await User.findOne({ username });
    if (!user) return res.status(400).json({ error: '账号不存在' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: '密码错误' });

    if (user.is2FAEnabled) {
      if (!twoFAToken) {
        return res.json({ success: false, require2FA: true, message: '请输入 2FA 动态验证码' });
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

// 生成 2FA 密钥与二维码
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

// 验证并绑定 2FA
app.post('/api/user/verify-2fa', async (req, res) => {
  const { username, token } = req.body;
  try {
    const user = await User.findOne({ username });
    if (authenticator.check(token, user.twoFASecret)) {
      user.is2FAEnabled = true;
      await user.save();
      const { password: _, twoFASecret: __, ...userInfo } = user.toObject();
      res.json({ success: true, user: userInfo, message: '2FA 双因素安全保护激活成功！' });
    } else {
      res.status(400).json({ error: '验证码错误，请检查验证器 App 中的 6 位数字！' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取商城列表
app.get('/api/shop/items', async (req, res) => {
  try {
    const items = await Item.find();
    res.json({ success: true, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 购买商城道具
app.post('/api/shop/buy', async (req, res) => {
  const { username, itemId } = req.body;
  try {
    const user = await User.findOne({ username });
    const item = await Item.findOne({ itemId });
    if (!user || !item) return res.status(400).json({ error: '数据不存在' });
    if (user.coins < item.price) return res.status(400).json({ error: '金币余额不足' });

    user.coins -= item.price;
    user.inventory.push(itemId);
    if (item.type === 'SKIN') user.equippedCardSkin = itemId;
    if (item.type === 'AVATAR') user.avatar = item.icon;
    await user.save();

    const { password: _, twoFASecret: __, ...userInfo } = user.toObject();
    res.json({ success: true, user: userInfo, message: `成功购买并装备了【${item.name}】！` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin 后台：获取所有玩家
app.get('/api/admin/users', async (req, res) => {
  try {
    const users = await User.find({}, '-password -twoFASecret');
    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin 后台：调整金币
app.post('/api/admin/update-coins', async (req, res) => {
  const { username, amount } = req.body;
  try {
    const user = await User.findOneAndUpdate({ username }, { $inc: { coins: amount } }, { new: true });
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 3. Socket.IO 多模式实时对局逻辑
// ==========================================
const rooms = {};

io.on('connection', (socket) => {
  // 创建房间（支持选择人数模式: 2人, 3人, 5人）
  socket.on('create_room', async ({ roomId, username, mode = 2, subMode = 'LANDLORD' }) => {
    if (rooms[roomId]) return socket.emit('error_message', '房间号已被占用，请尝试其他房间号！');
    const user = await User.findOne({ username });

    const maxPlayers = parseInt(mode, 10);
    rooms[roomId] = {
      id: roomId,
      maxPlayers: maxPlayers, // 精确保存设定人数
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

  // 加入房间
  socket.on('join_room', async ({ roomId, username }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('error_message', '房间不存在！');

    // 检测人数限制，杜绝未满员开局
    if (room.players.length >= room.maxPlayers) {
      return socket.emit('error_message', `房间已满（上限 ${room.maxPlayers} 人）！`);
    }

    const user = await User.findOne({ username });
    room.players.push({ id: socket.id, username, coins: user ? user.coins : 0, avatar: user ? user.avatar : '🤖' });
    socket.join(roomId);

    io.to(roomId).emit('room_updated', room);

    // 只有在人员严格满员（等于 maxPlayers）时才启动比赛
    if (room.players.length === room.maxPlayers) {
      room.status = 'playing';
      room.turnIndex = Math.floor(Math.random() * room.maxPlayers);
      const firstPlayer = room.players[room.turnIndex];

      io.to(roomId).emit('game_start', {
        message: `🎉 成员已集齐！【${room.maxPlayers}人模式】由【${firstPlayer.username}】先手出牌！`,
        room,
        currentTurnSocketId: firstPlayer.id
      });
    }
  });

  // 玩家出牌
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
      rawCards: handInfo.rawCards
    };
    room.passCount = 0; // 出牌后重置 Pass 计数器

    io.to(roomId).emit('cards_played', room.lastPlayedHand);

    // 回合推进给下一位玩家
    room.turnIndex = (room.turnIndex + 1) % room.maxPlayers;
    const nextPlayer = room.players[room.turnIndex];

    io.to(roomId).emit('turn_changed', {
      currentTurnSocketId: nextPlayer.id,
      username: nextPlayer.username,
      lastPlayedHand: room.lastPlayedHand
    });
  });

  // 玩家 Pass 不出
  socket.on('pass_turn', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    const currentTurnPlayer = room.players[room.turnIndex];
    if (currentTurnPlayer.id !== socket.id) return;

    room.passCount++;

    // 【核心关键修复】：如果其他所有人都 Pass，彻底清空桌面，赋予新回合首发自由出牌权
    if (room.passCount >= room.maxPlayers - 1) {
      room.lastPlayedHand = null;
      room.passCount = 0;
    }

    io.to(roomId).emit('cards_played', {
      playerId: socket.id,
      username: currentTurnPlayer.username,
      cardsText: '不出 / PASS',
      isClear: room.lastPlayedHand === null // 标志桌面是否已被清空
    });

    room.turnIndex = (room.turnIndex + 1) % room.maxPlayers;
    const nextPlayer = room.players[room.turnIndex];

    io.to(roomId).emit('turn_changed', {
      currentTurnSocketId: nextPlayer.id,
      username: nextPlayer.username,
      lastPlayedHand: room.lastPlayedHand // 若已清空则返回 null
    });
  });

  // 对局结束与金币结算
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
        message: `🏆 恭喜玩家 【${winnerUsername}】 获得本局胜利！金币 +300！`
      });
      delete rooms[roomId];
    } catch (err) {
      console.error(err);
    }
  });

  // 断线清理
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

// 启动端口服务
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 赛博斗地主后端服务运行于端口: ${PORT}`));
