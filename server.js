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
    this.blindIncrease = settings.blindIncrease || 'none'; // 'none', 'perElimination'
    this.blindIncreaseAmount = settings.blindIncreaseAmount || 0;
    this.hostDisconnectBehavior = settings.hostDisconnectBehavior || 'pause';
    this.newPlayerChips = settings.newPlayerChips || 'starting'; // 'starting' or 'lowest'
    
    this.players = [];
    this.spectators = [];
    this.gameStarted = false;
    this.paused = false;
    this.deck = new Deck();
    this.communityCards = [];
    this.pot = 0;
    this.currentBet = 0;
    this.dealerIndex = 0;
    this.currentPlayerIndex = 0;
    this.gamePhase = 'waiting'; // waiting, preflop, flop, turn, river, showdown
    this.turnTimeout = null;
    this.disconnectTimers = new Map();
  }
  
  addPlayer(socketId, username, isSpectator = false) {
    if (isSpectator) {
      this.spectators.push({ socketId, username });
      return true;
    }
    
    if (this.players.length >= this.maxPlayers) return false;
    
    let chips = this.startingChips;
    if (this.gameStarted && this.newPlayerChips === 'lowest') {
      const activePlayers = this.players.filter(p => !p.folded && p.chips > 0);
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
      active: true,
      disconnected: false
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
  
  startGame() {
    if (this.players.length < 2) return false;
    this.gameStarted = true;
    this.startNewRound();
    return true;
  }
  
  startNewRound() {
    this.deck.reset();
    this.communityCards = [];
    this.pot = 0;
    this.currentBet = 0;
    this.gamePhase = 'preflop';
    
    // Reset players
    this.players.forEach(p => {
      p.bet = 0;
      p.folded = false;
      p.cards = [];
      p.hasActed = false;
      p.lastAction = null;
    });
    
    // Filter out players with no chips
    const activePlayers = this.players.filter(p => p.chips > 0 && !p.disconnected);
    if (activePlayers.length < 2) {
      this.gamePhase = 'ended';
      return;
    }
    
    // Move dealer button
    this.dealerIndex = (this.dealerIndex + 1) % activePlayers.length;
    
    // Deal cards
    activePlayers.forEach(p => {
      p.cards = [this.deck.deal(), this.deck.deal()];
    });
    
    // Post blinds
    const sbIndex = (this.dealerIndex + 1) % activePlayers.length;
    const bbIndex = (this.dealerIndex + 2) % activePlayers.length;
    
    this.placeBet(activePlayers[sbIndex], this.smallBlind);
    this.placeBet(activePlayers[bbIndex], this.bigBlind);
    this.currentBet = this.bigBlind;
    
    // Mark blinds as acted (but they can still raise when action comes back to them)
    activePlayers[sbIndex].hasActed = false;
    activePlayers[bbIndex].hasActed = false;
    
    // Set first player to act (UTG - under the gun, left of big blind)
    this.currentPlayerIndex = (this.dealerIndex + 3) % activePlayers.length;
    
    // For heads-up (2 players), dealer is small blind and acts first preflop
    if (activePlayers.length === 2) {
      this.currentPlayerIndex = this.dealerIndex;
    }
    
    this.startTurnTimer();
  }
  
  placeBet(player, amount) {
    const actualBet = Math.min(amount, player.chips);
    player.chips -= actualBet;
    player.bet += actualBet;
    this.pot += actualBet;
    return actualBet;
  }
  
  playerAction(socketId, action, amount = 0) {
    const player = this.getPlayer(socketId);
    if (!player || player.folded || this.paused) return false;
    
    const activePlayers = this.players.filter(p => p.chips > 0 && !p.folded && !p.disconnected);
    const currentPlayer = activePlayers[this.currentPlayerIndex];
    if (!currentPlayer || currentPlayer.socketId !== socketId) return false;
    
    this.clearTurnTimer();
    
    let actionMessage = '';
    
    switch (action) {
      case 'fold':
        player.folded = true;
        actionMessage = `${player.username} folded`;
        break;
      case 'check':
        if (player.bet < this.currentBet) return false;
        actionMessage = `${player.username} checked`;
        break;
      case 'call':
        const callAmount = Math.min(this.currentBet - player.bet, player.chips);
        this.placeBet(player, callAmount);
        actionMessage = `${player.username} called ${callAmount}`;
        break;
      case 'raise':
        // Validate raise amount
        if (amount > player.chips + player.bet) return false;
        if (amount < this.currentBet * 2 && player.chips + player.bet > this.currentBet * 2) return false;
        
        const raiseAmount = amount - player.bet;
        if (raiseAmount <= 0) return false;
        
        const oldBet = this.currentBet;
        this.placeBet(player, raiseAmount);
        this.currentBet = amount;
        actionMessage = `${player.username} raised from ${oldBet} to ${amount}`;
        
        // Reset hasActed for all other players
        this.players.forEach(p => {
          if (p.socketId !== socketId) p.hasActed = false;
        });
        break;
      default:
        return false;
    }
    
    player.hasActed = true;
    player.lastAction = action;
    
    // Broadcast action to all players
    this.broadcastAction(actionMessage);
    
    return this.advanceGame();
  }
  
  broadcastAction(message) {
    this.actionLog = this.actionLog || [];
    this.actionLog.push(message);
  }
  
  advanceGame() {
    const activePlayers = this.players.filter(p => !p.folded && !p.disconnected && p.chips >= 0);
    
    // Check if only one player left not folded
    const playersNotFolded = this.players.filter(p => !p.folded && !p.disconnected);
    if (playersNotFolded.length === 1) {
      this.endRound(playersNotFolded[0]);
      return true;
    }
    
    // Check if all players are all-in except one or none
    const playersWithChips = activePlayers.filter(p => p.chips > 0);
    if (playersWithChips.length <= 1) {
      // Skip to showdown - deal remaining cards
      while (this.gamePhase !== 'showdown' && this.gamePhase !== 'ended') {
        this.players.forEach(p => {
          p.hasActed = false;
          p.bet = 0;
        });
        this.currentBet = 0;
        this.lastRaiseAmount = 0;
        
        switch (this.gamePhase) {
          case 'preflop':
            this.gamePhase = 'flop';
            this.communityCards.push(this.deck.deal(), this.deck.deal(), this.deck.deal());
            break;
          case 'flop':
            this.gamePhase = 'turn';
            this.communityCards.push(this.deck.deal());
            break;
          case 'turn':
            this.gamePhase = 'river';
            this.communityCards.push(this.deck.deal());
            break;
          case 'river':
            this.gamePhase = 'showdown';
            this.determineWinner();
            return true;
        }
      }
      return true;
    }
    
    // Check if betting round is complete - all players with chips have acted and matched bet
    const playersToAct = activePlayers.filter(p => p.chips > 0 && (!p.hasActed || p.bet < this.currentBet));
    
    if (playersToAct.length === 0) {
      // Move to next phase
      this.players.forEach(p => {
        p.hasActed = false;
        p.bet = 0;
      });
      this.currentBet = 0;
      this.lastRaiseAmount = 0;
      
      switch (this.gamePhase) {
        case 'preflop':
          this.gamePhase = 'flop';
          this.communityCards.push(this.deck.deal(), this.deck.deal(), this.deck.deal());
          break;
        case 'flop':
          this.gamePhase = 'turn';
          this.communityCards.push(this.deck.deal());
          break;
        case 'turn':
          this.gamePhase = 'river';
          this.communityCards.push(this.deck.deal());
          break;
        case 'river':
          this.gamePhase = 'showdown';
          this.determineWinner();
          return true;
      }
      
      // First player to act after flop/turn/river is first active player left of dealer
      const playersCanAct = activePlayers.filter(p => p.chips > 0);
      if (playersCanAct.length > 0) {
        for (let i = 1; i <= activePlayers.length; i++) {
          const idx = (this.dealerIndex + i) % activePlayers.length;
          if (activePlayers[idx].chips > 0) {
            this.currentPlayerIndex = idx;
            break;
          }
        }
      }
    } else {
      // Move to next player who can act
      let attempts = 0;
      do {
        this.currentPlayerIndex = (this.currentPlayerIndex + 1) % activePlayers.length;
        attempts++;
      } while (attempts < activePlayers.length && 
               (activePlayers[this.currentPlayerIndex].folded || 
                activePlayers[this.currentPlayerIndex].chips === 0 ||
                (activePlayers[this.currentPlayerIndex].hasActed && 
                 activePlayers[this.currentPlayerIndex].bet >= this.currentBet)));
    }
    
    this.startTurnTimer();
    return true;
  }
  
  determineWinner() {
    const activePlayers = this.players.filter(p => !p.folded && !p.disconnected);
    
    const results = activePlayers.map(p => {
      const hand = PokerHand.rankHand([...p.cards, ...this.communityCards]);
      return { player: p, hand };
    });
    
    results.sort((a, b) => b.hand.score - a.hand.score);
    const winner = results[0].player;
    
    this.endRound(winner);
  }
  
  endRound(winner) {
    winner.chips += this.pot;
    
    // Check for blind increase
    if (this.blindIncrease === 'perElimination') {
      const eliminatedPlayers = this.players.filter(p => p.chips === 0);
      if (eliminatedPlayers.length > 0) {
        this.smallBlind += this.blindIncreaseAmount;
        this.bigBlind += this.blindIncreaseAmount * 2;
      }
    }
    
    // Check if game should continue
    const playersWithChips = this.players.filter(p => p.chips > 0);
    if (playersWithChips.length > 1) {
      setTimeout(() => this.startNewRound(), 5000);
    } else {
      this.gamePhase = 'ended';
    }
  }
  
  startTurnTimer() {
    this.clearTurnTimer();
    this.turnTimeout = setTimeout(() => {
      const activePlayers = this.players.filter(p => !p.folded && !p.disconnected && p.chips >= 0);
      if (activePlayers.length > 0) {
        const currentPlayer = activePlayers[this.currentPlayerIndex];
        this.playerAction(currentPlayer.socketId, 'fold');
      }
    }, this.turnTimer * 1000);
  }
  
  clearTurnTimer() {
    if (this.turnTimeout) {
      clearTimeout(this.turnTimeout);
      this.turnTimeout = null;
    }
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
        active: p.active,
        disconnected: p.disconnected,
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
    const activePlayers = this.players.filter(p => !p.folded && !p.disconnected && p.chips >= 0);
    const currentPlayerSocketId = activePlayers.length > 0 ? activePlayers[this.currentPlayerIndex]?.socketId : null;
    
    return {
      ...this.getPublicState(),
      communityCards: this.communityCards,
      pot: this.pot,
      currentBet: this.currentBet,
      gamePhase: this.gamePhase,
      dealerIndex: this.dealerIndex,
      currentPlayerIndex: this.currentPlayerIndex,
      currentPlayerSocketId,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      playerCards: player ? player.cards : null,
      isHost: socketId === this.hostId,
      isSpectator,
      actionLog: this.actionLog || []
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
      // Send personalized game state to each player
      table.players.forEach(p => {
        io.to(p.socketId).emit('gameState', table.getGameState(p.socketId));
      });
      table.spectators.forEach(s => {
        io.to(s.socketId).emit('gameState', table.getGameState(s.socketId));
      });
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
        // Send personalized game state to each player
        table.players.forEach(p => {
          io.to(p.socketId).emit('gameState', table.getGameState(p.socketId));
        });
        table.spectators.forEach(s => {
          io.to(s.socketId).emit('gameState', table.getGameState(s.socketId));
        });
      }
    }
  });
  
  socket.on('playerAction', ({ action, amount }) => {
    const tableId = playerSockets.get(socket.id);
    const table = tables.get(tableId);
    if (table && table.playerAction(socket.id, action, amount)) {
      // Send personalized game state to each player
      table.players.forEach(p => {
        io.to(p.socketId).emit('gameState', table.getGameState(p.socketId));
      });
      table.spectators.forEach(s => {
        io.to(s.socketId).emit('gameState', table.getGameState(s.socketId));
      });
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
      // Send personalized game state to each player
      table.players.forEach(p => {
        io.to(p.socketId).emit('gameState', table.getGameState(p.socketId));
      });
      table.spectators.forEach(s => {
        io.to(s.socketId).emit('gameState', table.getGameState(s.socketId));
      });
    }
  });
  
  socket.on('pauseGame', () => {
    const tableId = playerSockets.get(socket.id);
    const table = tables.get(tableId);
    if (table && table.hostId === socket.id) {
      table.paused = !table.paused;
      if (table.paused) table.clearTurnTimer();
      else table.startTurnTimer();
      // Send personalized game state to each player
      table.players.forEach(p => {
        io.to(p.socketId).emit('gameState', table.getGameState(p.socketId));
      });
      table.spectators.forEach(s => {
        io.to(s.socketId).emit('gameState', table.getGameState(s.socketId));
      });
    }
  });
  
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    const tableId = playerSockets.get(socket.id);
    if (tableId) {
      const table = tables.get(tableId);
      if (table) {
        const player = table.getPlayer(socket.id);
        if (player) {
          player.disconnected = true;
          
          // If host disconnects, close the table
          if (socket.id === table.hostId) {
            tables.delete(tableId);
            io.to(tableId).emit('tableClosed');
            return;
          }
          
          // Set disconnect timer
          const timer = setTimeout(() => {
            table.removePlayer(socket.id);
            // Send personalized game state to remaining players
            table.players.forEach(p => {
              io.to(p.socketId).emit('gameState', table.getGameState(p.socketId));
            });
            table.spectators.forEach(s => {
              io.to(s.socketId).emit('gameState', table.getGameState(s.socketId));
            });
          }, 300000); // 5 minutes
          
          table.disconnectTimers.set(socket.id, timer);
          // Send personalized game state to remaining players
          table.players.forEach(p => {
            io.to(p.socketId).emit('gameState', table.getGameState(p.socketId));
          });
          table.spectators.forEach(s => {
            io.to(s.socketId).emit('gameState', table.getGameState(s.socketId));
          });
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
