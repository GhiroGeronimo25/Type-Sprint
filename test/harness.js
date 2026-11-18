'use strict';
// Shared test setup: runs the real server.js against fake Express, Socket.IO and accounts modules,
// so the whole game flow can be tested with no database or network.
// connect() gives a fake player socket; emits and calls record what the server sent and did.
const Module = require('module');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emits = [];                       // every message the server sent: { target, ev, data }
const calls = [];                       // every accounts call: [name, ...args]
const wallets = {};                     // pid -> coins, for the fake accounts
let onConnection;

function fakeAccounts() {
  const log = (name) => (...args) => { calls.push([name, ...args]); };
  return {
    ENTRY_FEE: 50,
    join: async (pid) => { calls.push(['join', pid]); if (!(pid in wallets)) wallets[pid] = 500; return { rating: 1000, coins: wallets[pid], races: 0, wins: 0, ledger: [], entryFee: 50 }; },
    view: async (pid) => ({ rating: 1000, coins: wallets[pid] || 0, races: 0, wins: 0, ledger: [], entryFee: 50 }),
    collectEntries: async (code, pids, fee) => {
      calls.push(['collectEntries', code, pids.slice(), fee]);
      const entered = pids.filter((p) => wallets[p] >= fee);
      return { entered, pot: entered.length * fee };
    },
    refundEntry: async (...a) => { log('refundEntry')(...a); return 0; },
    voidPot: async (...a) => { log('voidPot')(...a); return []; },
    voidAllPots: async () => 0,
    settle: async (code, ranked, text) => {
      calls.push(['settle', code, ranked, text]);
      const out = {};
      ranked.forEach((r, i) => { out[r.pid] = { rank: i + 1, payout: i === 0 ? 100 : 0, net: i === 0 ? 50 : -50, ratingBefore: 1000, ratingAfter: 1010 - i * 20, ratingDelta: 10 - i * 20 }; });
      return out;
    },
    recentResults: async () => [],
    recordRaceStats: async (code, ranked, difficulty, players) => { calls.push(['recordRaceStats', code, ranked, difficulty, players]); return players.length; },
    playerStats: async (pid) => { calls.push(['playerStats', pid]); return { races: 2, flaggedRaces: 0, bestWpm: 80, avgWpm: 70, trend: [], mostMissed: [] }; },
    leaderboard: async (limit, pid) => { calls.push(['leaderboard', limit, pid]); return [{ name: 'Ann', rating: 1100, races: 3, wins: 2, bestWpm: 80, isYou: false }]; },
  };
}

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'dotenv') return { config() {} };
  if (request === 'express') {
    const express = () => ({ use() {}, get() {} });
    express.static = () => () => {};
    return express;
  }
  if (request === 'socket.io') {
    return { Server: class { to(target) { return { emit: (ev, data) => emits.push({ target, ev, data }) }; } on(ev, fn) { if (ev === 'connection') onConnection = fn; } } };
  }
  if (request === 'http') return { createServer: () => ({ listen: (p, cb) => cb && cb() }) };
  if (request === './accounts') return () => fakeAccounts();
  return realLoad.apply(this, arguments);
};
process.env.PORT = '0';
process.env.COUNTDOWN_MS = process.env.COUNTDOWN_MS || '120';   // short race so the whole flow runs in under a second
process.env.RACE_MS = process.env.RACE_MS || '400';
require(path.join(__dirname, '..', 'server.js'));
Module._load = realLoad;

let counter = 0;
function connect() {
  const id = 'sock' + ++counter;
  const handlers = {};
  const socket = {
    id, data: {}, handlers,
    on(ev, fn) { handlers[ev] = fn; },
    join() {}, leave() {},
    emit(ev, data) { emits.push({ target: id, ev, data }); },
  };
  onConnection(socket);
  const ask = (ev, data) => new Promise((resolve) => handlers[ev](data, resolve));
  return { socket, ask, fire: (ev, data) => handlers[ev](data) };
}
const lastState = (code) => [...emits].reverse().find((e) => e.ev === 'room:state' && e.data.code === code).data;
const called = (name) => calls.filter((c) => c[0] === name);


module.exports = { sleep, emits, calls, wallets, connect, lastState, called };
