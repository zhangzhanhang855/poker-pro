const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

// ==========================================
// CONFIGURATION & MONGO DB SETUP
// ==========================================
// Replace this with your actual MongoDB URI string if not using environment variables:
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/unogame";

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname)));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

mongoose.connect(MONGO_URI)
  .then(() => console.log('Successfully connected to MongoDB.'))
  .catch((err) => console.error('MongoDB connection error:', err));

const MatchResultSchema = new mongoose.Schema({
  winner: String,
  winningScore: Number,
  playersScores: Object,
  date: { type: Date, default: Date.now }
});
const MatchResult = mongoose.model('MatchResult', MatchResultSchema);

// ==========================================
// DECK ENGINE & GAME LOGIC STATE
// ==========================================
const COLORS = ['Red', 'Yellow', 'Green', 'Blue'];
const VALUES = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'Skip', 'Reverse', 'Draw2'];

function buildStandardUnoDeck() {
  let deck = [];
  let idCounter = 1;

  for (let color of COLORS) {
    // One '0' card per color
    deck.push({ id: idCounter++, color, value: '0', score: 0 });
    
    // Two of '1'-'9', Skip, Reverse, Draw2 per color
    for (let i = 0; i < 2; i++) {
      for (let val = 1; val <= 9; val++) {
        deck.push({ id: idCounter++, color, value: String(val), score: val });
      }
      deck.push({ id: idCounter++, color, value: 'Skip', score: 20 });
      deck.push({ id: idCounter++, color, value: 'Reverse', score: 20 });
      deck.push({ id: idCounter++, color, value: 'Draw2', score: 20 });
    }
  }

  // Wild & Wild Draw Four (4 cards each)
  for (let i = 0; i < 4; i++) {
    deck.push({ id: idCounter++, color: 'Wild', value: 'Wild', score: 50 });
    deck.push({ id: idCounter++, color: 'Wild', value: 'Wild4', score: 50 });
  }

  return shuffle(deck);
}

function shuffle(array) {
  let deck = [...array];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

class UnoGameSession {
  constructor() {
    this.players = []; // [{ id, name, hand: [], totalScore: 0, calledUno: false }]
    this.drawPile = [];
    this.discardPile = [];
    this.currentTurnIndex = 0;
    this.direction = 1; // 1 = Clockwise, -1 = Counter-Clockwise
    this.currentColor = '';
    this.activeValue = '';
    this.gameStarted = false;
    this.gameEnded = false;
    this.pendingChallenge = null; 
    this.logs = [];
  }

  log(msg) {
    this.logs.push(msg);
    if (this.logs.length > 25) this.logs.shift();
  }

  addPlayer(id, name) {
    if (this.gameStarted) return false;
    this.players.push({ id, name: name || `Player ${this.players.length + 1}`, hand: [], totalScore: 0, calledUno: false });
    this.log(`${name} joined the room.`);
    return true;
  }

  removePlayer(id) {
    this.players = this.players.filter(p => p.id !== id);
    if (this.players.length < 2 && this.gameStarted) {
      this.gameStarted = false;
      this.log('Game ended: Not enough players.');
    }
  }

  refillDrawPileIfNeeded(countNeeded) {
    if (this.drawPile.length < countNeeded) {
      if (this.discardPile.length <= 1) return;
      const topDiscard = this.discardPile.pop();
      const recycled = shuffle(this.discardPile.map(c => {
        if (c.value === 'Wild' || c.value === 'Wild4') return { ...c, color: 'Wild' };
        return c;
      }));
      this.drawPile = [...recycled, ...this.drawPile];
      this.discardPile = [topDiscard];
      this.log('Draw pile was empty. Reshuffled discard pile into draw pile.');
    }
  }

  drawCards(player, count) {
    this.refillDrawPileIfNeeded(count);
    let drawn = [];
    for (let i = 0; i < count; i++) {
      if (this.drawPile.length > 0) {
        drawn.push(this.drawPile.pop());
      }
    }
    player.hand.push(...drawn);
    player.calledUno = false; // Reset UNO status on drawing
    return drawn;
  }

  startNewRound() {
    this.drawPile = buildStandardUnoDeck();
    this.discardPile = [];
    this.direction = 1;
    this.currentTurnIndex = 0;
    this.pendingChallenge = null;
    this.gameStarted = true;
    this.gameEnded = false;

    // Deal 7 cards each
    for (let player of this.players) {
      player.hand = [];
      player.calledUno = false;
      this.drawCards(player, 7);
    }

    // Flip top card for discard pile (Handling starter card rules)
    let initialCard = this.drawPile.pop();
    while (initialCard.value === 'Wild4') {
      // Rule: If Wild +4, return to deck and flip a new card
      this.drawPile.unshift(initialCard);
      this.drawPile = shuffle(this.drawPile);
      initialCard = this.drawPile.pop();
    }

    this.discardPile.push(initialCard);
    this.currentColor = initialCard.color;
    this.activeValue = initialCard.value;
    this.log(`Round started! Top card is [${initialCard.color} ${initialCard.value}].`);

    // Handle special initial top card actions
    if (initialCard.value === 'Skip') {
      this.log(`Initial card is Skip! Player ${this.players[0].name} loses turn.`);
      this.advanceTurn();
    } else if (initialCard.value === 'Reverse') {
      this.log('Initial card is Reverse!');
      if (this.players.length === 2) {
        this.advanceTurn();
      } else {
        this.direction = -1;
        this.currentTurnIndex = this.players.length - 1;
      }
    } else if (initialCard.value === 'Draw2') {
      this.log(`Initial card is Draw2! ${this.players[0].name} draws 2 and loses turn.`);
      this.drawCards(this.players[0], 2);
      this.advanceTurn();
    } else if (initialCard.value === 'Wild') {
      this.currentColor = COLORS[Math.floor(Math.random() * COLORS.length)];
      this.log(`Initial card is Wild! Starting color randomly chosen: ${this.currentColor}.`);
    }
  }

  advanceTurn() {
    const num = this.players.length;
    this.currentTurnIndex = (this.currentTurnIndex + this.direction + num) % num;
  }

  getCurrentPlayer() {
    return this.players[this.currentTurnIndex];
  }

  getNextPlayer() {
    const num = this.players.length;
    const nextIdx = (this.currentTurnIndex + this.direction + num) % num;
    return this.players[nextIdx];
  }

  playCard(playerId, cardId, chosenColor = null) {
    if (this.pendingChallenge) return { success: false, reason: "Must resolve Wild +4 Challenge first!" };
    const player = this.getCurrentPlayer();
    if (player.id !== playerId) return { success: false, reason: "Not your turn!" };

    const cardIndex = player.hand.findIndex(c => c.id === cardId);
    if (cardIndex === -1) return { success: false, reason: "Card not in hand!" };

    const card = player.hand[cardIndex];
    const topCard = this.discardPile[this.discardPile.length - 1];

    // Rule Check: Color match, Value match, or Wild
    let isValid = false;
    if (card.color === 'Wild') {
      isValid = true;
    } else if (card.color === this.currentColor || card.value === this.activeValue) {
      isValid = true;
    }

    if (!isValid) return { success: false, reason: "Illegal card play! Must match Color or Number/Action." };

    // Strict Wild +4 validation rule context
    if (card.value === 'Wild4') {
      if (!chosenColor) return { success: false, reason: "Must declare a color for Wild +4!" };
      
      // Check if player had matching color cards in hand before playing +4
      const hasMatchingColor = player.hand.some(c => c.id !== card.id && c.color === this.currentColor);

      // Remove card from hand
      player.hand.splice(cardIndex, 1);
      card.color = chosenColor;
      this.discardPile.push(card);
      this.currentColor = chosenColor;
      this.activeValue = 'Wild4';

      // Setup Challenge Window
      const target = this.getNextPlayer();
      this.pendingChallenge = {
        bluffer: player,
        victim: target,
        hadMatchingColor: hasMatchingColor,
        declaredColor: chosenColor
      };

      this.log(`${player.name} played Wild +4 (Declared ${chosenColor}). ${target.name} may Challenge!`);
      this.checkUnoPenalties();
      return { success: true, challengeTriggered: true };
    }

    // Play standard card or regular Wild
    player.hand.splice(cardIndex, 1);
    if (card.color === 'Wild') {
      if (!chosenColor) return { success: false, reason: "Must declare a color!" };
      card.color = chosenColor;
      this.currentColor = chosenColor;
    } else {
      this.currentColor = card.color;
    }
    this.activeValue = card.value;
    this.discardPile.push(card);

    this.log(`${player.name} played [${card.color} ${card.value}].`);

    // Check round win
    if (player.hand.length === 0) {
      this.handleRoundWin(player);
      return { success: true, roundEnded: true };
    }

    this.checkUnoPenalties();

    // Execute card action effects
    if (card.value === 'Skip') {
      this.log(`${this.getNextPlayer().name} was skipped!`);
      this.advanceTurn();
      this.advanceTurn();
    } else if (card.value === 'Reverse') {
      if (this.players.length === 2) {
        this.log(`2-Player Reverse acts like Skip!`);
        this.advanceTurn();
        this.advanceTurn();
      } else {
        this.direction *= -1;
        this.log(`Direction reversed!`);
        this.advanceTurn();
      }
    } else if (card.value === 'Draw2') {
      const victim = this.getNextPlayer();
      this.log(`${victim.name} draws 2 cards and forfeits turn!`);
      this.drawCards(victim, 2);
      this.advanceTurn();
      this.advanceTurn();
    } else {
      this.advanceTurn();
    }

    return { success: true };
  }

  resolveChallenge(victimId, doChallenge) {
    if (!this.pendingChallenge) return;
    const { bluffer, victim, hadMatchingColor } = this.pendingChallenge;
    if (victim.id !== victimId) return;

    if (doChallenge) {
      if (hadMatchingColor) {
        // Bluffer cheated: Bluffer draws 4
        this.log(`CHALLENGE SUCCESSFUL! ${bluffer.name} had matching color! ${bluffer.name} draws 4 penalty cards.`);
        this.drawCards(bluffer, 4);
        // Victim loses no turn, advances turn normally past bluffer
        this.advanceTurn();
      } else {
        // Bluffer was innocent: Victim draws 6 (4 + 2 penalty) and loses turn
        this.log(`CHALLENGE FAILED! ${bluffer.name} was innocent. ${victim.name} draws 6 cards (4 + 2 penalty) and loses turn!`);
        this.drawCards(victim, 6);
        this.advanceTurn(); // Skip bluffer
        this.advanceTurn(); // Skip victim
      }
    } else {
      // Accepted: Victim draws 4 and loses turn
      this.log(`${victim.name} accepted the +4. Draws 4 cards and loses turn.`);
      this.drawCards(victim, 4);
      this.advanceTurn(); // Skip bluffer
      this.advanceTurn(); // Skip victim
    }

    this.pendingChallenge = null;
    
    if (bluffer.hand.length === 0) {
      this.handleRoundWin(bluffer);
    }
  }

  drawCardPass(playerId) {
    if (this.pendingChallenge) return;
    const player = this.getCurrentPlayer();
    if (player.id !== playerId) return;

    const drawn = this.drawCards(player, 1);
    this.log(`${player.name} drew a card.`);
    this.advanceTurn();
  }

  callUno(playerId) {
    const player = this.players.find(p => p.id === playerId);
    if (player && player.hand.length <= 2) {
      player.calledUno = true;
      this.log(`📣 ${player.name} shouted "UNO!"`);
    }
  }

  checkUnoPenalties() {
    // Catch players who have 1 card but didn't call UNO
    for (let p of this.players) {
      if (p.hand.length === 1 && !p.calledUno) {
        this.log(`⚠️ PENALTY! ${p.name} was caught with 1 card without calling UNO! Draws 2 cards.`);
        this.drawCards(p, 2);
      }
    }
  }

  handleRoundWin(winner) {
    let roundPoints = 0;
    for (let p of this.players) {
      if (p.id !== winner.id) {
        for (let card of p.hand) {
          roundPoints += card.score;
        }
      }
    }
    winner.totalScore += roundPoints;
    this.log(`🎉 ${winner.name} WON THE ROUND! Scored ${roundPoints} points!`);

    if (winner.totalScore >= 500) {
      this.gameEnded = true;
      this.log(`🏆 GAME OVER! ${winner.name} REACHED 500+ POINTS (${winner.totalScore} pts) AND IS THE UNO CHAMPION!`);
      
      // Save results to Mongo DB
      let scoresMap = {};
      this.players.forEach(p => scoresMap[p.name] = p.totalScore);
      MatchResult.create({
        winner: winner.name,
        winningScore: winner.totalScore,
        playersScores: scoresMap
      }).catch(e => console.error("Database save error:", e));

    } else {
      setTimeout(() => this.startNewRound(), 4000);
    }
  }

  getStateForPlayer(playerId) {
    return {
      players: this.players.map(p => ({
        id: p.id,
        name: p.name,
        cardCount: p.hand.length,
        totalScore: p.totalScore,
        calledUno: p.calledUno,
        isCurrent: this.getCurrentPlayer()?.id === p.id
      })),
      myHand: this.players.find(p => p.id === playerId)?.hand || [],
      topDiscard: this.discardPile[this.discardPile.length - 1] || null,
      currentColor: this.currentColor,
      activeValue: this.activeValue,
      drawPileCount: this.drawPile.length,
      currentTurnIndex: this.currentTurnIndex,
      direction: this.direction,
      gameStarted: this.gameStarted,
      gameEnded: this.gameEnded,
      pendingChallenge: this.pendingChallenge ? {
        victimId: this.pendingChallenge.victim.id,
        blufferName: this.pendingChallenge.bluffer.name
      } : null,
      logs: this.logs
    };
  }
}

// Single Room Instance for multi-client demo
const activeGame = new UnoGameSession();

io.on('connection', (socket) => {
  socket.emit('joined', { id: socket.id });

  socket.on('joinGame', (name) => {
    activeGame.addPlayer(socket.id, name);
    broadcastState();
  });

  socket.on('startGame', () => {
    if (activeGame.players.length >= 2 && !activeGame.gameStarted) {
      activeGame.startNewRound();
      broadcastState();
    }
  });

  socket.on('playCard', ({ cardId, chosenColor }) => {
    activeGame.playCard(socket.id, cardId, chosenColor);
    broadcastState();
  });

  socket.on('drawCard', () => {
    activeGame.drawCardPass(socket.id);
    broadcastState();
  });

  socket.on('callUno', () => {
    activeGame.callUno(socket.id);
    broadcastState();
  });

  socket.on('resolveChallenge', (doChallenge) => {
    activeGame.resolveChallenge(socket.id, doChallenge);
    broadcastState();
  });

  socket.on('disconnect', () => {
    activeGame.removePlayer(socket.id);
    broadcastState();
  });
});

function broadcastState() {
  for (let p of activeGame.players) {
    io.to(p.id).emit('gameState', activeGame.getStateForPlayer(p.id));
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`UNO Server running at http://localhost:${PORT}`);
});

