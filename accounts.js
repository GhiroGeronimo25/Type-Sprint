'use strict';

const fs = require('fs');
const path = require('path');

const START_COINS = 500;
const START_RATING = 1000;
const MIN_RATING = 100;
const ENTRY_FEE = 50;
const K_FACTOR = 32;
const LEDGER_KEEP = 40;
// share of the prize pool by finishing place (by how many racers actually typed)
const SHARES = { 1: [1], 2: [0.7, 0.3], 3: [0.5, 0.3, 0.2] };

function createAccounts(file) {
  let accounts = {};
  let saving = false;
  let dirty = false;

  try {
    accounts = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!accounts || typeof accounts !== 'object' || Array.isArray(accounts)) accounts = {};
  } catch (e) {
    accounts = {};
  }

  // writes are coalesced so two saves never fight over the same temp file
  function save() {
    dirty = true;
    if (saving) return;
    saving = true;
    dirty = false;
    function finish(err) {
      if (err) console.error('Could not save accounts:', err.message);
      saving = false;
      if (dirty) save();
    }
    fs.mkdir(path.dirname(file), { recursive: true }, function (err) {
      if (err) return finish(err);
      const tmp = file + '.tmp';
      fs.writeFile(tmp, JSON.stringify(accounts, null, 2), function (err) {
        if (err) return finish(err);
        fs.rename(tmp, file, finish);
      });
    });
  }

  function get(pid, name) {
    if (!pid) return null;
    let a = accounts[pid];
    if (!a) {
      a = accounts[pid] = {
        pid: pid, name: name || 'Racer', rating: START_RATING, coins: START_COINS,
        races: 0, wins: 0, createdAt: new Date().toISOString(), ledger: [],
      };
      a.ledger.push(entry('grant', START_COINS, a.coins, ''));
      save();
    } else if (name && a.name !== name) {
      a.name = name;
      save();
    }
    return a;
  }

  function entry(type, amount, balance, room) {
    return { at: new Date().toISOString(), type: type, amount: amount, balance: balance, room: room || '' };
  }

  function post(a, type, amount, room) {
    a.coins += amount;
    a.ledger.push(entry(type, amount, a.coins, room));
    if (a.ledger.length > LEDGER_KEEP) a.ledger = a.ledger.slice(-LEDGER_KEEP);
  }

  function canAfford(pid, fee) {
    const a = get(pid);
    return !!a && a.coins >= fee;
  }

  // money out: returns false (and changes nothing) if the wallet is too small
  function charge(pid, fee, room) {
    const a = get(pid);
    if (!a || a.coins < fee) return false;
    post(a, 'entry', -fee, room);
    save();
    return true;
  }

  function refund(pid, fee, room) {
    const a = get(pid);
    if (!a) return;
    post(a, 'refund', fee, room);
    save();
  }

  function rating(pid) {
    const a = accounts[pid];
    return a ? a.rating : START_RATING;
  }

  // public snapshot sent to the owner of the account
  function view(pid) {
    const a = get(pid);
    if (!a) return null;
    return {
      rating: a.rating, coins: a.coins, races: a.races, wins: a.wins,
      entryFee: ENTRY_FEE, ledger: a.ledger.slice(-10).reverse(),
    };
  }

  // Pays out one finished race.
  // ranked: [{ pid, active }] in finishing order (active = typed at least one letter)
  // fee: what each racer paid in, pot: everything collected (leavers' fees stay in it)
  // Returns { [pid]: { rank, payout, net, ratingBefore, ratingAfter, ratingDelta } }
  function settle(code, ranked, fee, pot) {
    const out = {};
    const n = ranked.length;
    const active = ranked.filter(function (r) { return r.active; });

    // 1. prizes
    const prizes = {};
    if (active.length === 0) {
      ranked.forEach(function (r) { prizes[r.pid] = fee; }); // nobody typed: everyone gets their entry back
    } else {
      const shares = SHARES[Math.min(active.length, 3)];
      let paid = 0;
      shares.forEach(function (s, i) {
        const amount = Math.floor(pot * s);
        prizes[active[i].pid] = amount;
        paid += amount;
      });
      prizes[active[0].pid] += pot - paid; // rounding leftovers go to the winner
    }

    // 2. ratings: every pair of racers is a small Elo match, averaged
    const before = {};
    const delta = {};
    ranked.forEach(function (r) { before[r.pid] = get(r.pid).rating; delta[r.pid] = 0; });
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const hi = ranked[i].pid;
        const lo = ranked[j].pid;
        const expected = 1 / (1 + Math.pow(10, (before[lo] - before[hi]) / 400));
        delta[hi] += K_FACTOR * (1 - expected);
        delta[lo] -= K_FACTOR * (1 - expected);
      }
    }

    // 3. post everything
    ranked.forEach(function (r, i) {
      const a = get(r.pid);
      const prize = prizes[r.pid] || 0;
      if (prize > 0) post(a, active.length === 0 ? 'refund' : 'reward', prize, code);
      if (n > 1) a.rating = Math.max(MIN_RATING, before[r.pid] + Math.round(delta[r.pid] / (n - 1)));
      a.races++;
      if (n > 1 && i === 0 && r.active) a.wins++;
      out[r.pid] = {
        rank: i + 1, payout: prize, net: prize - fee,
        ratingBefore: before[r.pid], ratingAfter: a.rating, ratingDelta: a.rating - before[r.pid],
      };
    });
    save();
    return out;
  }

  return { get: get, canAfford: canAfford, charge: charge, refund: refund, rating: rating, view: view, settle: settle, ENTRY_FEE: ENTRY_FEE };
}

module.exports = createAccounts;
