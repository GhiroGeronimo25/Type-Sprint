// Every socket must log in first (Supabase access token in the handshake)
const { io, accounts } = require('./core');

// Every socket must log in first. The browser sends its Supabase access token in the handshake; we verify it
// and remember who it belongs to. From here on the player id (pid) is the verified Supabase user id and is
// NEVER taken from what the client sends, so nobody can play (or spend coins) as someone else.
io.use(async function (socket, next) {
  try {
    const user = await accounts.verifyToken(((socket.handshake || {}).auth || {}).token);
    if (!user) return next(new Error('unauthorized'));
    socket.data.pid = user.id;
    socket.data.email = user.email;
    // the display name comes from the account (chosen at sign-up), never from what the browser sends
    socket.data.name = user.username || String(user.email || '').split('@')[0];
    next();
  } catch (e) {
    console.error('Login check failed:', e.message);
    next(new Error('unauthorized'));
  }
});
