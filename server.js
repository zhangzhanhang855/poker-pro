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

// --- 1. MongoDB Atlas 数据库连接 ---
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/landlord_db";
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ [MongoDB Atlas] 连线成功！'))
  .catch(err => console.error('❌ [MongoDB Atlas] 连线失败:', err));

// 用户 Schema
const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  coins: { type: Number, default: 1000 },
  avatar: { type: String, default: '👑' },
  equippedCardSkin: { type: String, default: 'default' },
  inventory: { type: [String], default: ['default'] },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

// 商城物品 Schema
const ItemSchema = new mongoose.Schema({
  itemId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  type: { type: String, enum: ['SKIN', 'AVATAR'], required: true },
  price: { type: Number, required: true },
  description: { type: String, default: '' },
  icon: { type: String, default: '🎁' }
});
const Item = mongoose.model('Item', ItemSchema);

// 初始化默认商品
async function initShopItems() {
  const count = await Item.countDocuments();
  if (count === 0) {
    await Item.insertMany([
      { itemId: 'skin_gold', name: '黑金暗纹牌背', type: 'SKIN', price: 500, description: '黑金奢华刺绣与亮金边框', icon: '🃏' },
      { itemId: 'skin_cyber', name: '赛博霓虹牌背', type: 'SKIN', price: 800, description: '高质感赛博朋克发光牌背', icon: '🌌' },
      { itemId: 'avatar_dragon', name: '神龙专属头像', type: 'AVATAR', price: 600, description: '拉风的尊贵限定神龙框', icon: '🐉' },
      { itemId: 'avatar_robot', name: 'JR AI 极客头像', type: 'AVATAR', price: 300, description: 'JR AI 专属高阶人工智能头像', icon: '🤖' }
    ]);
    console.log('🛒 [Shop] 默认顶级商品初始化完成！');
  }
}
initShopItems();

// --- 2. API 路由 ---
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '账号与密码不能为空' });

  try {
    const existing = await User.findOne({ username });
    if (existing) return res.status(400).json({ error: '该用户名已被占用' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ username, password: hashedPassword });
    await user.save();

    res.json({ success: true, message: '账号注册成功，请直接登录！' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await User.findOne({ username });
    if (!user) return res.status(400).json({ error: '账号不存在，请先注册' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: '密码不正确' });

    const { password: _, ...userInfo } = user.toObject();
    res.json({ success: true, user: userInfo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/user/update-settings', async (req, res) => {
  const { username, avatar, newPassword, equippedSkin } = req.body;
  try {
    const updateData = {};
    if (avatar) updateData.avatar = avatar;
    if (equippedSkin) updateData.equippedCardSkin = equippedSkin;
    if (newPassword) updateData.password = await bcrypt.hash(newPassword, 10);

    const user = await User.findOneAndUpdate({ username }, updateData, { new: true });
    const { password: _, ...userInfo } = user.toObject();
    res.json({ success: true, user: userInfo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/shop/items', async (req, res) => {
  try {
    const items = await Item.find();
    res.json({ success: true, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/shop/buy', async (req, res) => {
  const { username, itemId } = req.body;
  try {
    const user = await User.findOne({ username });
    const item = await Item.findOne({ itemId });

    if (!user || !item) return res.status(400).json({ error: '用户或道具信息不存在' });
    if (user.inventory.includes(itemId)) return res.status(400).json({ error: '你已拥有该商品' });
    if (user.coins < item.price) return res.status(400).json({ error: '金币不足，请多赢几局后再来购买！' });

    user.coins -= item.price;
    user.inventory.push(itemId);
    if (item.type === 'SKIN') user.equippedCardSkin = itemId;
    if (item.type === 'AVATAR') user.avatar = item.icon;

    await user.save();
    const { password: _, ...userInfo } = user.toObject();
    res.json({ success: true, user: userInfo, message: `成功购买并装备了【${item.name}】！` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ADMIN API
app.get('/api/admin/users', async (req, res) => {
  try {
    const users = await User.find({}, '-password');
    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/update-coins', async (req, res) => {
  const { username, amount } = req.body;
  try {
    const user = await User.findOneAndUpdate({ username }, { $inc: { coins: amount } }, { new: true });
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

app.delete('/api/admin/delete-item/:itemId', async (req, res) => {
  try {
    await Item.deleteOne({ itemId: req.params.itemId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- 3. Socket.IO 房间系统 ---
const rooms = {};

io.on('connection', (socket) => {
  socket.on('create_room', async ({ roomId, username }) => {
    if (rooms[roomId]) return socket.emit('error_message', '房间号已被使用！');
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
    if (room.players.length >= 2) return socket.emit('error_message', '房间满员！');

    const user = await User.findOne({ username });
    room.players.push({ id: socket.id, username, coins: user ? user.coins : 0, avatar: user ? user.avatar : '👑' });
    socket.join(roomId);

    io.to(roomId).emit('room_updated', room);

    if (room.players.length === 2) {
      room.status = 'playing';
      room.turnIndex = Math.floor(Math.random() * 2);
      const firstPlayer = room.players[room.turnIndex];

      io.to(roomId).emit('game_start', {
        message: `对局开启！由【${firstPlayer.username}】先手出牌！`,
        room,
        currentTurnSocketId: firstPlayer.id
      });
    }
  });

  socket.on('play_cards', ({ roomId, handInfo }) => {
    const room = rooms[roomId];
    if (!room) return;

    const currentTurnPlayer = room.players[room.turnIndex];
    if (currentTurnPlayer.id !== socket.id) return socket.emit('error_message', '非你的出牌回合！');

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
    if (currentTurnPlayer.id !== socket.id) return socket.emit('error_message', '非你的回合！');

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
        message: `🏆 恭喜玩家 【${winnerUsername}】 获得本局胜利！结算获得 300 金币！`
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
