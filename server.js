require('dotenv').config();
// Type Sprint: the entry point. The code lives in src/, one file per job:
//   config.js        settings and limits            core.js         web server, Socket.IO, shared state
//   routes/*.js      the REST API                   socketAuth.js   login check for sockets
//   rules.js         scoring and anti-cheat         lobby.js        open rooms and room:state broadcasts
//   race.js          countdown, racing, payout      players.js      joining and leaving rooms
//   matchmaking.js   quick match                    sockets.js      Socket.IO events
//   results.js       saved casual/practice results
const { PORT } = require('./src/config');
const { server, accounts } = require('./src/core');

require('./src/routes/misc');
require('./src/socketAuth');
require('./src/results');
require('./src/routes/api');
require('./src/rules');
require('./src/lobby');
require('./src/race');
require('./src/players');
require('./src/matchmaking');
require('./src/routes/auth');
require('./src/routes/rooms');
require('./src/sockets');

// races that were running when the server stopped never finish: give those entry fees back, then open up
accounts.voidAllPots().then(function (count) {
  if (count > 0) console.log('Returned ' + count + ' unfinished race pot(s).');
}).catch(function (e) {
  console.error('Could not return old pots (is the database set up?):', e.message);
}).then(function () {
  server.listen(PORT, function () {
    console.log('Type Sprint running at http://localhost:' + PORT);
  });
});
