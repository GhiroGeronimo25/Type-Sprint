'use strict';

// Matchmaking queue: pure logic, no sockets. server.js feeds it tickets and starts the rooms it returns.
//
// A ticket is { id, rating, ranked, difficulty, joinedAt, ...anything else }, and ids are unique (one search per player).
// Players only meet others in the same pool (same ranked/casual type and the same difficulty).
// Within a pool, the player who has waited longest is matched first, with opponents of a similar rating:
// the allowed rating gap starts small and widens the longer that player waits, so nobody waits forever.

function createMatchmaker(options) {
  const opts = Object.assign({
    baseWindow: 100,     // rating gap allowed at first
    stepWindow: 50,      // the gap grows by this much ...
    stepMs: 5000,        // ... every this many milliseconds of waiting
    openAfterMs: 30000,  // after this long, any rating will do
    minPlayers: 2,
    maxPlayers: 5,
    fillMs: 5000,        // with fewer than maxPlayers, wait this long for more to turn up
  }, options || {});

  const tickets = new Map();

  function windowFor(waitedMs) {
    if (waitedMs >= opts.openAfterMs) return Infinity;
    return opts.baseWindow + Math.floor(waitedMs / opts.stepMs) * opts.stepWindow;
  }

  function poolKey(ticket) {
    return (ticket.ranked ? 'ranked' : 'casual') + '|' + ticket.difficulty;
  }

  function add(ticket) {
    if (tickets.has(ticket.id)) return false;
    tickets.set(ticket.id, ticket);
    return true;
  }

  function remove(id) {
    return tickets.delete(id);
  }

  function has(id) {
    return tickets.has(id);
  }

  function all() {
    return Array.from(tickets.values());
  }

  // how many players are searching in the same pool as this ticket (including it)
  function poolSize(ticket) {
    const key = poolKey(ticket);
    return all().filter(function (t) { return poolKey(t) === key; }).length;
  }

  // Forms every match that is ready at time `now`, removes those players from the queue and returns them
  // as groups of tickets (the player who waited longest first).
  function take(now) {
    const pools = {};
    tickets.forEach(function (t) {
      const key = poolKey(t);
      (pools[key] = pools[key] || []).push(t);
    });

    const groups = [];
    Object.keys(pools).forEach(function (key) {
      const list = pools[key].sort(function (a, b) { return a.joinedAt - b.joinedAt; });
      const used = new Set();

      list.forEach(function (anchor) {
        if (used.has(anchor)) return;
        const waited = now - anchor.joinedAt;
        const allowed = windowFor(waited);

        const mates = list.filter(function (t) {
          return t !== anchor && !used.has(t) && Math.abs(t.rating - anchor.rating) <= allowed;
        }).sort(function (a, b) {
          return Math.abs(a.rating - anchor.rating) - Math.abs(b.rating - anchor.rating) || a.joinedAt - b.joinedAt;
        }).slice(0, opts.maxPlayers - 1);

        const group = [anchor].concat(mates);
        const full = group.length >= opts.maxPlayers;
        const waitedEnough = group.length >= opts.minPlayers && waited >= opts.fillMs;
        if (!full && !waitedEnough) return; // this player keeps waiting; others in the pool may still match

        group.forEach(function (t) { used.add(t); tickets.delete(t.id); });
        groups.push(group);
      });
    });
    return groups;
  }

  return { add: add, remove: remove, has: has, all: all, poolSize: poolSize, take: take };
}

module.exports = createMatchmaker;
