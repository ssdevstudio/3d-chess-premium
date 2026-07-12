/**
 * ============================================================
 * 3D Chess Premium - Multiplayer Server
 * ============================================================
 * 
 * Authoritative game server using Socket.IO.
 * Server validates ALL moves. Client is display-only.
 * 
 * Architecture:
 *   - Modular room management
 *   - URL-based invite links with auto-join
 *   - Reconnect with full state restoration
 *   - Automatic room lifecycle cleanup
 *   - Scalable event system for future features
 * 
 * Environment Variables:
 *   PORT              - Server port (default: 3000)
 *   HOST              - Public host for invite links (default: auto-detect)
 *   RECONNECT_TIMEOUT - Ms to keep room alive after disconnect (default: 120000)
 *   ROOM_MAX_AGE      - Ms before empty room is cleaned (default: 7200000)
 *   ROOM_CLEANUP_INT  - Ms between cleanup sweeps (default: 30000)
 * ============================================================
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const Chess = require('chess.js').Chess;
const crypto = require('crypto');

// ============================================================
// CONFIGURATION
// ============================================================
const CONFIG = {
    port: parseInt(process.env.PORT, 10) || 3000,
    host: process.env.HOST || null, // null = auto-detect from request
    reconnectTimeout: parseInt(process.env.RECONNECT_TIMEOUT, 10) || 2 * 60 * 1000,
    roomMaxAge: parseInt(process.env.ROOM_MAX_AGE, 10) || 2 * 60 * 60 * 1000,
    cleanupInterval: parseInt(process.env.ROOM_CLEANUP_INT, 10) || 30 * 1000,
    roomCodeLength: 6,
    roomCodeChars: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', // no ambiguous I/O/0/1
};

// ============================================================
// EXPRESS SETUP
// ============================================================
const app = express();
app.use(cors());
app.use(express.json());

// Serve the frontend from the parent directory
app.use(express.static(__dirname + '/..'));

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    pingTimeout: 60000,
    pingInterval: 25000,
});

// ============================================================
// ROOM MANAGER (Module)
// ============================================================
const RoomManager = {
    /** @type {Map<string, RoomData>} */
    rooms: new Map(),

    /**
     * Generate a unique room code
     */
    generateCode() {
        const chars = CONFIG.roomCodeChars;
        let code;
        do {
            code = '';
            for (let i = 0; i < CONFIG.roomCodeLength; i++) {
                code += chars.charAt(Math.floor(Math.random() * chars.length));
            }
        } while (this.rooms.has(code));
        return code;
    },

    /**
     * Create a new room. Returns room data.
     */
    create() {
        const code = this.generateCode();
        const room = {
            code,
            players: { white: null, black: null },
            // Persistent player IDs for reconnect matching
            playerIds: { white: null, black: null },
            chess: new Chess(),
            moveHistory: [],
            createdAt: Date.now(),
            lastActivity: Date.now(),
            gameOver: false,
            disconnected: { color: null, timeout: null },
            // Metadata for future features
            meta: {
                isPrivate: false,
                hasPassword: false,
                spectators: [],
            },
        };
        this.rooms.set(code, room);
        log('room', `Created: ${code}`);
        return room;
    },

    /**
     * Get a room by code (case-insensitive)
     */
    get(code) {
        if (!code || typeof code !== 'string') return null;
        return this.rooms.get(code.toUpperCase().trim()) || null;
    },

    /**
     * Delete a room and notify all connected sockets
     */
    destroy(code) {
        const room = this.rooms.get(code);
        if (!room) return;

        // Cancel pending disconnect timeout
        if (room.disconnected.timeout) {
            clearTimeout(room.disconnected.timeout);
        }

        // Notify connected players
        if (room.players.white) {
            io.to(room.players.white).emit('roomClosed', { reason: 'Room closed', code });
        }
        if (room.players.black) {
            io.to(room.players.black).emit('roomClosed', { reason: 'Room closed', code });
        }

        this.rooms.delete(code);
        log('room', `Destroyed: ${code}`);
    },

    /**
     * Get the opponent's socket ID for a given socket
     */
    getOpponent(code, socketId) {
        const room = this.rooms.get(code);
        if (!room) return null;
        if (room.players.white === socketId) return room.players.black;
        if (room.players.black === socketId) return room.players.white;
        return null;
    },

    /**
     * Determine which color a socket is playing
     */
    getColor(code, socketId) {
        const room = this.rooms.get(code);
        if (!room) return null;
        if (room.players.white === socketId) return 'w';
        if (room.players.black === socketId) return 'b';
        return null;
    },

    /**
     * Build a full state object for sending to clients
     */
    buildState(room) {
        return {
            code: room.code,
            fen: room.chess.fen(),
            turn: room.chess.turn(),
            moveHistory: room.moveHistory,
            isCheck: room.chess.in_check(),
            isCheckmate: room.chess.in_checkmate(),
            isStalemate: room.chess.in_stalemate(),
            isDraw: room.chess.in_draw(),
            isGameOver: room.chess.game_over,
            gameOver: room.gameOver,
        };
    },

    /**
     * Send full game state to a socket
     */
    sendState(socketId, room) {
        io.to(socketId).emit('gameState', this.buildState(room));
    },

    /**
     * Touch activity timestamp
     */
    touch(code) {
        const room = this.rooms.get(code);
        if (room) room.lastActivity = Date.now();
    },

    /**
     * Sweep and destroy stale rooms
     */
    cleanup() {
        const now = Date.now();
        for (const [code, room] of this.rooms) {
            // Destroy rooms older than max age
            if (now - room.createdAt > CONFIG.roomMaxAge) {
                log('cleanup', `Stale room (age): ${code}`);
                this.destroy(code);
                continue;
            }
            // Destroy rooms empty for more than 5 minutes (and game not in progress or over)
            const hasPlayers = !!(room.players.white || room.players.black);
            if (!hasPlayers && now - room.lastActivity > 5 * 60 * 1000) {
                log('cleanup', `Stale room (empty): ${code}`);
                this.destroy(code);
            }
        }
    },
};

// ============================================================
// LOGGER
// ============================================================
function log(category, msg) {
    const ts = new Date().toISOString().substring(11, 19);
    console.log(`[${ts}] [${category}] ${msg}`);
}

// ============================================================
// HTTP API ENDPOINTS
// ============================================================

/**
 * Health check
 */
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        rooms: RoomManager.rooms.size,
        uptime: Math.floor(process.uptime()),
    });
});

/**
 * Validate if a room exists and is joinable.
 * Used by the client before attempting to join via URL.
 * GET /api/room/:code
 */
app.get('/api/room/:code', (req, res) => {
    const code = (req.params.code || '').toUpperCase().trim();
    const room = RoomManager.get(code);

    if (!room) {
        return res.status(404).json({
            exists: false,
            error: 'Room not found',
        });
    }

    const hasWhite = !!room.players.white;
    const hasBlack = !!room.players.black;
    const full = hasWhite && hasBlack;
    const joinable = !full && !room.gameOver;

    res.json({
        exists: true,
        code: room.code,
        joinable,
        full,
        gameOver: room.gameOver,
        hasWhite,
        hasBlack,
    });
});

/**
 * List all rooms (debug/admin)
 */
app.get('/api/rooms', (req, res) => {
    const list = [];
    for (const [code, room] of RoomManager.rooms) {
        list.push({
            code,
            hasWhite: !!room.players.white,
            hasBlack: !!room.players.black,
            turn: room.chess.turn(),
            moves: room.moveHistory.length,
            gameOver: room.gameOver,
            age: Math.floor((Date.now() - room.createdAt) / 1000),
        });
    }
    res.json({ rooms: list, count: list.length });
});

// ============================================================
// SOCKET.IO CONNECTION HANDLER
// ============================================================
io.on('connection', (socket) => {
    log('connect', socket.id);

    /** @type {string|null} */
    let currentRoom = null;

    // --------------------------------------------------------
    // CREATE ROOM
    // --------------------------------------------------------
    socket.on('createRoom', (callback) => {
        if (typeof callback !== 'function') return;

        const room = RoomManager.create();
        room.players.white = socket.id;
        room.playerIds.white = socket.id;
        currentRoom = room.code;

        socket.join(room.code);

        callback({
            success: true,
            code: room.code,
            color: 'w',
            inviteLink: buildInviteLink(room.code, socket.request),
        });

        log('create', `${room.code} → White: ${socket.id}`);
    });

    // --------------------------------------------------------
    // JOIN ROOM
    // --------------------------------------------------------
    socket.on('joinRoom', ({ code }, callback) => {
        if (typeof callback !== 'function') return;

        if (!code || typeof code !== 'string') {
            return callback({ success: false, error: 'Invalid room code' });
        }

        code = code.toUpperCase().trim();
        const room = RoomManager.get(code);

        if (!room) {
            return callback({ success: false, error: 'Room not found', code });
        }

        if (room.players.white && room.players.black) {
            return callback({ success: false, error: 'Room is full', code });
        }

        if (room.gameOver) {
            return callback({ success: false, error: 'Game is already over', code });
        }

        // Determine which color to assign
        let color;
        if (!room.players.white) {
            color = 'w';
            room.players.white = socket.id;
            room.playerIds.white = socket.id;
        } else {
            color = 'b';
            room.players.black = socket.id;
            room.playerIds.black = socket.id;
        }

        // Cancel disconnect timeout if the reconnecting player's slot was held
        if (room.disconnected.color === color && room.disconnected.timeout) {
            clearTimeout(room.disconnected.timeout);
            room.disconnected = { color: null, timeout: null };
            log('reconnect', `${code} → ${color === 'w' ? 'White' : 'Black'} reconnected`);
        }

        currentRoom = code;
        RoomManager.touch(code);
        socket.join(code);

        callback({
            success: true,
            code: room.code,
            color,
            inviteLink: buildInviteLink(room.code, socket.request),
        });

        // If both players are now present, start the game
        if (room.players.white && room.players.black) {
            RoomManager.sendState(room.players.white, room);
            RoomManager.sendState(room.players.black, room);
            io.to(room.code).emit('gameStart', {
                message: 'Game started! White moves first.',
            });
            log('start', `${code}`);
        } else {
            // Just one player — notify waiting
            if (room.players.white) {
                io.to(room.players.white).emit('waiting', {
                    message: 'Waiting for opponent...',
                    code: room.code,
                });
            }
        }

        log('join', `${code} → ${color === 'w' ? 'White' : 'Black'}: ${socket.id}`);
    });

    // --------------------------------------------------------
    // RECONNECT (rejoin using persistent identity)
    // --------------------------------------------------------
    socket.on('reconnectToRoom', ({ code, asColor }, callback) => {
        if (typeof callback !== 'function') return;

        if (!code || typeof code !== 'string') {
            return callback({ success: false, error: 'Invalid room code' });
        }

        code = code.toUpperCase().trim();
        const room = RoomManager.get(code);

        if (!room) {
            return callback({ success: false, error: 'Room not found' });
        }

        if (!room.disconnected.color) {
            return callback({ success: false, error: 'No disconnected player to reconnect' });
        }

        const color = room.disconnected.color;

        // Reassign socket
        if (color === 'w') {
            room.players.white = socket.id;
        } else {
            room.players.black = socket.id;
        }

        // Cancel timeout
        if (room.disconnected.timeout) {
            clearTimeout(room.disconnected.timeout);
        }
        room.disconnected = { color: null, timeout: null };

        currentRoom = code;
        RoomManager.touch(code);
        socket.join(code);

        // Send full state
        callback({
            success: true,
            code: room.code,
            color,
        });

        RoomManager.sendState(socket.id, room);

        // Notify opponent
        const opponentId = RoomManager.getOpponent(code, socket.id);
        if (opponentId) {
            io.to(opponentId).emit('playerReconnected', {
                color,
                message: `${color === 'w' ? 'White' : 'Black'} reconnected!`,
            });
        }

        log('reconnect', `${code} → ${color === 'w' ? 'White' : 'Black'} restored`);
    });

    // --------------------------------------------------------
    // MAKE MOVE
    // --------------------------------------------------------
    socket.on('move', ({ from, to, promotion }, callback) => {
        if (typeof callback !== 'function') return;

        if (!currentRoom) {
            return callback({ success: false, error: 'Not in a room' });
        }

        const room = RoomManager.get(currentRoom);
        if (!room) {
            return callback({ success: false, error: 'Room not found' });
        }

        if (room.gameOver) {
            return callback({ success: false, error: 'Game is over' });
        }

        const playerColor = RoomManager.getColor(currentRoom, socket.id);
        if (!playerColor) {
            return callback({ success: false, error: 'You are not a player' });
        }

        if (playerColor !== room.chess.turn()) {
            return callback({ success: false, error: 'Not your turn' });
        }

        // Validate move on server
        const moveConfig = { from, to };
        if (promotion) moveConfig.promotion = promotion;

        const move = room.chess.move(moveConfig);
        if (!move) {
            return callback({ success: false, error: 'Illegal move' });
        }

        // Record
        room.moveHistory.push({
            san: move.san,
            from: move.from,
            to: move.to,
            captured: move.captured || null,
            promotion: move.promotion || null,
            color: move.color,
            flags: move.flags,
        });

        RoomManager.touch(currentRoom);

        log('move', `${currentRoom}: ${move.san} (${playerColor})`);

        // Build state update
        const gameState = {
            fen: room.chess.fen(),
            turn: room.chess.turn(),
            lastMove: { from: move.from, to: move.to },
            san: move.san,
            captured: move.captured || null,
            promotion: move.promotion || null,
            moveColor: move.color,
            isCheck: room.chess.in_check(),
            isCheckmate: room.chess.in_checkmate(),
            isStalemate: room.chess.in_stalemate(),
            isDraw: room.chess.in_draw(),
            isGameOver: room.chess.game_over,
            moveNumber: Math.floor(room.moveHistory.length / 2) + 1,
        };

        callback({ success: true, gameState });
        io.to(room.code).emit('moveAccepted', gameState);

        // Game over?
        if (room.chess.in_checkmate() || room.chess.in_stalemate() || room.chess.in_draw()) {
            room.gameOver = true;

            let result = 'draw';
            let winner = null;
            let reason = 'Game drawn';

            if (room.chess.in_checkmate()) {
                winner = room.chess.turn() === 'w' ? 'b' : 'w';
                result = winner === 'w' ? 'white' : 'black';
                reason = 'Checkmate';
            } else if (room.chess.in_stalemate()) {
                reason = 'Stalemate';
            }

            io.to(room.code).emit('gameOver', { result, winner, reason });
            log('gameover', `${currentRoom}: ${reason} winner=${winner || 'none'}`);
        }
    });

    // --------------------------------------------------------
    // REQUEST GAME STATE (sync / reconnect)
    // --------------------------------------------------------
    socket.on('requestGameState', (callback) => {
        if (typeof callback !== 'function') return;

        if (!currentRoom) {
            return callback({ success: false, error: 'Not in a room' });
        }

        const room = RoomManager.get(currentRoom);
        if (!room) {
            return callback({ success: false, error: 'Room not found' });
        }

        callback({ success: true, state: RoomManager.buildState(room) });
    });

    // --------------------------------------------------------
    // DISCONNECT
    // --------------------------------------------------------
    socket.on('disconnect', () => {
        log('disconnect', socket.id);

        if (!currentRoom) return;

        const room = RoomManager.get(currentRoom);
        if (!room) { currentRoom = null; return; }

        const color = RoomManager.getColor(currentRoom, socket.id);
        if (!color) { currentRoom = null; return; }

        // Release the player slot but keep the color assignment for reconnect
        if (color === 'w') {
            room.players.white = null;
        } else {
            room.players.black = null;
        }

        RoomManager.touch(currentRoom);

        // Notify opponent
        const opponentId = RoomManager.getOpponent(currentRoom, socket.id);
        if (opponentId) {
            io.to(opponentId).emit('playerDisconnected', {
                color,
                message: `${color === 'w' ? 'White' : 'Black'} disconnected. Waiting for reconnect...`,
            });

            // Start reconnect countdown
            room.disconnected = {
                color,
                timeout: setTimeout(() => {
                    log('timeout', `${currentRoom} → ${color} timed out`);
                    RoomManager.destroy(currentRoom);
                }, CONFIG.reconnectTimeout),
            };
        } else {
            // No opponent connected — destroy if game not in progress
            if (!room.gameOver && room.moveHistory.length === 0) {
                RoomManager.destroy(currentRoom);
            } else {
                // Keep alive for reconnect
                room.disconnected = {
                    color,
                    timeout: setTimeout(() => {
                        RoomManager.destroy(currentRoom);
                    }, CONFIG.reconnectTimeout),
                };
            }
        }

        currentRoom = null;
    });
});

// ============================================================
// HELPERS
// ============================================================

/**
 * Build a full invite link for a room
 */
function buildInviteLink(code, request) {
    // If HOST is configured, use it
    if (CONFIG.host) {
        return `${CONFIG.host}/chess.html?room=${code}`;
    }

    // Auto-detect from request
    if (request && request.headers) {
        const proto = request.headers['x-forwarded-proto'] || 'http';
        const host = request.headers['x-forwarded-host'] || request.headers.host || `localhost:${CONFIG.port}`;
        return `${proto}://${host}/chess.html?room=${code}`;
    }

    return `http://localhost:${CONFIG.port}/chess.html?room=${code}`;
}

// ============================================================
// PERIODIC CLEANUP
// ============================================================
setInterval(() => RoomManager.cleanup(), CONFIG.cleanupInterval);

// ============================================================
// START SERVER
// ============================================================
server.listen(CONFIG.port, () => {
    console.log('');
    console.log('  ╔══════════════════════════════════════════╗');
    console.log('  ║    3D Chess Premium - Multiplayer        ║');
    console.log('  ╠══════════════════════════════════════════╣');
    console.log(`  ║  Port:           ${String(CONFIG.port).padEnd(22)}║`);
    console.log(`  ║  Reconnect:      ${String(CONFIG.reconnectTimeout / 1000 + 's').padEnd(22)}║`);
    console.log(`  ║  Room Max Age:   ${String(CONFIG.roomMaxAge / 1000 / 60 + 'min').padEnd(22)}║`);
    console.log('  ║  Status:         Ready                  ║');
    console.log('  ╚══════════════════════════════════════════╝');
    console.log('');
});

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================
function shutdown(signal) {
    log('shutdown', `${signal} received`);
    io.emit('roomClosed', { reason: 'Server shutting down' });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000); // Force after 5s
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
