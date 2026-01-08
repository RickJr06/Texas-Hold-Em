const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static('public'));

// Game state storage
const tables = new Map();
const playerSockets = new Map();

// Poker hand evaluation utilities
class PokerHand {
  static rankHand(cards) {
    if (cards.length !== 7) return { rank: 0, score: 0 };
    
    const combos = this.getCombinations(cards, 5);
    let best = { rank: 0, score: 0, cards: [] };
    
    for (const combo of combos) {
      const result = this.evaluateHand(combo);
      if (result.score > best.score) {
        best = { ...result, cards: combo };
      }
    }
    return best;
  }
  
  static getCombinations(arr, k) {
    const result = [];
    const f = (start, combo) => {
      if (combo.length === k) {
        result.push([...combo]);
        return;
      }
      for (let i = start; i < arr.length; i++) {
        combo.push(arr[i]);
        f(i + 1, combo);
        combo.pop();
      }
    };
    f(0, []);
    return result;
  }
  
  static evaluateHand(cards) {
    const values = cards.map(c => c.value).sort((a, b) => b - a);
    const suits = cards.map(c => c.suit);
    const valueCounts = {};
    values.forEach(v => valueCounts[v] = (valueCounts[v] || 0) + 1);
    const counts = Object.values(valueCounts).sort((a, b) => b - a);
    const isFlush = suits.every(s => s === suits[0]);
    const isStraight = this.checkStraight(values);
    
    let rank = 0, score = 0;
    
    if (isStraight && isFlush) {
      rank = 8; // Straight flush
      score = 8000000 + Math.max(...values);
    } else if (counts[0] === 4) {
      rank = 7; // Four of a kind
      const quad = Object.keys(valueCounts).find(k => valueCounts[k] === 4);
      score = 7000000 + parseInt(quad) * 1000;
    } else if (counts[0] === 3 && counts[1] === 2) {
      rank = 6; // Full house
      const trip = Object.keys(valueCounts).find(k => valueCounts[k] === 3);
      const pair = Object.keys(valueCounts).find(k => valueCounts[k] === 2);
      score = 6000000 + parseInt(trip) * 1000 + parseInt(pair);
    } else if (isFlush) {
      rank = 5; // Flush
      score = 5000000 + values.reduce((acc, v, i) => acc + v * Math.pow(100, 4 - i), 0);
    } else if (isStraight) {
      rank = 4; // Straight
      score = 4000000 + Math.max(...values);
    } else if (counts[0] === 3) {
      rank = 3; // Three of a kind
      const trip = Object.keys(valueCounts).find(k => valueCounts[k] === 3);
      score = 3000000 + parseInt(trip) * 1000;
    } else if (counts[0] === 2 && counts[1] === 2) {
      rank = 2; // Two pair
      const pairs = Object.keys(valueCounts).filter(k => valueCounts[k] === 2).map(Number).sort((a, b) => b - a);
      score = 2000000 + pairs[0] * 10000 + pairs[1] * 100;
    } else if (counts[0] === 2) {
      rank = 1; // One pair
      const pair = Object.keys(valueCounts).find(k => valueCounts[k] === 2);
      score = 1000000 + parseInt(pair) * 1000;
    } else {
      rank = 0; // High card
      score = values.reduce((acc, v, i) => acc + v * Math.pow(100, 4 - i), 0);
    }
    
    return { rank, score };
  }
  
  static checkStraight(values) {
    const unique = [...new Set(values)].sort((a, b) => b - a);
    if (unique.length < 5) return false;
    
    // Check for regular straights
    for (let i = 0; i <= unique.length - 5; i++) {
      if (unique[i] - unique[i + 4] === 4) return true;
    }
    
    // Check for A-2-3-4-5 straight (wheel)
    if (unique.includes(14) && unique.includes(5) && unique.includes(4) && 
        unique.includes(3) && unique.includes(2)) {
      return true;
    }
    
    return false;
  }
  
  static getHandName(rank) {
    const names = ['High Card', 'One Pair', 'Two Pair', 'Three of a Kind', 'Straight', 'Flush', 'Full House', 'Four of a Kind', 'Straight Flush'];
    return names[rank] || 'Unknown';
  }
}

class Deck {
  constructor() {
    this.reset();
  }
  
  reset() {
    this.cards = [];
    const suits = ['hearts', 'diamonds', 'clubs', 'spades'];
    const values = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]; // 11=J, 12=Q, 13=K, 14=A
    for (const suit of suits) {
      for (const value of values) {
        this.cards.push({ suit, value });
      }
    }
    this.shuffle();
  }
  
  shuffle() {
    for (let i = this.cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
    }
  }
  
  deal() {
    return this.cards.pop();
  }
}

class Table {
  constructor(id, hostId, settings) {
    this.id = id;
    this.hostId = hostId;
    this.name = settings.name;
    this.password = settings.password;
    this.maxPlayers = settings.maxPlayers;
    this.startingChips = settings.startingChips;
    this.smallBlind = settings.smallBlind;
    this.bigBlind = settings.bigBlind;
    this.turnTimer = settings.turnTimer || 90;
    this.blindIncrease = settings.blindIncrease || 'none';
    this.blindIncreaseAmount = settings.blindIncreaseAmount || 0;
    this.hostDisconnectBehavior = settings.hostDisconnectBehavior || 'pause';
    this.newPlayerChips = settings.newPlayerChips || 'starting';
    
    this.players = [];
    this.spectators = [];
    this.gameStarted = false;
    this.paused = false;
    this.deck = new Deck();
    this.communityCards = [];
    this.pot = 0;
    this.currentBet = 0;
    this.minRaise = 0;
    this.dealerPosition = -1; // Index in players array
    this.currentTurnPosition = -1;
    this.gamePhase = 'waiting'; // waiting, preflop, flop, turn, river, showdown
    this.turnTimeout = null;
    this.disconnectTimers = new Map();
    this.actionLog = [];
  }
  
  addPlayer(socketId, username, isSpectator = false) {
    if (isSpectator) {
      this.spectators.push({ socketId, username });
      return true;
    }
    
    if (this.players.length >= this.maxPlayers) return false;
    
    let chips = this.startingChips;
    if (this.gameStarted && this.newPlayerChips === 'lowest') {
      const activePlayers = this.players.filter(p => p.chips > 0);
      if (activePlayers.length > 0) {
        chips = Math.min(...activePlayers.map(p => p.chips));
      }
    }
    
    this.players.push({
      socketId,
      username,
      chips,
      bet: 0,
      folded: false,
      cards: [],
      disconnected: false,
      isAllIn: false,
      totalBetThisRound: 0
    });
    return true;
  }
  
  removePlayer(socketId) {
    this.players = this.players.filter(p => p.socketId !== socketId);
    this.spectators = this.spectators.filter(s => s.socketId !== socketId);
  }
  
  getPlayer(socketId) {
    return this.players.find(p => p.socketId === socketId);
  }
  
  getActivePlayers() {
    return this.players.filter(p => p.chips > 0 && !p.disconnected);
  }
  
  getPlayersInHand() {
    return this.players.filter(p => !p.folded && !p.disconnected && p.chips >= 0);
  }
  
  startGame() {
    const active = this.getActivePlayers();
    if (active.length < 2) return false;
    
    this.gameStarted = true;
    this.dealerPosition = -1; // Will be incremented to 0 on first hand
    this.startNewHand();
    return true;
  }
  
  startNewHand() {
    const active = this.getActivePlayers();
    if (active.length < 2) {
      this.gamePhase = 'ended';
      if (active.length === 1) {
        this.broadcastAction(`${active[0].username} wins the tournament!`);
      }
      return;
    }
    
    // Reset for new hand
    this.deck.reset();
    this.communityCards = [];
    this.pot = 0;
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    this.gamePhase = 'preflop';
    this.actionLog = [];
    
    this.players.forEach(p => {
      p.bet = 0;
      p.folded = false;
      p.cards = [];
      p.isAllIn = false;
      p.totalBetThisRound = 0;
      p.hasActedThisRound = false;
    });
    
    // Move dealer button to next active player
    this.dealerPosition = this.getNextActivePosition(this.dealerPosition);
    
    // Deal 2 cards to each active player
    active.forEach(p => {
      p.cards = [this.deck.deal(), this.deck.deal()];
    });
    
    // Post blinds
    const isHeadsUp = active.length === 2;
    let sbPosition, bbPosition, firstToActPosition;
    
    if (isHeadsUp) {
      // Heads-up: dealer is SB, other player is BB
      sbPosition = this.dealerPosition;
      bbPosition = this.getNextActivePosition(sbPosition);
      firstToActPosition = sbPosition; // SB acts first preflop in heads-up
    } else {
      // Multi-way: SB left of dealer, BB left of SB
      sbPosition = this.getNextActivePosition(this.dealerPosition);
      bbPosition = this.getNextActivePosition(sbPosition);
      firstToActPosition = this.getNextActivePosition(bbPosition); // UTG
    }
    
    // Post small blind
    const sbPlayer = this.players[sbPosition];
    const sbAmount = Math.min(this.smallBlind, sbPlayer.chips);
    sbPlayer.chips -= sbAmount;
    sbPlayer.bet = sbAmount;
    sbPlayer.totalBetThisRound = sbAmount;
    this.pot += sbAmount;
    if (sbPlayer.chips === 0) sbPlayer.isAllIn = true;
    
    // Post big blind
    const bbPlayer = this.players[bbPosition];
    const bbAmount = Math.min(this.bigBlind, bbPlayer.chips);
    bbPlayer.chips -= bbAmount;
    bbPlayer.bet = bbAmount;
    bbPlayer.totalBetThisRound = bbAmount;
    this.pot += bbAmount;
    this.currentBet = bbAmount;
    if (bbPlayer.chips === 0) bbPlayer.isAllIn = true;
    
    this.broadcastAction(`${sbPlayer.username} posts small blind $${sbAmount}`);
    this.broadcastAction(`${bbPlayer.username} posts big blind $${bbAmount}`);
    
    // Set first player to act
    this.currentTurnPosition = firstToActPosition;
    this.startTurnTimer();
  }
  
  getNextActivePosition(fromPosition) {
    const active = this.getActivePlayers();
    if (active.length === 0) return -1;
    
    let attempts = 0;
    let pos = (fromPosition + 1) % this.players.length;
    
    while (attempts < this.players.length) {
      const player = this.players[pos];
      if (player.chips > 0 && !player.disconnected) {
        return pos;
      }
      pos = (pos + 1) % this.players.length;
      attempts++;
    }
    
    return -1;
  }
  
  playerAction(socketId, action, amount = 0) {
    const player = this.getPlayer(socketId);
    if (!player || player.folded || player.isAllIn || this.paused) return false;
    
    // Verify it's this player's turn
    if (this.players[this.currentTurnPosition]?.socketId !== socketId) return false;
    
    this.clearTurnTimer();
    
    let actionMessage = '';
    const callAmount = this.currentBet - player.bet;
    
    switch (action) {
      case 'fold':
        player.folded = true;
        actionMessage = `${player.username} folds`;
        break;
        
      case 'check':
        if (player.bet < this.currentBet) return false; // Can't check if there's a bet to call
        player.hasActedThisRound = true;
        actionMessage = `${player.username} checks`;
        break;
        
      case 'call':
        const actualCall = Math.min(callAmount, player.chips);
        player.chips -= actualCall;
        player.bet += actualCall;
        player.totalBetThisRound += actualCall;
        this.pot += actualCall;
        player.hasActedThisRound = true;
        
        if (player.chips === 0) {
          player.isAllIn = true;
          actionMessage = `${player.username} calls $${actualCall} (all-in)`;
        } else {
          actionMessage = `${player.username} calls $${actualCall}`;
        }
        break;
        
      case 'raise':
        // Validate raise
        if (amount <= this.currentBet) return false; // Must raise higher than current bet
        if (amount - this.currentBet < this.minRaise && player.chips + player.bet > amount) {
          return false; // Must raise by at least minRaise (unless all-in)
        }
        if (amount > player.chips + player.bet) return false; // Can't bet more than you have
        
        const raiseAmount = amount - player.bet;
        player.chips -= raiseAmount;
        player.bet = amount;
        player.totalBetThisRound += raiseAmount;
        this.pot += raiseAmount;
        
        // Update min raise for next raise (must raise by at least this much)
        this.minRaise = amount - this.currentBet;
        this.currentBet = amount;
        
        // Reset hasActed for all other players (they need to respond to the raise)
        this.players.forEach(p => {
          if (p.socketId !== socketId && !p.folded && !p.isAllIn) {
            p.hasActedThisRound = false;
          }
        });
        
        player.hasActedThisRound = true;
        
        if (player.chips === 0) {
          player.isAllIn = true;
          actionMessage = `${player.username} raises to $${amount} (all-in)`;
        } else {
          actionMessage = `${player.username} raises to $${amount}`;
        }
        break;
        
      default:
        return false;
    }
    
    player.lastAction = action;
    this.broadcastAction(actionMessage);
    
    // Check if hand is over or move to next player
    const inHand = this.getPlayersInHand();
    const notFolded = inHand.filter(p => !p.folded);
    
    if (notFolded.length === 1) {
      // Everyone else folded, hand is over
      this.endHand(notFolded[0]);
      return true;
    }
    
    // Check if betting round is complete
    if (this.isBettingRoundComplete()) {
      this.advanceToNextStreet();
    } else {
      this.moveToNextPlayer();
    }
    
    return true;
  }
  
  isBettingRoundComplete() {
    const inHand = this.getPlayersInHand();
    const canAct = inHand.filter(p => !p.folded && !p.isAllIn);
    
    // Everyone all-in or folded
    if (canAct.length === 0) return true;
    
    // Check if all players who can act have acted and matched the current bet
    for (const player of canAct) {
      if (!player.hasActedThisRound || player.bet < this.currentBet) {
        return false;
      }
    }
    
    return true;
  }
  
  moveToNextPlayer() {
    let attempts = 0;
    
    while (attempts < this.players.length) {
      this.currentTurnPosition = (this.currentTurnPosition + 1) % this.players.length;
      const player = this.players[this.currentTurnPosition];
      
      // Found next player who can act
      if (!player.folded && !player.disconnected && !player.isAllIn && player.chips > 0) {
        this.startTurnTimer();
        return;
      }
      
      attempts++;
    }
    
    // No one can act, advance to next street
    this.advanceToNextStreet();
  }
  
  advanceToNextStreet() {
    // Reset for next betting round
    this.players.forEach(p => {
      p.bet = 0;
      p.hasActedThisRound = false;
    });
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    
    const inHand = this.getPlayersInHand();
    const notFolded = inHand.filter(p => !p.folded);
    const canAct = notFolded.filter(p => !p.isAllIn && p.chips > 0);
    
    // If only 0-1 players can act, deal all remaining cards and go to showdown
    if (canAct.length <= 1) {
      while (this.gamePhase !== 'showdown') {
        this.dealNextStreet();
      }
      this.determineWinner();
      return;
    }
    
    // Deal next street
    this.dealNextStreet();
    
    if (this.gamePhase === 'showdown') {
      this.determineWinner();
      return;
    }
    
    // First to act is first active player left of dealer
    this.currentTurnPosition = this.getNextActivePosition(this.dealerPosition);
    
    // Skip players who are folded or all-in
    while (this.currentTurnPosition !== -1) {
      const player = this.players[this.currentTurnPosition];
      if (!player.folded && !player.isAllIn && player.chips > 0) {
        break;
      }
      this.currentTurnPosition = this.getNextActivePosition(this.currentTurnPosition);
    }
    
    this.startTurnTimer();
  }
  
  dealNextStreet() {
    switch (this.gamePhase) {
      case 'preflop':
        this.gamePhase = 'flop';
        this.communityCards.push(this.deck.deal(), this.deck.deal(), this.deck.deal());
        this.broadcastAction('Flop: ' + this.communityCards.map(c => this.cardToString(c)).join(' '));
        break;
      case 'flop':
        this.gamePhase = 'turn';
        this.communityCards.push(this.deck.deal());
        this.broadcastAction('Turn: ' + this.cardToString(this.communityCards[3]));
        break;
      case 'turn':
        this.gamePhase = 'river';
        this.communityCards.push(this.deck.deal());
        this.broadcastAction('River: ' + this.cardToString(this.communityCards[4]));
        break;
      case 'river':
        this.gamePhase = 'showdown';
        break;
    }
  }
  
  cardToString(card) {
    const suits = { hearts: '♥', diamonds: '♦', clubs: '♣', spades: '♠' };
    const values = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
    return (values[card.value] || card.value) + suits[card.suit];
  }
  
  determineWinner() {
    const inHand = this.getPlayersInHand().filter(p => !p.folded);
    
    if (inHand.length === 0) return;
    if (inHand.length === 1) {
      this.endHand(inHand[0]);
      return;
    }
    
    // Evaluate hands
    const results = inHand.map(p => ({
      player: p,
      hand: PokerHand.rankHand([...p.cards, ...this.communityCards]),
    }));
    
    results.sort((a, b) => b.hand.score - a.hand.score);
    
    // Check for ties
    const winners = [results[0]];
    for (let i = 1; i < results.length; i++) {
      if (results[i].hand.score === results[0].hand.score) {
        winners.push(results[i]);
      } else {
        break;
      }
    }
    
    if (winners.length === 1) {
      const winner = winners[0].player;
      const handName = PokerHand.getHandName(winners[0].hand.rank);
      this.broadcastAction(`${winner.username} wins $${this.pot} with ${handName}`);
      this.endHand(winner);
    } else {
      // Split pot
      const splitAmount = Math.floor(this.pot / winners.length);
      winners.forEach(w => {
        w.player.chips += splitAmount;
        this.broadcastAction(`${w.player.username} wins $${splitAmount} (split pot)`);
      });
      this.scheduleNextHand();
    }
  }
  
  endHand(winner) {
    winner.chips += this.pot;
    this.scheduleNextHand();
  }
  
  scheduleNextHand() {
    // Check for blind increase
    const eliminated = this.players.filter(p => p.chips === 0 && !p.eliminated);
    if (this.blindIncrease === 'perElimination' && eliminated.length > 0) {
      eliminated.forEach(p => p.eliminated = true);
      this.smallBlind += this.blindIncreaseAmount;
      this.bigBlind = this.smallBlind * 2;
      this.broadcastAction(`Blinds increased to $${this.smallBlind}/$${this.bigBlind}`);
    }
    
    // Remove eliminated players
    this.players = this.players.filter(p => p.chips > 0);
    
    const active = this.getActivePlayers();
    if (active.length < 2) {
      this.gamePhase = 'ended';
      if (active.length === 1) {
        this.broadcastAction(`${active[0].username} wins the tournament!`);
      }
      return;
    }
    
    this.gamePhase = 'waiting_next_hand';
    setTimeout(() => {
      if (this.getActivePlayers().length >= 2) {
        this.startNewHand();
        this.broadcastGameState();
      }
    }, 5000);
  }
  
  startTurnTimer() {
    this.clearTurnTimer();
    this.turnTimeout = setTimeout(() => {
      const player = this.players[this.currentTurnPosition];
      if (player && !player.folded && !player.isAllIn) {
        // Auto-fold on timeout
        this.playerAction(player.socketId, 'fold');
        this.broadcastGameState();
      }
    }, this.turnTimer * 1000);
  }
  
  clearTurnTimer() {
    if (this.turnTimeout) {
      clearTimeout(this.turnTimeout);
      this.turnTimeout = null;
    }
  }
  
  broadcastAction(message) {
    this.actionLog.push(message);
  }
  
  broadcastGameState() {
    this.players.forEach(p => {
      io.to(p.socketId).emit('gameState', this.getGameState(p.socketId));
    });
    this.spectators.forEach(s => {
      io.to(s.socketId).emit('gameState', this.getGameState(s.socketId));
    });
  }
  
  getPublicState() {
    return {
      id: this.id,
      name: this.name,
      players: this.players.map(p => ({
        socketId: p.socketId,
        username: p.username,
        chips: p.chips,
        bet: p.bet,
        folded: p.folded,
        disconnected: p.disconnected,
        isAllIn: p.isAllIn,
        lastAction: p.lastAction
      })),
      spectatorCount: this.spectators.length,
      gameStarted: this.gameStarted,
      maxPlayers: this.maxPlayers,
      paused: this.paused
    };
  }
  
  getGameState(socketId) {
    const player = this.getPlayer(socketId);
    const isSpectator = this.spectators.some(s => s.socketId === socketId);
    
    let currentPlayerSocketId = null;
    if (this.currentTurnPosition >= 0 && this.currentTurnPosition < this.players.length) {
      currentPlayerSocketId = this.players[this.currentTurnPosition]?.socketId;
    }
    
    return {
      ...this.getPublicState(),
      communityCards: this.communityCards,
      pot: this.pot,
      currentBet: this.currentBet,
      gamePhase: this.gamePhase,
      dealerIndex: this.dealerPosition,
      currentPlayerSocketId,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      playerCards: player ? player.cards : null,
      isHost: socketId === this.hostId,
      isSpectator,
      actionLog: this.actionLog,
      mySocketId: socketId
    };
  }
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  socket.on('getTables', () => {
    const tableList = Array.from(tables.values()).map(t => t.getPublicState());
    socket.emit('tableList', tableList);
  });
  
  socket.on('createTable', (settings) => {
    const tableId = Date.now().toString();
    const table = new Table(tableId, socket.id, settings);
    tables.set(tableId, table);
    socket.emit('tableCreated', { tableId });
  });
  
  socket.on('joinTable', ({ tableId, password, username, isSpectator }) => {
    const table = tables.get(tableId);
    if (!table) {
      socket.emit('error', 'Table not found');
      return;
    }
    
    if (table.password !== password) {
      socket.emit('error', 'Incorrect password');
      return;
    }
    
    if (table.addPlayer(socket.id, username, isSpectator)) {
      socket.join(tableId);
      playerSockets.set(socket.id, tableId);
      table.broadcastGameState();
      socket.emit('joinedTable', { tableId });
    } else {
      socket.emit('error', 'Table is full');
    }
  });
  
  socket.on('startGame', () => {
    const tableId = playerSockets.get(socket.id);
    const table = tables.get(tableId);
    if (table && table.hostId === socket.id) {
      if (table.startGame()) {
        table.broadcastGameState();
      }
    }
  });
  
  socket.on('playerAction', ({ action, amount }) => {
    const tableId = playerSockets.get(socket.id);
    const table = tables.get(tableId);
    if (table && table.playerAction(socket.id, action, amount)) {
      table.broadcastGameState();
    }
  });
  
  socket.on('chat', (message) => {
    const tableId = playerSockets.get(socket.id);
    const table = tables.get(tableId);
    if (table) {
      const player = table.getPlayer(socket.id) || table.spectators.find(s => s.socketId === socket.id);
      if (player) {
        io.to(tableId).emit('chatMessage', {
          username: player.username,
          message,
          timestamp: Date.now()
        });
      }
    }
  });
  
  socket.on('reaction', (emoji) => {
    const tableId = playerSockets.get(socket.id);
    const table = tables.get(tableId);
    if (table) {
      const player = table.getPlayer(socket.id) || table.spectators.find(s => s.socketId === socket.id);
      if (player) {
        io.to(tableId).emit('playerReaction', {
          username: player.username,
          emoji
        });
      }
    }
  });
  
  socket.on('kickPlayer', (targetSocketId) => {
    const tableId = playerSockets.get(socket.id);
    const table = tables.get(tableId);
    if (table && table.hostId === socket.id) {
      table.removePlayer(targetSocketId);
      io.to(targetSocketId).emit('kicked');
      table.broadcastGameState();
    }
  });
  
  socket.on('pauseGame', () => {
    const tableId = playerSockets.get(socket.id);
    const table = tables.get(tableId);
    if (table && table.hostId === socket.id) {
      table.paused = !table.paused;
      if (table.paused) table.clearTurnTimer();
      else table.startTurnTimer();
      table.broadcastGameState();
    }
  });
  
  socket.on('leaveTable', () => {
    const tableId = playerSockets.get(socket.id);
    if (tableId) {
      const table = tables.get(tableId);
      if (table) {
        if (socket.id === table.hostId) {
          io.to(tableId).emit('tableClosed', 'Host has closed the table');
          tables.delete(tableId);
          Array.from(playerSockets.entries()).forEach(([sid, tid]) => {
            if (tid === tableId) playerSockets.delete(sid);
          });
        } else {
          table.removePlayer(socket.id);
          socket.leave(tableId);
          
          if (table.players.length === 0 && table.spectators.length === 0) {
            tables.delete(tableId);
          } else {
            table.broadcastGameState();
          }
        }
      }
      playerSockets.delete(socket.id);
    }
    socket.emit('leftTable');
  });
  
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    const tableId = playerSockets.get(socket.id);
    if (tableId) {
      const table = tables.get(tableId);
      if (table) {
        if (socket.id === table.hostId) {
          io.to(tableId).emit('tableClosed', 'Host has left the game');
          tables.delete(tableId);
          Array.from(playerSockets.entries()).forEach(([sid, tid]) => {
            if (tid === tableId) playerSockets.delete(sid);
          });
          return;
        }
        
        const player = table.getPlayer(socket.id);
        if (player) {
          player.disconnected = true;
          
          const timer = setTimeout(() => {
            table.removePlayer(socket.id);
            playerSockets.delete(socket.id);
            
            if (table.players.length === 0 && table.spectators.length === 0) {
              tables.delete(tableId);
            } else {
              table.broadcastGameState();
            }
          }, 300000);
          
          table.disconnectTimers.set(socket.id, timer);
          table.broadcastGameState();
        } else {
          table.spectators = table.spectators.filter(s => s.socketId !== socket.id);
        }
      }
      playerSockets.delete(socket.id);
    }
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
