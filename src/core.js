// The shared building blocks every other module uses: the web server, Socket.IO, the database layer,
// and the live state (rooms, the quick-match queue).
const path = require('path');
const http = require('http');
const express = require('express');
const socketio = require('socket.io');
const createAccounts = require('../accounts');
const createMatchmaker = require('../matchmaker'); // the quick-match queue
const { ROOT } = require('./config');

const app = express();
const server = http.createServer(app);
const io = new socketio.Server(server);
app.use(express.static(path.join(ROOT, 'public')));
app.use(express.json({ limit: '4kb' })); // request bodies for the REST room and matchmaking endpoints

const accounts = createAccounts(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, process.env.SUPABASE_ANON_KEY);
const ENTRY_FEE = accounts.ENTRY_FEE;

const rooms = {}; // rooms['ABCD'] = { code, hostId, status, text, startAt, players: [] }

const matchmaker = createMatchmaker({ fillMs: Number(process.env.MM_FILL_MS) || 5000 }); // the env override is for tests

// Players who queued through the REST API have no socket yet: their seat in the room is held for them, they
// learn the room code from GET /api/matchmaking, and they claim the seat with a room:join event.
const matchResults = {}; // pid -> { code, at }: a REST searcher's finished match, until they connect

module.exports = { app, server, io, accounts, ENTRY_FEE, rooms, matchmaker, matchResults };
