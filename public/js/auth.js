// Login and sign-up (Supabase Auth)
// ---------- login (Supabase Auth) ----------
// pid is only used on this screen (for example to mark "you"). The server never trusts it: it uses the id
// from the verified login token instead.
let pid = null;
let supa = null;

async function getAccessToken() {
  if (!supa) return '';
  const res = await supa.auth.getSession(); // refreshes an expired token when needed
  return res.data.session ? res.data.session.access_token : '';
}

function showAuthMessage(text, isError) {
  $('authMsg').hidden = !text;
  $('authMsg').textContent = text || '';
  $('authMsg').classList.toggle('error', !!isError);
}

function setAuthBusy(busy) {
  $('authSubmit').disabled = busy;
}

function friendlyAuthError(error) {
  const m = String(error && error.message || '');
  if (/invalid login/i.test(m)) return 'Wrong email or password.';
  if (/already registered/i.test(m)) return 'That email already has an account. Try logging in.';
  if (/email not confirmed/i.test(m)) return 'Please confirm your email first (check your inbox).';
  return m || 'Something went wrong. Please try again.';
}

let authMode = 'login';
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,16}$/;

function setAuthMode(mode) {
  authMode = mode;
  showAuthMessage('');
  const signup = mode === 'signup';
  $('authTitle').textContent = signup ? 'Create account' : 'Log in';
  $('usernameRow').hidden = !signup;
  $('authSubmit').textContent = signup ? 'Create account' : 'Log in';
  $('authSwitchText').textContent = signup ? 'Already have an account?' : 'New here?';
  $('authSwitch').textContent = signup ? 'Log in' : 'Create an account';
  $('authPassword').autocomplete = signup ? 'new-password' : 'current-password';
}

async function onAuthSubmit(event) {
  event.preventDefault();
  showAuthMessage('');
  const email = $('authEmail').value.trim();
  const password = $('authPassword').value;
  if (!email || password.length < 6) return showAuthMessage('Enter an email and a password of at least 6 characters.', true);
  setAuthBusy(true);
  try {
    if (authMode === 'login') {
      const res = await supa.auth.signInWithPassword({ email: email, password: password });
      if (res.error) showAuthMessage(friendlyAuthError(res.error), true);
      return; // success is handled by onAuthChange
    }
    const username = $('authUsername').value.trim();
    if (!USERNAME_RE.test(username)) return showAuthMessage('Username: 3-16 letters, numbers, dots, dashes or underscores.', true);
    const check = await (await fetch('/api/username-available?name=' + encodeURIComponent(username))).json();
    if (!check.ok) return showAuthMessage(check.error || 'That username is not available.', true);
    const res = await supa.auth.signUp({ email: email, password: password, options: { data: { username: username } } });
    if (res.error) return showAuthMessage(friendlyAuthError(res.error), true);
    // When an email is already registered, Supabase answers with a fake "new" user that has no identities (so it
    // can't be used to find out who has an account). That is not a new account: say so instead of "check your email".
    const created = res.data && res.data.user;
    if (created && Array.isArray(created.identities) && created.identities.length === 0) {
      setAuthMode('login');
      $('authEmail').value = email;
      return showAuthMessage('That email already has an account. Log in instead.', true);
    }
    // with email confirmation switched on there is no session yet
    if (!res.data.session) {
      setAuthMode('login');
      showAuthMessage('Account created. Check your email to confirm it, then log in.', false);
    }
  } catch (e) {
    showAuthMessage('Could not reach the server. Please try again.', true);
  } finally {
    setAuthBusy(false);
  }
}

async function onSignOut() {
  await supa.auth.signOut(); // onAuthChange does the rest
}

// called whenever the login state changes (page load, log in, log out, token refresh)
function onAuthChange(session) {
  if (session && session.user) {
    const changedUser = pid !== session.user.id;
    pid = session.user.id;
    const username = (session.user.user_metadata || {}).username || String(session.user.email || '').split('@')[0];
    $('userEmail').textContent = username;
    $('name').value = username; // the server uses the account's name; this only keeps the screen consistent
    $('authPassword').value = '';
    if (changedUser) socket.disconnect(); // a different person logged in: start a fresh connection
    socket.connect();                     // does nothing if already connected
    if (!state.room) showScreen('home');
  } else {
    pid = null;
    localStorage.removeItem('session');
    socket.disconnect();
    state.room = null;
    state.account = null;
    $('coinPill').hidden = true;
    $('typing').disabled = true;
    history.replaceState(null, '', location.pathname);
    showScreen('auth');
  }
}

async function startAuth() {
  let config;
  try {
    config = await (await fetch('/config.json')).json();
  } catch (e) {
    config = {};
  }
  if (!config.supabaseUrl || !config.supabaseAnonKey || !window.supabase) {
    showScreen('auth');
    return showAuthMessage('Login is not set up yet: the server needs SUPABASE_URL and SUPABASE_ANON_KEY.', true);
  }
  supa = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
  $('authForm').addEventListener('submit', onAuthSubmit);
  $('authSwitch').addEventListener('click', function () { setAuthMode(authMode === 'login' ? 'signup' : 'login'); });
  $('signOut').addEventListener('click', onSignOut);
  supa.auth.onAuthStateChange(function (event, session) {
    if (event === 'TOKEN_REFRESHED') return; // same user: nothing to redo
    onAuthChange(session);
  });
  const first = await supa.auth.getSession();
  onAuthChange(first.data.session);
}

// what the screen remembers between server updates
const state = { account: null, result: null, room: null, text: '', startAt: 0, limitMs: 60000, offset: 0, chars: [], restore: '', resultDismissed: false };
