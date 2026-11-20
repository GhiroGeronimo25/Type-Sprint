// Race flow: start, countdown, racing, payout, end
const passages = require('../passages');
const { COUNTDOWN_MS, RACE_MS } = require('./config');
const { io, accounts, ENTRY_FEE, rooms } = require('./core');
const S = require('./shared');
const allFinished = function () { return S.allFinished.apply(this, arguments); };
const broadcast = function () { return S.broadcast.apply(this, arguments); };
const byRank = function () { return S.byRank.apply(this, arguments); };
const recordRace = function () { return S.recordRace.apply(this, arguments); };
const resetPlayer = function () { return S.resetPlayer.apply(this, arguments); };
const statsPayload = function () { return S.statsPayload.apply(this, arguments); };
const updateStats = function () { return S.updateStats.apply(this, arguments); };

// ---------- race flow ----------
function logError(what) {
  return function (e) { console.error(what + ':', e.message); };
}

function sendAccount(p) {
  accounts.view(p.pid).then(function (view) {
    if (view) io.to(p.id).emit('account:state', view);
  }).catch(logError('Could not load account ' + p.pid));
}

// Resolves to an error message if the race can't start.
// Ranked: entry fees of everyone who can pay are moved into the race pot in one database transaction
// (all or nothing); racers with too few coins stay in the room and watch.
// Casual: free for everyone, no pot, no coins or rating change, and no database calls.
async function startRace(room) {
  let entered;
  // Racing alone is practice: it is free, so no fee is taken, nothing is paid out and the rating stays put.
  room.practice = room.players.length === 1; // racing alone: free, and anyone who joins waits in the lobby
  room.paid = room.ranked && room.players.length > 1;
  if (!room.paid) {
    entered = room.players.map(function (p) { return p.pid; });
  } else {
    room.starting = true; // blocks a second start (and new joiners) while the fees are being collected
    let collected;
    try {
      collected = await accounts.collectEntries(room.code, room.players.map(function (p) { return p.pid; }), ENTRY_FEE);
    } catch (e) {
      room.starting = false;
      console.error('Could not collect entry fees for ' + room.code + ':', e.message);
      return 'Could not collect the entry fees. Nobody was charged, please try again.';
    }

    room.starting = false;
    if (rooms[room.code] !== room) { // everyone left while the fees were being collected
      if (collected.entered.length > 0) accounts.voidPot(room.code).catch(logError('Could not return pot ' + room.code));
      return '';
    }

    // racers who left in the meantime get their fee back
    const here = room.players.map(function (p) { return p.pid; });
    entered = collected.entered.filter(function (pid) { return here.indexOf(pid) >= 0; });
    collected.entered.forEach(function (pid) {
      if (here.indexOf(pid) < 0) accounts.refundEntry(room.code, pid).catch(logError('Could not refund ' + pid));
    });
    if (entered.length === 0) {
      if (collected.entered.length > 0) return 'Everyone who paid left, so the race was cancelled.';
      return 'Nobody has ' + ENTRY_FEE + ' coins for the entry fee.';
    }
  }

  room.text = passages.pick(room.difficulty, room.text); // the server chooses: from the room's difficulty, never the same passage twice in a row
  room.status = 'countdown';
  room.startAt = Date.now() + COUNTDOWN_MS;
  room.pot = room.paid ? entered.length * ENTRY_FEE : 0;
  for (let i = 0; i < room.players.length; i++) {
    const p = room.players[i];
    resetPlayer(p);
    if (entered.indexOf(p.pid) >= 0) {
      if (room.paid && p.away) p.forfeited = true; // already disconnected: paid in, but out of the race
      else p.entered = true;
    } else {
      io.to(p.id).emit('race:notice', { message: 'You need ' + ENTRY_FEE + ' coins to enter. You are watching this one.' });
    }
    sendAccount(p);
  }

  // the passage is only revealed when the countdown starts
  io.to(room.code).emit('race:countdown', {
    text: room.text,
    startAt: room.startAt,
    serverNow: Date.now(),
    limitMs: RACE_MS,
  });
  broadcast(room);
  const startAt = room.startAt;
  setTimeout(function () {
    if (room.status !== 'countdown' || room.startAt !== startAt) return; // sent back to the lobby meanwhile
    beginRacing(room);
  }, COUNTDOWN_MS);
  return '';
}

function beginRacing(room) {
  if (rooms[room.code] !== room) return; // everyone left during the countdown
  room.status = 'racing';
  broadcast(room);
  if (allFinished(room)) return endRace(room); // everyone who paid has already disconnected
  room.tickTimer = setInterval(function () {
    for (let i = 0; i < room.players.length; i++) {
      if (!room.players[i].finished) updateStats(room, room.players[i]);
    }
    broadcast(room);
  }, 100);
  room.endTimer = setTimeout(function () {
    endRace(room);
  }, RACE_MS);
}

// pay prizes and update ratings, once per race
async function settleRace(room) {
  if (!room.paid) return; // casual and practice races pay nothing and change no ratings
  const ranked = room.players.filter(function (p) { return p.entered; });
  if (ranked.length === 0) {
    // everyone who paid disconnected or left: there is nobody to pay, so the race is cancelled and every fee goes back
    await accounts.voidPot(room.code).catch(logError('Could not return pot ' + room.code));
    return;
  }
  let outcome;
  try {
    // one transaction: split the pot by placement, update every rating, save the results
    outcome = await accounts.settle(room.code, ranked.map(function (p) {
      return {
        pid: p.pid,
        active: p.correct > 0,
        name: p.name,
        wpm: p.wpm,
        accuracy: p.accuracy,
        finished: p.finished,
        progress: Math.round((p.correct / room.text.length) * 1000) / 10,
        seconds: p.finished ? Math.round((p.finishedAt - room.startAt) / 100) / 10 : null,
      };
    }), room.text);
  } catch (e) {
    // the transaction was rolled back: nothing was paid, so return the fees instead of losing them
    console.error('Could not settle race ' + room.code + ':', e.message);
    await accounts.voidPot(room.code).catch(logError('Could not return pot ' + room.code));
    ranked.forEach(function (p) {
      io.to(p.id).emit('race:notice', { message: 'Something went wrong paying out this race. Your entry fee was returned.' });
      sendAccount(p);
    });
    return;
  }
  for (let i = 0; i < ranked.length; i++) {
    const p = ranked[i];
    p.result = outcome[p.pid];
    p.result.fee = ENTRY_FEE;
    p.rating = p.result.ratingAfter;
    io.to(p.id).emit('race:result', p.result);
    sendAccount(p);
  }
}

function endRace(room) {
  if (room.status !== 'racing') return;
  clearInterval(room.tickTimer);
  clearTimeout(room.endTimer);
  room.status = 'finished';
  for (let i = 0; i < room.players.length; i++) {
    if (!room.players[i].finished) updateStats(room, room.players[i]);
  }
  const stats = statsPayload(room);
  if (stats.length > 0) { // saved for every race, ranked or casual; a flagged race will not count towards anyone's stats
    accounts.recordRaceStats(room.code, room.paid, room.difficulty, stats).catch(logError('Could not save race stats'));
  }
  room.players.sort(byRank);
  broadcast(room);
  room.settling = true; // the payout is in flight: no new race until it is done
  settleRace(room).catch(logError('Could not settle race ' + room.code)).then(function () {
    room.settling = false;
    if (!room.paid) recordRace(room); // ranked results were saved inside the payout transaction
    broadcast(room);
  });
}

Object.assign(S, { logError, sendAccount, startRace, beginRacing, settleRace, endRace });
