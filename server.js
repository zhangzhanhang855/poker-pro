const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- 1. MongoDB Atlas 数据库模型定义 ---
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/landlord_db";
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB Atlas 连接成功！'))
  .catch(err => console.error('❌ MongoDB Atlas 连接失败:', err));

// 用户模型
const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  coins: { type: Number, default: 1000 },
  avatar: { type: String, default: '👑' },
  equippedCardSkin: { type: String, default: 'default' },
  inventory: { type: [String], default: ['default'] }, // 拥有的商品 ID 列表
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

// 商城物品模型
const ItemSchema = new mongoose.Schema({
  itemId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  type: { type: String, enum: ['SKIN', 'AVATAR'], required: true },
  price: { type: Number, required: true },
  description: { type: String, default: '' },
  icon: { type: String, default: '🎁' }
});
const Item = mongoose.model('Item', ItemSchema);

// 初始化默认商城商品
async function initShopItems() {
  const count = await Item.countDocuments();
  if (count === 0) {
    await Item.insertMany([
      { itemId: 'skin_gold', name: '暗黑金纹牌背', type: 'SKIN', price: 500, description: '彰显尊贵身份的黑金刺绣质感', icon: '🃏' },
      { itemId: 'skin_cyber', name: '赛博霓虹牌背', type: 'SKIN', price: 800, description: '发光赛博朋克风格特制牌背', icon: '🌌' },
      { itemId: 'avatar_dragon', name: '神龙专属头像', type: 'AVATAR', price: 600, description: '拉风的龙年限量版专属头像框', icon: '🐉' },
      { itemId: 'avatar_robot', name: '高阶 AI 头像', type: 'AVATAR', price: 300, description: 'JR AI 极客风专属头像', icon: '🤖' }
    ]);
    console.log('🛒 商城默认商品初始化完成！');
  }
}
initShopItems();

// --- 2. REST API 接口 ---

// 注册
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });

  try {
    const existing = await User.findOne({ username });
    if (existing) return res.status(400).json({ error: '用户名已存在' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ username, password: hashedPassword });
    await user.save();

    res.json({ success: true, message: '注册成功！' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 登录
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await User.findOne({ username });
    if (!user) return res.status(400).json({ error: '账号不存在' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: '密码错误' });

    const { password: _, ...userInfo } = user.toObject();
    res.json({ success: true, user: userInfo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 修改设置（头像/修改密码）
app.post('/api/user/update-settings', async (req, res) => {
  const { username, avatar, newPassword } = req.body;
  try {
    const updateData = {};
    if (avatar) updateData.avatar = avatar;
    if (newPassword) updateData.password = await bcrypt.hash(newPassword, 10);

    const user = await User.findOneAndUpdate({ username }, updateData, { new: true });
    const { password: _, ...userInfo } = user.toObject();
    res.json({ success: true, user: userInfo });
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

// 购买商城商品
app.post('/api/shop/buy', async (req, res) => {
  const { username, itemId } = req.body;
  try {
    const user = await User.findOne({ username });
    const item = await Item.findOne({ itemId });

    if (!user || !item) return res.status(400).json({ error: '用户或商品不存在' });
    if (user.inventory.includes(itemId)) return res.status(400).json({ error: '您已拥有该商品' });
    if (user.coins < item.price) return res.status(400).json({ error: '金币不足，请多赢几局后再来！' });

    user.coins -= item.price;
    user.inventory.push(itemId);
    if (item.type === 'SKIN') user.equippedCardSkin = itemId;
    if (item.type === 'AVATAR') user.avatar = item.icon;

    await user.save();
    const { password: _, ...userInfo } = user.toObject();
    res.json({ success: true, user: userInfo, message: `购买并自动装备【${item.name}】成功！` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- 后台管理接口 (ADMIN API) ---

// 获取后台统计信息与用户列表
app.get('/api/admin/users', async (req, res) => {
  try {
    const users = await User.find({}, '-password');
    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 管理员调整玩家金币
app.post('/api/admin/update-coins', async (req, res) => {
  const { username, amount } = req.body;
  try {
    const user = await User.findOneAndUpdate({ username }, { $inc: { coins: amount } }, { new: true });
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 后台上架新商品
app.post('/api/admin/add-item', async (req, res) => {
  const { itemId, name, type, price, description, icon } = req.body;
  try {
    const newItem = new Item({ itemId, name, type, price, description, icon });
    await newItem.save();
    res.json({ success: true, item: newItem });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 后台下架商品
app.delete('/api/admin/delete-item/:itemId', async (req, res) => {
  try {
    await Item.deleteOne({ itemId: req.params.itemId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- 3. Socket.IO 游戏房间通信逻辑 ---
const rooms = {};

io.on('connection', (socket) => {
  socket.on('create_room', async ({ roomId, username }) => {
    if (rooms[roomId]) return socket.emit('error_message', '房间号已存在！');
    const user = await User.findOne({ username });

    rooms[roomId] = {
      id: roomId,
      players: [{ id: socket.id, username, coins: user ? user.coins : 0, avatar: user ? user.avatar : '👑' }],
      status: 'waiting',
      turnIndex: 0,
      lastPlayedHand: null,
      passCount: 0
    };

    socket.join(roomId);
    socket.emit('room_created', { roomId, room: rooms[roomId] });
  });

  socket.on('join_room', async ({ roomId, username }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('error_message', '房间不存在！');
    if (room.players.length >= 2) return socket.emit('error_message', '房间已满！');

    const user = await User.findOne({ username });
    room.players.push({ id: socket.id, username, coins: user ? user.coins : 0, avatar: user ? user.avatar : '👑' });
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

    room.turnIndex = (room.turnIndex + 1) % 2;
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
    if (currentTurnPlayer.id !== socket.id) return socket.emit('error_message', '还没轮到你操作！');

    room.passCount++;
    if (room.passCount >= 1) room.lastPlayedHand = null;

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
        message: `🏆 恭喜玩家 【${winnerUsername}】 获得胜利！获得 300 金币！`
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
server.listen(PORT, () => console.log(`🚀 服务启动于端口: ${PORT}`));
