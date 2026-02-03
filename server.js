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
const lobbies = new Map();
const players = new Map();
const matches = new Map();

// Card definitions (same as client)
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

// Generate unique lobby code
function generateLobbyCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}

// Create a new match
function createMatch(player1, player2, stake) {
    const seed = Date.now();
    const rng = createRNG(seed);

    const match = {
        id: `match_${Date.now()}`,
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
        combatLog: []
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

// Process next round
function processRound(match) {
    match.revealIndex++;
    const idx = match.revealIndex;

    if (idx >= match.players[match.playerOrder[0]].cards.length) {
        // Check for tie
        const p1 = match.players[match.playerOrder[0]];
        const p2 = match.players[match.playerOrder[1]];

        if (p1.hp === p2.hp && p1.hp > 0) {
            // Tie! Deal extra cards
            match.combatLog.push({msg: '=== TIE! Extra card! ===', type: 'special'});

            const card1 = {...weightedPick(match.rng), instanceId: `p1_${p1.cards.length}`};
            const card2 = {...weightedPick(match.rng), instanceId: `p2_${p2.cards.length}`};
            p1.cards.push(card1);
            p2.cards.push(card2);

            // Resolve tiebreaker cards immediately
            match.combatLog.push(...resolveCard(card1, p1, p2, match));
            match.combatLog.push(...resolveCard(card2, p2, p1, match));

            // Check again
            if (p1.hp !== p2.hp || p1.hp <= 0 || p2.hp <= 0) {
                endMatch(match);
            }
            return match;
        }

        endMatch(match);
        return match;
    }

    const p1 = match.players[match.playerOrder[0]];
    const p2 = match.players[match.playerOrder[1]];

    match.combatLog.push({msg: `--- Round ${idx + 1} ---`, type: 'info'});

    // Player 1's card
    const card1 = p1.cards[idx];
    match.combatLog.push(...resolveCard(card1, p1, p2, match));

    if (p2.hp <= 0) {
        endMatch(match);
        return match;
    }

    // Player 2's card
    const card2 = p2.cards[idx];
    match.combatLog.push(...resolveCard(card2, p2, p1, match));

    if (p1.hp <= 0) {
        endMatch(match);
        return match;
    }

    // Auto-end after 3 cards
    if (idx === 2) {
        // Will trigger tie check on next process
        setTimeout(() => {
            if (!match.matchOver) {
                processRound(match);
                broadcastMatchState(match);
            }
        }, 1500);
    }

    return match;
}

function endMatch(match) {
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
}

function broadcastMatchState(match) {
    const p1Id = match.playerOrder[0];
    const p2Id = match.playerOrder[1];

    // Send state to both players
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
    // Hide unrevealed cards from opponent
    const sanitized = JSON.parse(JSON.stringify(match));
    delete sanitized.rng;

    for (const playerId of match.playerOrder) {
        if (playerId !== forPlayerId) {
            // Hide unrevealed opponent cards
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

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    // Player joins with their info
    socket.on('register', (data) => {
        players.set(socket.id, {
            id: socket.id,
            name: data.name || 'Guest',
            avatar: data.avatar || 'rabbit',
            bankroll: data.bankroll || 10
        });
        socket.emit('registered', { playerId: socket.id });

        // Send lobby list
        socket.emit('lobbyList', Array.from(lobbies.values()).map(l => ({
            code: l.code,
            host: l.host.name,
            stake: l.stake,
            players: l.players.length
        })));
    });

    // Create a lobby
    socket.on('createLobby', (data) => {
        const player = players.get(socket.id);
        if (!player) return;

        const code = generateLobbyCode();
        const lobby = {
            code,
            host: player,
            stake: data.stake || 1,
            players: [player],
            created: Date.now()
        };

        lobbies.set(code, lobby);
        socket.join(`lobby_${code}`);

        socket.emit('lobbyCreated', { code, lobby });
        io.emit('lobbyList', Array.from(lobbies.values()).map(l => ({
            code: l.code,
            host: l.host.name,
            stake: l.stake,
            players: l.players.length
        })));

        console.log(`Lobby created: ${code} by ${player.name}`);
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

            // Store match reference on players
            lobby.players.forEach(p => {
                players.get(p.id).currentMatch = match.id;
            });

            io.to(`lobby_${lobby.code}`).emit('matchStart', {
                matchId: match.id,
                players: lobby.players.map(p => ({ id: p.id, name: p.name, avatar: p.avatar })),
                stake: lobby.stake
            });

            // Send initial match state
            setTimeout(() => broadcastMatchState(match), 500);

            // Remove lobby
            lobbies.delete(lobby.code);
            io.emit('lobbyList', Array.from(lobbies.values()).map(l => ({
                code: l.code,
                host: l.host.name,
                stake: l.stake,
                players: l.players.length
            })));

            console.log(`Match started: ${match.id}`);
        }
    });

    // Draw card / advance round
    socket.on('drawCard', () => {
        const player = players.get(socket.id);
        if (!player || !player.currentMatch) return;

        const match = matches.get(player.currentMatch);
        if (!match || match.matchOver) return;

        processRound(match);
        broadcastMatchState(match);
    });

    // Play again request
    socket.on('playAgain', () => {
        const player = players.get(socket.id);
        if (!player || !player.currentMatch) return;

        const oldMatch = matches.get(player.currentMatch);
        if (!oldMatch || !oldMatch.matchOver) return;

        // Create new match with same players
        const p1 = players.get(oldMatch.playerOrder[0]);
        const p2 = players.get(oldMatch.playerOrder[1]);

        if (!p1 || !p2) return;

        const newMatch = createMatch(p1, p2, oldMatch.stake);
        matches.set(newMatch.id, newMatch);

        p1.currentMatch = newMatch.id;
        p2.currentMatch = newMatch.id;

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

        setTimeout(() => broadcastMatchState(newMatch), 500);

        // Clean up old match
        matches.delete(oldMatch.id);
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

            io.emit('lobbyList', Array.from(lobbies.values()).map(l => ({
                code: l.code,
                host: l.host.name,
                stake: l.stake,
                players: l.players.length
            })));
        }
    });

    // Disconnect
    socket.on('disconnect', () => {
        const player = players.get(socket.id);
        console.log(`Player disconnected: ${socket.id} (${player?.name || 'unknown'})`);

        // Clean up lobbies
        lobbies.forEach((lobby, code) => {
            lobby.players = lobby.players.filter(p => p.id !== socket.id);
            if (lobby.players.length === 0) {
                lobbies.delete(code);
            }
        });

        // Notify match opponent
        if (player?.currentMatch) {
            const match = matches.get(player.currentMatch);
            if (match) {
                const opponentId = match.playerOrder.find(id => id !== socket.id);
                if (opponentId) {
                    io.to(opponentId).emit('opponentDisconnected');
                }
            }
        }

        players.delete(socket.id);

        io.emit('lobbyList', Array.from(lobbies.values()).map(l => ({
            code: l.code,
            host: l.host.name,
            stake: l.stake,
            players: l.players.length
        })));
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🎮 STACK OR BUST Server running!`);
    console.log(`   Local:   http://localhost:${PORT}`);
    console.log(`   Network: http://192.168.1.8:${PORT}`);
    console.log(`\n   Share the Network URL with your friend!\n`);
});
