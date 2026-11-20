// Small public routes: username check and the login config
const { USERNAME_RE } = require('../config');
const { app, accounts } = require('../core');

// The browser needs the project URL and the ANON key to show the login form. Both are public by design.
// (Never expose SUPABASE_SERVICE_KEY here.)

app.get('/api/username-available', function (req, res) {
  const name = String((req.query || {}).name || '');
  if (!USERNAME_RE.test(name)) return res.json({ ok: false, error: 'Use 3-16 letters, numbers, dots, dashes or underscores.' });
  accounts.usernameAvailable(name).then(function (free) {
    res.json({ ok: free, error: free ? '' : 'That username is taken.' });
  }).catch(function (e) {
    console.error('Username check failed:', e.message);
    res.status(500).json({ ok: false, error: 'Could not check the username. Please try again.' });
  });
});

app.get('/config.json', function (req, res) {
  res.json({ supabaseUrl: process.env.SUPABASE_URL || '', supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '' });
});
