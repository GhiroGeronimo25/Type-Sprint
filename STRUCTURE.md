# Where things live

**Server** (`server.js` is only the entry point; the code is in `src/`)
| File | What it does |
|---|---|
| `src/config.js` | Settings and limits (race length, max players, anti-cheat numbers) |
| `src/core.js` | Web server, Socket.IO, database layer, shared state (`rooms`, matchmaker) |
| `src/socketAuth.js` | Login check for every socket |
| `src/rules.js` | Scoring, keystroke validation, anti-cheat |
| `src/lobby.js` | Open-rooms list and the `room:state` broadcast |
| `src/race.js` | Start, countdown, racing, payout, end of race |
| `src/players.js` | Joining, rejoining, leaving rooms |
| `src/matchmaking.js` | Quick match |
| `src/sockets.js` | Socket.IO events (`room:create`, `race:start`, ...) |
| `src/results.js` | Saved casual/practice results |
| `src/routes/*.js` | REST API: `auth`, `api` (wallet/stats/passages), `rooms`, `misc` |

Modules call each other through `src/shared.js` (a small registry), so there are no circular imports.

**Browser** (`public/js/`, loaded in this order by `index.html`)
`core` (socket) → `auth` → `ui` (helpers, tabs) → `lobby` → `home` (buttons) → `history` (stats, race history) → `wallet` → `messages` (server events) → `room` (drawing the room) → `typing` → `layout`.
All files share one scope, like the old single `app.js`. After editing, bump `?v=32` in `index.html` so browsers reload the files.
