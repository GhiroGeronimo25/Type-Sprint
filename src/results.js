// Saved casual/practice results (survive restarts)
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./config');
const { app, accounts } = require('./core');
const S = require('./shared');

// ---------- saved results (survive restarts) ----------
const DATA_DIR = path.join(ROOT, 'data');
const RESULTS_FILE = path.join(DATA_DIR, 'results.json');

let results = [];
try {
  results = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
  if (!Array.isArray(results)) results = [];
} catch (e) {
  results = [];
}

function saveResults() {
  fs.mkdir(DATA_DIR, { recursive: true }, function (err) {
    if (err) return console.error('Could not create data folder:', err.message);
    const tmp = RESULTS_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(results, null, 2), function (err) {
      if (err) return console.error('Could not save results:', err.message);
      fs.rename(tmp, RESULTS_FILE, function (err) {
        if (err) console.error('Could not save results:', err.message);
      });
    });
  });
}

function recordRace(room) {
  let anyone = false;
  const players = [];
  const entrants = room.players.filter(function (p) { return p.entered; });
  for (let i = 0; i < entrants.length; i++) {
    const p = entrants[i];
    if (p.correct > 0) anyone = true;
    players.push({
      rank: i + 1,
      coins: p.result ? p.result.payout : 0,
      name: p.name,
      wpm: p.wpm,
      accuracy: p.accuracy,
      finished: p.finished,
      progress: Math.round((p.correct / room.text.length) * 1000) / 10,
      seconds: p.finished ? Math.round((p.finishedAt - room.startAt) / 100) / 10 : null,
    });
  }
  if (!anyone) return;
  results.push({ room: room.code, ranked: room.ranked, difficulty: room.difficulty, endedAt: new Date().toISOString(), text: room.text, players: players });
  if (results.length > 500) results = results.slice(-500);
  saveResults();
}

// the last 50 saved races, newest first
app.get('/api/results', function (req, res) {
  accounts.recentResults(50).catch(function (e) {
    console.error('Could not load saved races:', e.message);
    return [];
  }).then(function (ranked) {
    const all = ranked.concat(results.slice(-50)); // ranked from the database, casual from the local file
    all.sort(function (a, b) { return String(b.endedAt).localeCompare(String(a.endedAt)); });
    res.json(all.slice(0, 50));
  });
});

Object.assign(S, { saveResults, recordRace });
