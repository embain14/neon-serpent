# 🐍 Neon Serpent LAN

Multiplayer snake for everyone on your Wi-Fi. One browser tab hosts the game, everyone else joins from their phone, laptop, or tablet — no app stores, no accounts, no internet required. Neon grid, glowing snakes, lobby chat, sound, and touch controls.

**Zero dependencies.** The server is a single `server.js` using only Node built-ins (it even speaks RFC 6455 WebSockets itself). The client is a single `snake.html`. Delete the folder and nothing is left behind.

![genre](https://img.shields.io/badge/genre-arcade-c0f) ![deps](https://img.shields.io/badge/dependencies-0-brightgreen) ![node](https://img.shields.io/badge/node-%E2%89%A518-339933)

## Quick start

```bash
git clone https://github.com/embain14/neon-serpent.git
cd neon-serpent
node server.js
```

```
Neon Serpent LAN server ready
  Local:   http://localhost:8088
  Network: http://192.168.1.42:8088   <- share this with other players on your LAN
```

1. Open the **Network** URL on the host device → *Host a room* → share the room code.
2. Everyone else opens the same URL → type the code (or hit **Scan** to find open rooms) → *Join*.
3. Everyone taps **I'm ready**, host taps **Start match**, and slither.

Works on any device with a browser — desktop (arrows / WASD) and phones (swipe anywhere on the board).

### Run it in Docker

```bash
docker compose up -d       # or: docker run -d -p 8088:8088 -v $PWD:/app:ro node:22-alpine node /app/server.js
```

The compose file runs the stock `node:22-alpine` image against the read-only folder mount as a non-root user — nothing to build.

## How it works

The architecture is deliberately lopsided:

```
 phone ─┐                            ┌──────────────┐
 laptop ─┼── WebSocket (raw JSON) ───│   server.js   │   stateless relay +
 tablet ─┘                          │  (port 8088)  │   static file server
 host browser ── authoritative ─────└──────────────┘
 game loop (canvas, physics, scoring)
```

- **The server never runs game logic.** It hand-rolls the WebSocket handshake/frames (~150 lines), keeps rooms keyed by 4-letter codes, and forwards tagged messages (`to: "host"`, `to: "*") between room members. It also answers `/` (the game), `/rooms` (scan list) and `/ip` (LAN address) over plain HTTP.
- **The host's browser is the game engine.** It runs the authoritative tick loop — movement, collisions, food, respawns, scoring — and broadcasts a compact snapshot (`st`) to every client ~10×/second. Clients render snapshots, interpolate between them, send only inputs, and render their own HUD.
- **The host tab closes → everyone gets a polite `bye`.** No orphaned games.

Room lifecycle: host creates a code → clients join by code (or Scan) → all ready → host starts → match ends (target score or lives exhausted) → everyone drops back to the same lobby for a rematch. Leave mid-game and you land back in the lobby, not the void.

## Game features

| | |
|---|---|
| 👥 2–8 players | host-adjustable room size |
| 🎨 snake color picker | 8 neon hues, saved per device, host arbitrates collisions so no two snakes share a color |
| ⚙️ match settings | speed (Chill→Turbo), target score (10/25/50/∞), lives (1/3/5), food, obstacles, wall-wrap, sound |
| 💬 lobby + in-game chat | works both directions, host relays |
| 📱 touch support | swipe / virtual joystick, tested on phones |
| 🔊 synth audio | WebAudio bleeps, no asset files |
| 🔎 room scanner | one tap lists open rooms on the LAN |
| 🔁 rematches | same lobby, fresh game, colors and ready-state restored |
| 💀 respawn w/ i-frames | collisions cost a life, not the match |

## Files

```
server.js         zero-dep Node HTTP + WebSocket relay, static file server (~260 lines)
snake.html        the entire game: menu, lobby, engine, renderer, audio (~1,250 lines)
docker-compose.yaml  optional: run the server as a container
```

## Config

| env | default | what |
|---|---|---|
| `PORT` | `8088` | listen port — `PORT=8089 node server.js` if busy |

Client preferences (call sign, snake color) persist in browser `localStorage`, per device.

## Not on the roadmap (by design)

- **Not internet multiplayer.** No auth, no TLS, no rate limiting — this is a LAN toy. Don't port-forward it. (Want internet play? Tailscale/ZeroTier over the same URL works fine.)
- **Host is the engine.** If the host tab sleeps or lags, everyone feels it. Browsers throttle background tabs; keep the host tab visible.
- **No persistence.** Rooms exist while sockets are open. Server restart = new game.

## Development

No build step, no package.json. Edit the files, refresh the browser:

```bash
node server.js                 # dev server on :8088, reload tab to pick up edits
```

`snake.html` is one file on purpose — view source is the documentation. The WebSocket message protocol is documented in the `WS protocol` block in `server.js` (srv→cli / cli→srv shapes, host-bound vs broadcast game messages).

## License

MIT — do whatever, attribution appreciated.
