// Wallet: rating, coins and transactions
// ---------- wallet: rating, coins and transactions ----------
const ledgerLabels = { grant: 'Welcome coins', entry: 'Entry fee', reward: 'Prize', refund: 'Refund' };

function signed(n) {
  return (n > 0 ? '+' : n < 0 ? '\u2212' : '') + Math.abs(n);
}

const history_ = { type: '', items: [], hasMore: false, loading: false };
const ledgerTime = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };

function renderLedger() {
  let html = '';
  for (let i = 0; i < history_.items.length; i++) {
    const t = history_.items[i];
    html += '<li><span class="tx ' + (t.amount < 0 ? 'out' : 'in') + '">' + signed(t.amount) + '</span>' +
      '<span class="what">' + ledgerLabels[t.type] + (t.room ? ' <small>' + esc(t.room) + '</small>' : '') + '</span>' +
      '<span class="bal">' + t.balance + ' left</span>' +
      '<span class="when">' + new Date(t.at).toLocaleString(undefined, ledgerTime) + '</span></li>';
  }
  $('ledger').innerHTML = html;
  $('ledgerEmpty').hidden = history_.items.length > 0;
  $('ledgerMore').hidden = !history_.hasMore;
  $('ledgerMore').disabled = history_.loading;
}

// reset = start again from the newest; otherwise add the next page below what is shown
// Uses the REST API: GET /api/wallet/transactions with the login token.
async function loadHistory(reset) {
  if (history_.loading) return;
  history_.loading = true;
  $('ledgerMore').disabled = true;
  const type = history_.type;
  try {
    const token = await getAccessToken();
    const url = '/api/wallet/transactions?offset=' + (reset ? 0 : history_.items.length) + '&type=' + encodeURIComponent(type);
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const page = await res.json();
    if (type === history_.type) { // the filter may have changed while we waited
      history_.items = reset ? page.items : history_.items.concat(page.items);
      history_.hasMore = page.hasMore;
    }
  } catch (e) {
    showToast('Could not load your transactions.');
  }
  history_.loading = false;
  renderLedger();
}

$('ledgerFilters').addEventListener('click', function (event) {
  const button = event.target.closest('button[data-type]');
  if (!button) return;
  history_.type = button.getAttribute('data-type');
  const all = document.querySelectorAll('#ledgerFilters button');
  for (let i = 0; i < all.length; i++) all[i].classList.toggle('active', all[i] === button);
  if (history_.type === '' && state.account) { renderWallet(); return; }
  history_.items = [];
  history_.hasMore = false;
  renderLedger();
  loadHistory(true);
});
$('ledgerMore').addEventListener('click', function () { loadHistory(false); });

function setAccount(account) {
  state.account = account;
  renderWallet();
}

function renderWallet() {
  const a = state.account;
  if (!a) return;
  $('wallet').hidden = false;
  $('feeNote').textContent = a.entryFee;
  $('walletStats').innerHTML = '<div><b>' + a.coins + '</b><span>coins</span></div>' +
    '<div><b>' + a.rating + '</b><span>rating</span></div>' +
    '<div><b>' + a.wins + '/' + a.races + '</b><span>wins / races</span></div>';
  // the account message carries the latest 10; any other filter is fetched from the server
  if (history_.type === '') {
    history_.items = a.ledger.slice();
    history_.hasMore = a.ledger.length >= 10;
    renderLedger();
  } else {
    loadHistory(true);
  }
  $('walletChip').innerHTML = Number(a.coins) + ' coins<span class="chip-rating"> \u00b7 rating ' + Number(a.rating) + '</span>';
  $('coinPill').hidden = false;
  $('coinPill').innerHTML = Number(a.coins) + ' coins<span class="chip-rating"> \u00b7 ' + Number(a.rating) + '</span>';
  refreshChip();
}

// coins and rating only matter in ranked races, so a casual room doesn't show them
function refreshChip() {
  const casual = state.room && state.room.ranked === false;
  $('walletChip').hidden = !state.account || !!casual;
}

function onResult(result) {
  state.result = result;
  loadRaceHistory(true); // the race has just been saved: refresh the history
  if (state.room) render();
}
