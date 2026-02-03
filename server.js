const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// Serve static files
app.use(express.static(path.join(__dirname)));

// Game state
const players = new Map();
const matches = new Map();
const matchmakingQueues = new Map(); // stake -> [player ids]
const rematchWaiting = new Map(); // matchId -> [player ids waiting]
const lobbies = new Map(); // code -> lobby
const readyPlayers = new Map(); // matchId -> Set of player ids who are ready

// Generate unique lobby code
function generateLobbyCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return lobbies.has(code) ? generateLobbyCode() : code;
}

function broadcastLobbyList() {
    const lobbyList = Array.from(lobbies.values()).map(l => ({
        code: l.code,
        host: l.host.name,
        hostAvatar: l.host.avatar,
        stake: l.stake,
        players: l.players.length
    }));
    io.emit('lobbyList', lobbyList);
}

// Card definitions
const CARDS = [
    {id:'HIT', name:'Hit', rarity:'common', icon:'⚔️', text:'Deal 3 damage', effect:{type:'damage', amount:3}},
    {id:'BLOCK', name:'Block', rarity:'common', icon:'🛡️', text:'Block next hit', effect:{type:'block'}},
    {id:'CRIT', name:'Crit', rarity:'uncommon', icon:'⚡', text:'Deal 5 damage', effect:{type:'damage', amount:5}},
    {id:'HEAL', name:'Heal', rarity:'uncommon', icon:'💚', text:'Restore 3 HP', effect:{type:'heal', amount:3}},
    {id:'CURSE', name:'Curse', rarity:'common', icon:'💀', text:'Take 2 damage', effect:{type:'self_damage', amount:2}},
    {id:'DRAIN', name:'Drain', rarity:'rare', icon:'🧛', text:'Deal 2, heal 2', effect:{type:'drain', damage:2, heal:2}},
    {id:'PIERCE', name:'Pierce', rarity:'uncommon', icon:'🗡️', text:'Deal 2, ignore block', effect:{type:'pierce', amount:2}},
    {id:'DOUBLE', name:'Double', rarity:'rare', icon:'✨', text:'Deal 6 damage', effect:{type:'damage', amount:6}}
];

const WEIGHTS = {HIT:30, BLOCK:25, CURSE:15, CRIT:12, HEAL:8, PIERCE:5, DRAIN:3, DOUBLE:2};
const CARD_REVEAL_DELAY = 3000; // 3 seconds between cards (50% slower)

// Seeded RNG
function createRNG(seed) {
    let state = seed;
    return function() {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        return state / 0x7fffffff;
    };
}

function weightedPick(rng) {
    const total = Object.values(WEIGHTS).reduce((a,b) => a+b, 0);
    let r = rng() * total;
    for (const [id, w] of Object.entries(WEIGHTS)) {
        r -= w;
        if (r <= 0) return {...CARDS.find(c => c.id === id)};
    }
    return {...CARDS[0]};
}

// Create a new match
function createMatch(player1, player2, stake) {
    const seed = Date.now();
    const rng = createRNG(seed);

    const match = {
        id: `match_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        seed,
        stake,
        players: {
            [player1.id]: {
                id: player1.id,
                name: player1.name,
                avatar: player1.avatar,
                hp: 10,
                maxHp: 10,
                cards: [],
                blocked: false
            },
            [player2.id]: {
                id: player2.id,
                name: player2.name,
                avatar: player2.avatar,
                hp: 10,
                maxHp: 10,
                cards: [],
                blocked: false
            }
        },
        playerOrder: [player1.id, player2.id],
        revealIndex: -1,
        matchOver: false,
        winner: null,
        combatLog: [],
        autoDrawTimer: null
    };

    // Deal 3 cards to each player
    for (let i = 0; i < 3; i++) {
        match.players[player1.id].cards.push({...weightedPick(rng), instanceId: `p1_${i}`});
        match.players[player2.id].cards.push({...weightedPick(rng), instanceId: `p2_${i}`});
    }

    match.rng = rng;
    return match;
}

// Resolve a card effect
function resolveCard(card, owner, target, match) {
    const e = card.effect;
    const log = [];

    log.push({msg: `${owner.name} plays ${card.name}`, type: 'info'});

    switch(e.type) {
        case 'damage':
            if (target.blocked) {
                target.blocked = false;
                log.push({msg: '  Blocked!', type: 'heal'});
            } else {
                target.hp -= e.amount;
                log.push({msg: `  ${e.amount} damage!`, type: 'damage'});
            }
            break;
        case 'pierce':
            target.hp -= e.amount;
            log.push({msg: `  ${e.amount} piercing damage!`, type: 'damage'});
            break;
        case 'block':
            owner.blocked = true;
            log.push({msg: '  Blocking next attack', type: 'heal'});
            break;
        case 'heal':
            owner.hp = Math.min(owner.maxHp, owner.hp + e.amount);
            log.push({msg: `  Healed ${e.amount}`, type: 'heal'});
            break;
        case 'self_damage':
            owner.hp -= e.amount;
            log.push({msg: `  Self damage ${e.amount}`, type: 'damage'});
            break;
        case 'drain':
            if (target.blocked) {
                target.blocked = false;
                log.push({msg: '  Blocked!', type: 'heal'});
            } else {
                target.hp -= e.damage;
                owner.hp = Math.min(owner.maxHp, owner.hp + e.heal);
                log.push({msg: `  Drained ${e.damage}, healed ${e.heal}`, type: 'special'});
            }
            break;
    }

    return log;
}

// Process next round (called automatically)
function processRound(match) {
    if (match.matchOver) return;

    match.revealIndex++;
    const idx = match.revealIndex;

    // Check if we need tiebreaker
    if (idx >= match.players[match.playerOrder[0]].cards.length) {
        const p1 = match.players[match.playerOrder[0]];
        const p2 = match.players[match.playerOrder[1]];

        if (p1.hp === p2.hp && p1.hp > 0) {
            // Tie! Deal extra cards
            match.combatLog.push({msg: '=== TIE! Extra card! ===', type: 'special'});

            const card1 = {...weightedPick(match.rng), instanceId: `p1_${p1.cards.length}`};
            const card2 = {...weightedPick(match.rng), instanceId: `p2_${p2.cards.length}`};
            p1.cards.push(card1);
            p2.cards.push(card2);

            // Resolve tiebreaker cards
            match.combatLog.push(...resolveCard(card1, p1, p2, match));
            match.combatLog.push(...resolveCard(card2, p2, p1, match));

            broadcastMatchState(match);

            // Check if still tied
            if (p1.hp === p2.hp && p1.hp > 0) {
                // Still tied, schedule another tiebreaker
                match.autoDrawTimer = setTimeout(() => processRound(match), CARD_REVEAL_DELAY);
            } else {
                endMatch(match);
            }
            return;
        }

        endMatch(match);
        return;
    }

    const p1 = match.players[match.playerOrder[0]];
    const p2 = match.players[match.playerOrder[1]];

    match.combatLog.push({msg: `--- Round ${idx + 1} ---`, type: 'info'});

    // Player 1's card
    const card1 = p1.cards[idx];
    match.combatLog.push(...resolveCard(card1, p1, p2, match));

    if (p2.hp <= 0) {
        broadcastMatchState(match);
        endMatch(match);
        return;
    }

    // Player 2's card
    const card2 = p2.cards[idx];
    match.combatLog.push(...resolveCard(card2, p2, p1, match));

    broadcastMatchState(match);

    if (p1.hp <= 0) {
        endMatch(match);
        return;
    }

    // Schedule next round automatically
    match.autoDrawTimer = setTimeout(() => processRound(match), CARD_REVEAL_DELAY);
}

// Start auto-draw for a match
function startAutoDraw(match) {
    // Initial delay before first card
    match.autoDrawTimer = setTimeout(() => processRound(match), 1500);
}

function endMatch(match) {
    if (match.autoDrawTimer) {
        clearTimeout(match.autoDrawTimer);
    }

    match.matchOver = true;
    const p1 = match.players[match.playerOrder[0]];
    const p2 = match.players[match.playerOrder[1]];

    if (p1.hp > p2.hp) {
        match.winner = p1.id;
        match.combatLog.push({msg: `=== ${p1.name} WINS! ===`, type: 'victory'});
    } else if (p2.hp > p1.hp) {
        match.winner = p2.id;
        match.combatLog.push({msg: `=== ${p2.name} WINS! ===`, type: 'victory'});
    } else {
        match.combatLog.push({msg: '=== DRAW! ===', type: 'info'});
    }

    broadcastMatchState(match);
}

function broadcastMatchState(match) {
    const p1Id = match.playerOrder[0];
    const p2Id = match.playerOrder[1];

    io.to(p1Id).emit('matchUpdate', {
        match: sanitizeMatch(match, p1Id),
        yourId: p1Id
    });
    io.to(p2Id).emit('matchUpdate', {
        match: sanitizeMatch(match, p2Id),
        yourId: p2Id
    });
}

function sanitizeMatch(match, forPlayerId) {
    const sanitized = JSON.parse(JSON.stringify(match));
    delete sanitized.rng;
    delete sanitized.autoDrawTimer;

    for (const playerId of match.playerOrder) {
        if (playerId !== forPlayerId) {
            sanitized.players[playerId].cards = sanitized.players[playerId].cards.map((card, i) => {
                if (i > match.revealIndex) {
                    return { hidden: true, instanceId: card.instanceId };
                }
                return card;
            });
        }
    }

    return sanitized;
}

// Try to match players in queue
function tryMatchmaking(stake) {
    const queue = matchmakingQueues.get(stake) || [];
    if (queue.length >= 2) {
        const p1Id = queue.shift();
        const p2Id = queue.shift();
        matchmakingQueues.set(stake, queue);

        const p1 = players.get(p1Id);
        const p2 = players.get(p2Id);

        if (!p1 || !p2) {
            // One player disconnected, put the other back
            if (p1) queue.unshift(p1Id);
            if (p2) queue.unshift(p2Id);
            matchmakingQueues.set(stake, queue);
            return;
        }

        // Create match
        const match = createMatch(p1, p2, stake);
        matches.set(match.id, match);

        p1.currentMatch = match.id;
        p2.currentMatch = match.id;
        p1.inQueue = false;
        p2.inQueue = false;

        console.log(`Match found! ${p1.name} vs ${p2.name} at $${stake}`);

        // Notify both players
        io.to(p1Id).emit('matchFound', {
            matchId: match.id,
            opponent: { name: p2.name, avatar: p2.avatar },
            stake
        });
        io.to(p2Id).emit('matchFound', {
            matchId: match.id,
            opponent: { name: p1.name, avatar: p1.avatar },
            stake
        });

        // Start the match after a brief delay
        setTimeout(() => {
            io.to(p1Id).emit('matchStart', {
                matchId: match.id,
                players: [p1, p2].map(p => ({ id: p.id, name: p.name, avatar: p.avatar })),
                stake
            });
            io.to(p2Id).emit('matchStart', {
                matchId: match.id,
                players: [p1, p2].map(p => ({ id: p.id, name: p.name, avatar: p.avatar })),
                stake
            });

            // Send initial state but wait for ready
            setTimeout(() => {
                broadcastMatchState(match);
                readyPlayers.set(match.id, new Set());
                // Don't auto-start - wait for both players to click Ready
            }, 500);
        }, 1000);
    }
}

// Player ready handler
function handlePlayerReady(matchId, playerId) {
    const match = matches.get(matchId);
    if (!match || match.matchOver) return;

    if (!readyPlayers.has(matchId)) {
        readyPlayers.set(matchId, new Set());
    }

    const ready = readyPlayers.get(matchId);
    ready.add(playerId);

    // Notify both players of ready state
    match.playerOrder.forEach(pId => {
        io.to(pId).emit('readyUpdate', {
            readyCount: ready.size,
            youReady: ready.has(pId)
        });
    });

    console.log(`Player ${playerId} ready. ${ready.size}/2 ready for match ${matchId}`);

    // Both players ready - start the match!
    if (ready.size === 2) {
        console.log('Both players ready! Starting match...');
        readyPlayers.delete(matchId);

        match.playerOrder.forEach(pId => {
            io.to(pId).emit('matchBegin');
        });

        setTimeout(() => {
            startAutoDraw(match);
        }, 500);
    }
}

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    socket.on('register', (data) => {
        players.set(socket.id, {
            id: socket.id,
            name: data.name || 'Guest',
            avatar: data.avatar || 'rabbit',
            bankroll: data.bankroll || 10,
            inQueue: false,
            currentMatch: null
        });
        socket.emit('registered', { playerId: socket.id });
        broadcastLobbyList();
        console.log(`Registered: ${data.name || 'Guest'}`);
    });

    // Create a lobby
    socket.on('createLobby', (data) => {
        const player = players.get(socket.id);
        if (!player) return;

        const code = generateLobbyCode();
        const stake = data.stake || 1;
        const lobby = {
            code,
            host: player,
            stake,
            players: [player],
            created: Date.now()
        };

        lobbies.set(code, lobby);
        socket.join(`lobby_${code}`);

        socket.emit('lobbyCreated', { code, lobby: { stake } });
        broadcastLobbyList();
        console.log(`Lobby created: ${code} by ${player.name} ($${stake})`);
    });

    // Join a lobby
    socket.on('joinLobby', (data) => {
        const player = players.get(socket.id);
        const lobby = lobbies.get(data.code.toUpperCase());

        if (!player || !lobby) {
            socket.emit('error', { message: 'Lobby not found' });
            return;
        }

        if (lobby.players.length >= 2) {
            socket.emit('error', { message: 'Lobby is full' });
            return;
        }

        lobby.players.push(player);
        socket.join(`lobby_${lobby.code}`);

        io.to(`lobby_${lobby.code}`).emit('lobbyUpdate', {
            code: lobby.code,
            players: lobby.players.map(p => ({ id: p.id, name: p.name, avatar: p.avatar })),
            stake: lobby.stake
        });

        console.log(`${player.name} joined lobby ${lobby.code}`);

        // Start match if 2 players
        if (lobby.players.length === 2) {
            const match = createMatch(lobby.players[0], lobby.players[1], lobby.stake);
            matches.set(match.id, match);

            lobby.players.forEach(p => {
                const pl = players.get(p.id);
                if (pl) pl.currentMatch = match.id;
            });

            io.to(`lobby_${lobby.code}`).emit('matchStart', {
                matchId: match.id,
                players: lobby.players.map(p => ({ id: p.id, name: p.name, avatar: p.avatar })),
                stake: lobby.stake
            });

            setTimeout(() => {
                broadcastMatchState(match);
                readyPlayers.set(match.id, new Set());
                // Wait for both players to click Ready
            }, 500);

            lobbies.delete(lobby.code);
            broadcastLobbyList();
            console.log(`Match started from lobby ${lobby.code}`);
        }
    });

    // Leave lobby
    socket.on('leaveLobby', (data) => {
        const lobby = lobbies.get(data.code);
        if (lobby) {
            lobby.players = lobby.players.filter(p => p.id !== socket.id);
            socket.leave(`lobby_${data.code}`);

            if (lobby.players.length === 0) {
                lobbies.delete(data.code);
            } else {
                io.to(`lobby_${data.code}`).emit('lobbyUpdate', {
                    code: lobby.code,
                    players: lobby.players.map(p => ({ id: p.id, name: p.name, avatar: p.avatar })),
                    stake: lobby.stake
                });
            }
            broadcastLobbyList();
        }
    });

    // Find Match - join matchmaking queue
    socket.on('findMatch', (data) => {
        const player = players.get(socket.id);
        if (!player) return;

        const stake = data.stake || 1;

        // Remove from any existing queue
        matchmakingQueues.forEach((queue, s) => {
            const idx = queue.indexOf(socket.id);
            if (idx !== -1) queue.splice(idx, 1);
        });

        // Add to queue for this stake
        if (!matchmakingQueues.has(stake)) {
            matchmakingQueues.set(stake, []);
        }
        matchmakingQueues.get(stake).push(socket.id);
        player.inQueue = true;

        socket.emit('searching', { stake });
        console.log(`${player.name} searching for $${stake} match...`);

        // Try to find a match
        tryMatchmaking(stake);
    });

    // Cancel matchmaking
    socket.on('cancelSearch', () => {
        const player = players.get(socket.id);
        if (!player) return;

        matchmakingQueues.forEach((queue) => {
            const idx = queue.indexOf(socket.id);
            if (idx !== -1) queue.splice(idx, 1);
        });
        player.inQueue = false;

        socket.emit('searchCancelled');
        console.log(`${player.name} cancelled search`);
    });

    // Player ready
    socket.on('playerReady', () => {
        const player = players.get(socket.id);
        if (!player || !player.currentMatch) return;

        handlePlayerReady(player.currentMatch, socket.id);
    });

    // Play again request
    socket.on('playAgain', () => {
        const player = players.get(socket.id);
        if (!player || !player.currentMatch) return;

        const oldMatch = matches.get(player.currentMatch);
        if (!oldMatch || !oldMatch.matchOver) return;

        const matchId = oldMatch.id;

        // Initialize waiting list for this match
        if (!rematchWaiting.has(matchId)) {
            rematchWaiting.set(matchId, []);
        }

        const waiting = rematchWaiting.get(matchId);

        // Check if already waiting
        if (waiting.includes(socket.id)) return;

        waiting.push(socket.id);
        socket.emit('waitingForOpponent');
        console.log(`${player.name} wants rematch, waiting...`);

        // Check if both players want rematch
        const opponentId = oldMatch.playerOrder.find(id => id !== socket.id);
        if (waiting.includes(opponentId)) {
            // Both ready! Create new match
            const p1 = players.get(oldMatch.playerOrder[0]);
            const p2 = players.get(oldMatch.playerOrder[1]);

            if (!p1 || !p2) {
                socket.emit('opponentDisconnected');
                return;
            }

            const newMatch = createMatch(p1, p2, oldMatch.stake);
            matches.set(newMatch.id, newMatch);

            p1.currentMatch = newMatch.id;
            p2.currentMatch = newMatch.id;

            // Clean up
            rematchWaiting.delete(matchId);
            matches.delete(matchId);

            console.log(`Rematch starting: ${p1.name} vs ${p2.name}`);

            // Notify both players
            io.to(p1.id).emit('matchStart', {
                matchId: newMatch.id,
                players: [p1, p2].map(p => ({ id: p.id, name: p.name, avatar: p.avatar })),
                stake: newMatch.stake
            });
            io.to(p2.id).emit('matchStart', {
                matchId: newMatch.id,
                players: [p1, p2].map(p => ({ id: p.id, name: p.name, avatar: p.avatar })),
                stake: newMatch.stake
            });

            setTimeout(() => {
                broadcastMatchState(newMatch);
                readyPlayers.set(newMatch.id, new Set());
                // Wait for both players to click Ready again
            }, 500);
        }
    });

    // Return to menu (cancel rematch waiting)
    socket.on('returnToMenu', () => {
        const player = players.get(socket.id);
        if (!player) return;

        // Remove from rematch waiting
        rematchWaiting.forEach((waiting, matchId) => {
            const idx = waiting.indexOf(socket.id);
            if (idx !== -1) {
                waiting.splice(idx, 1);
                // Notify opponent that we left
                const match = matches.get(matchId);
                if (match) {
                    const opponentId = match.playerOrder.find(id => id !== socket.id);
                    if (opponentId && waiting.includes(opponentId)) {
                        io.to(opponentId).emit('opponentLeft');
                    }
                }
            }
        });

        player.currentMatch = null;
    });

    // Disconnect
    socket.on('disconnect', () => {
        const player = players.get(socket.id);
        console.log(`Player disconnected: ${socket.id} (${player?.name || 'unknown'})`);

        // Remove from matchmaking queues
        matchmakingQueues.forEach((queue) => {
            const idx = queue.indexOf(socket.id);
            if (idx !== -1) queue.splice(idx, 1);
        });

        // Remove from rematch waiting
        rematchWaiting.forEach((waiting, matchId) => {
            const idx = waiting.indexOf(socket.id);
            if (idx !== -1) waiting.splice(idx, 1);
        });

        // Remove from lobbies
        lobbies.forEach((lobby, code) => {
            const idx = lobby.players.findIndex(p => p.id === socket.id);
            if (idx !== -1) {
                lobby.players.splice(idx, 1);
                if (lobby.players.length === 0) {
                    lobbies.delete(code);
                } else {
                    io.to(`lobby_${code}`).emit('lobbyUpdate', {
                        code: lobby.code,
                        players: lobby.players.map(p => ({ id: p.id, name: p.name, avatar: p.avatar })),
                        stake: lobby.stake
                    });
                }
            }
        });
        broadcastLobbyList();

        // Notify match opponent
        if (player?.currentMatch) {
            const match = matches.get(player.currentMatch);
            if (match) {
                if (match.autoDrawTimer) {
                    clearTimeout(match.autoDrawTimer);
                }
                const opponentId = match.playerOrder.find(id => id !== socket.id);
                if (opponentId) {
                    io.to(opponentId).emit('opponentDisconnected');
                }
            }
        }

        players.delete(socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🎮 STACK OR BUST Server running!`);
    console.log(`   Local:   http://localhost:${PORT}`);
    console.log(`   Network: http://192.168.1.8:${PORT}`);
    console.log(`\n   Share the Network URL with your friend!\n`);
});
