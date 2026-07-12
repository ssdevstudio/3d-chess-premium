# 3D Chess Premium - Multiplayer

Real-time multiplayer 3D chess game. Two players can play online from different computers using room codes and shareable invite links.

## Tech Stack

- **Frontend**: HTML, CSS, JavaScript, Three.js, GSAP, Chess.js
- **Backend**: Node.js, Express, Socket.IO, Chess.js

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) (v14 or higher)
- npm

### Installation

```bash
# Navigate to server directory
cd server

# Install dependencies
npm install

# Start the server
npm start
```

The server starts on `http://localhost:3000`.

### Open the Game

Navigate to `http://localhost:3000/chess.html` in your browser.

## How to Play

### Option 1: Create Room
1. Click **Create Room**
2. Share the room code or invite link with your friend
3. Wait for them to join
4. Game starts automatically

### Option 2: Join via Link
1. Open the invite link (e.g., `http://localhost:3000/chess.html?room=ABC123`)
2. You're automatically connected and joined
3. Game starts when both players are present

### Option 3: Join via Code
1. Click **Join Room**
2. Enter the 6-character room code
3. Game starts when both players are present

## Room System

### Room Codes
- 6 characters (A-Z, 2-9, no ambiguous I/O/0/1)
- Example: `ABC123`, `XP7M4K`

### Invite Links
When a room is created, the server generates a full invite link:
```
https://your-domain.com/chess.html?room=ABC123
```

### Auto-Join from URL
Opening an invite link automatically:
1. Detects the `?room=` parameter
2. Connects to the server
3. Attempts to join the room
4. Shows "Joining Room..." animation
5. Goes directly to the game (or shows error if room not found/full)

### Share Button
- **Copy Code**: Copies just the room code
- **Copy Link**: Copies the full invite link
- **Share**: Uses the browser's native share dialog (WhatsApp, Telegram, Discord, etc.)
- **QR Code**: Auto-generated QR code for mobile scanning

### URL Handling
- Uses `history.pushState` (no page reload)
- Supports browser back/forward buttons
- Works when page is refreshed
- Works when opened from shared links

## Project Structure

```
Chess Game/
├── chess.html              # Frontend (single HTML file)
├── server/
│   ├── package.json        # Dependencies
│   ├── server.js           # Express + Socket.IO server
│   └── README.md           # This file
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `HOST` | auto-detect | Public host for invite links |
| `RECONNECT_TIMEOUT` | `120000` | Ms to keep room alive after disconnect |
| `ROOM_MAX_AGE` | `7200000` | Ms before empty room is cleaned (2h) |
| `ROOM_CLEANUP_INT` | `30000` | Ms between cleanup sweeps |

Create a `.env` file in the `server/` directory:

```
PORT=3000
HOST=https://your-app.onrender.com
```

## HTTP API

### Health Check
```
GET /health
→ { "status": "ok", "rooms": 3, "uptime": 3600 }
```

### Validate Room
```
GET /api/room/:code
→ { "exists": true, "code": "ABC123", "joinable": true, "full": false }
→ 404: { "exists": false, "error": "Room not found" }
```

### List Rooms (debug)
```
GET /api/rooms
→ { "rooms": [...], "count": 3 }
```

## Deployment

### Deploy Server to Render

1. Push this repository to GitHub
2. Go to [render.com](https://render.com) and create a new **Web Service**
3. Connect your GitHub repository
4. Configure:
   - **Root Directory**: `server`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Environment Variable**: `PORT=3000`
   - **Environment Variable**: `HOST=https://your-app.onrender.com`
5. Deploy

### Host Frontend on GitHub Pages

1. Push to GitHub
2. Go to **Settings > Pages**
3. Set source to the root branch
4. Your frontend is at `https://username.github.io/repo-name/chess.html`

### Connect Frontend to Backend

When both are deployed:
- The frontend auto-detects the server from the current origin
- Invite links use the server's public URL

## Socket.IO Events

### Client → Server

| Event | Payload | Description |
|-------|---------|-------------|
| `createRoom` | `{}` | Create a new room |
| `joinRoom` | `{ code }` | Join an existing room |
| `reconnectToRoom` | `{ code, asColor }` | Reconnect to a room after disconnect |
| `move` | `{ from, to, promotion }` | Request a move |
| `requestGameState` | `{}` | Request full game state sync |

### Server → Client

| Event | Payload | Description |
|-------|---------|-------------|
| `gameStart` | `{ message }` | Game has started |
| `gameState` | `{ fen, turn, moveHistory, ... }` | Full game state |
| `moveAccepted` | `{ fen, lastMove, san, ... }` | Move was accepted |
| `moveRejected` | `{ error }` | Move was rejected |
| `playerJoined` | `{ color, message }` | Opponent joined |
| `waiting` | `{ message, code }` | Waiting for opponent |
| `playerDisconnected` | `{ color, message }` | Opponent disconnected |
| `playerReconnected` | `{ color, message }` | Opponent reconnected |
| `gameOver` | `{ result, winner, reason }` | Game ended |
| `roomClosed` | `{ reason, code }` | Room was deleted |

## Room Lifecycle

1. **Created** when Player 1 clicks "Create Room"
2. **Waiting** for Player 2 to join
3. **Active** when both players are connected
4. **Disconnect** if a player leaves (2-minute reconnect window)
5. **Destroyed** when:
   - Both players leave
   - Reconnect timeout expires
   - Room exceeds max age (2 hours)
   - Server shuts down

## Features

- Room code based multiplayer
- Shareable invite links with QR codes
- Auto-join from URL parameters
- Server-authoritative game state
- Move validation on server
- Reconnect support (2-minute window)
- Automatic room cleanup
- Browser history API integration
- Native share dialog support
- Castling, en passant, promotion
- Check/checkmate/stalemate detection

## Future Scaling

This architecture supports adding:
- Authentication (JWT)
- User profiles
- Friends list
- Matchmaking queue
- AI opponents (Stockfish)
- Spectator mode
- In-game chat
- Voice chat
- Game history
- Leaderboards
- Tournaments
- Private/password-protected rooms
- Persistent rooms
- Mobile app / PWA
