// Settings and limits in one place. Change a number here and it applies everywhere.
const path = require('path');

const ROOT = path.join(__dirname, '..'); // the project folder (public/ and data/ live here)

const PORT = process.env.PORT || 3000;
const COUNTDOWN_MS = Number(process.env.COUNTDOWN_MS) || 3000; // wait before the race starts (env override is for tests)
const RACE_MS = Number(process.env.RACE_MS) || 60000;           // race length
const MAX_PLAYERS = 5;
const GRACE_MS = 120000;   // how long a disconnected player's seat is held for them
const MAX_CPS = 25;        // fastest believable typing speed (characters per second); anything beyond is rejected and flagged
const FLAG_WPM = 250;      // an average speed no human sustains: flagged (needs FLAG_MIN_LETTERS so a short burst can't trip it)
const FLAG_MIN_LETTERS = 40;
const MAX_JUMP = 20;      // most letters one message may add: phone keyboards insert a whole word at once (swipe typing, suggestions), a pasted passage is far longer
const MAX_WRONG = 10;     // wrong letters a player may leave in the box before they have to backspace
const RESERVE_MS = Number(process.env.RESERVE_MS) || 60000;         // how long a room made through the REST API waits for its host to connect
const MATCH_JOIN_MS = Number(process.env.MATCH_JOIN_MS) || 15000;   // how long matched players have to connect to their room
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,16}$/;

module.exports = {
  ROOT, PORT, COUNTDOWN_MS, RACE_MS, MAX_PLAYERS, GRACE_MS, MAX_CPS, FLAG_WPM, FLAG_MIN_LETTERS,
  MAX_JUMP, MAX_WRONG, RESERVE_MS, MATCH_JOIN_MS, USERNAME_RE,
};
