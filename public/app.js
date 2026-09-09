const $ = id => document.getElementById(id);
let state, acting = false, signature = '';
let pendingRemoval = null;   // the account whose Remove was clicked once
let requestedUsage = false;
function usageView(entry) {
  const view = document.createElement('div'); view.className = 'usage';
  if (!entry) { const p = document.createElement('p'); p.textContent = state.usageRefreshing ? 'Checking usage…' : 'Usage not checked yet'; view.append(p); return view; }
  if (entry.error) { const p = document.createElement('p'); p.className = 'usage-error'; p.textContent = entry.error; view.append(p); }
  for (const bucket of entry.buckets || []) {
    for (const window of bucket.windows) {
      const row = document.createElement('div'); row.className = 'usage-row';
      const mins = window.durationMins;
      const period = mins === null ? window.key : mins % 1440 === 0 ? `${mins / 1440}-day` : mins % 60 === 0 ? `${mins / 60}-hour` : `${mins}-minute`;
      const label = document.createElement('div'); label.className = 'usage-label';
      const name = document.createElement('span'); name.textContent = `${bucket.name} · ${period}`;
      const left = document.createElement('strong'); left.textContent = `${Math.round(window.remainingPercent)}% left${entry.error ? ' (last known)' : ''}`;
      label.append(name, left);
      const meter = document.createElement('progress'); meter.max = 100; meter.value = window.remainingPercent; meter.setAttribute('aria-label', `${bucket.name} ${period} remaining`);
      const reset = document.createElement('p'); reset.textContent = window.resetsAt ? `Resets ${new Date(window.resetsAt * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : 'Reset time unavailable';
      row.append(label, meter, reset); view.append(row);
    }
  }
  if (entry.checkedAt) { const time = document.createElement('p'); time.className = 'checked'; time.textContent = `Checked ${new Date(entry.checkedAt).toLocaleTimeString()}`; view.append(time); }
  return view;
}
// ---- running out ----------------------------------------------------------
// Sounds once when an account's remaining usage first reaches zero, not on
// every poll while it stays there.
const exhausted = new Set();   // windows empty as of the last reading
const seen = new Set();        // windows this page has ever had a reading for
const alarm = new Audio('/fahh.mp3');
alarm.preload = 'auto';

function soundWanted() {
  try { return localStorage.getItem('sound') !== 'off'; } catch { return true; }
}

// Every usage window in a reading, and which of them are empty.
function readWindows(state) {
  const all = new Set();
  const empty = new Set();
  for (const [id, entry] of Object.entries(state.usage || {})) {
    for (const bucket of entry.buckets || []) {
      for (const window of bucket.windows) {
        const key = `${id}:${bucket.id}:${window.key}`;
        all.add(key);
        if (Math.round(window.remainingPercent) <= 0) empty.add(key);
      }
    }
  }
  return { all, empty };
}

function checkExhaustion(state) {
  const { all, empty } = readWindows(state);
  // Running out is a change between two readings. A window seen for the first
  // time is the current state, however it looks — usage arrives a few seconds
  // after the page loads, so treating its arrival as news cried wolf on every
  // reload for accounts that were already empty.
  const fresh = [...empty].filter(key => seen.has(key) && !exhausted.has(key));
  for (const key of all) seen.add(key);
  exhausted.clear();
  for (const key of empty) exhausted.add(key);
  if (!fresh.length || !soundWanted()) return;
  const account = state.accounts.find(a => a.id === fresh[0].split(':')[0]) || state.current;
  notify(`${account ? account.email : 'An account'} has run out for now.`, true);
  // Blocked until the page has been interacted with; nothing to do about it.
  alarm.currentTime = 0;
  alarm.play().catch(() => {});
}

function notify(message, error = false) { $('notice').textContent = message; $('notice').className = error ? 'error' : ''; }
async function action(route, data = {}) {
  if (acting) return;
  acting = true; renderButtons();
  try {
    const response = await fetch(`/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dashboard-Token': state.token }, body: JSON.stringify(data) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    if (route === 'switch') notify(`Selected ${result.email}. Start a new Codex session in your terminal to use this account.`);
    if (route === 'capture') notify('Current account saved on this computer.');
    if (route === 'logins') notify('Checked which account each agent is using.');
    if (route === 'forget') notify(result.selected
      ? `Removed the saved copy of ${result.email}. Your terminal is still signed into it; use Save current login to keep it again.`
      : `Removed ${result.email}. Sign in again any time to add it back.`);
    await refresh();
  } catch (e) { notify(e.message, true); }
  finally { acting = false; renderButtons(); }
}
function renderButtons() {
  const blocked = acting || !state || !!state.warning || state.login?.status === 'pending';
  $('add').disabled = blocked;
  $('capture').disabled = blocked || !state?.current;
  $('usage-refresh').disabled = blocked || state?.usageRefreshing;
  $('logins-refresh').disabled = acting;
  $('usage-refresh').textContent = state?.usageRefreshing ? 'Checking usage…' : 'Refresh usage';
  document.querySelectorAll('[data-account]').forEach(button => { button.disabled = blocked || button.dataset.account === state?.current?.id; });
  document.querySelectorAll('[data-remove]').forEach(button => { button.disabled = blocked; });
}
function loginCard(entry) {
  const card = document.createElement('article');
  card.className = `login${entry.signedIn ? ' on' : ''}`;
  const dot = document.createElement('span');
  dot.className = 'dot';

  const top = document.createElement('div');
  top.className = 'top';
  const body = document.createElement('div');
  const name = document.createElement('h3');
  name.textContent = entry.label;
  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = entry.account || 'Not signed in';
  const detail = document.createElement('p');
  detail.textContent = entry.detail || '';
  body.append(name, who, detail);

  // Its limits, where the agent reports any. Two of the four do not, and the
  // card says so rather than leaving a blank.
  const limits = (state.agentUsage || {})[entry.id];
  if (limits) {
    if (limits.buckets?.length) {
      body.append(usageView({ buckets: limits.buckets, checkedAt: limits.checkedAt, error: limits.error }));
    } else {
      const none = document.createElement('p');
      none.className = 'no-usage';
      none.textContent = limits.note || 'No usage reported';
      body.append(none);
    }
    if (limits.buckets?.length && limits.note) {
      const note = document.createElement('p');
      note.className = 'no-usage';
      note.textContent = limits.note;
      body.append(note);
    }
  }

  // Codex is the only one this dashboard can switch; say so rather than
  // leaving people looking for a button on the others.
  if (entry.id === 'codex') {
    const note = document.createElement('p');
    note.className = 'switchable';
    note.textContent = '↓ Switch it below';
    body.append(note);
  }
  top.append(dot, body);
  card.append(top);
  return card;
}

function render() {
  $('current').textContent = state.current?.email || 'No ChatGPT login detected';
  $('count').textContent = state.accounts.length;
  $('download').hidden = !state.packageAvailable;
  if (state.warning) notify(state.warning, true);
  $('login-count').textContent = (state.logins || []).length;
  const nextSignature = JSON.stringify([state.accounts, state.current?.id, state.usage, state.usageRefreshing, pendingRemoval, state.logins, state.agentUsage]);
  if (nextSignature !== signature) {
    signature = nextSignature;
    $('logins').replaceChildren(...(state.logins || []).map(loginCard));
    $('current-usage').replaceChildren();
    if (state.current) $('current-usage').append(usageView(state.usage?.[state.current.id]));
    $('accounts').replaceChildren();
    if (!state.accounts.length) {
      const empty = document.createElement('div'); empty.className = 'empty';
      const title = document.createElement('h3'); title.textContent = 'Your accounts, ready when you are.';
      const detail = document.createElement('p'); detail.textContent = 'Save your current login, then add your other accounts.';
      empty.append(title, detail); $('accounts').append(empty);
    }
    for (const account of state.accounts) {
      const active = account.id === state.current?.id;
      const card = document.createElement('article'); card.className = `card${active ? ' active' : ''}`;
      const top = document.createElement('div'); top.className = 'card-top';
      const avatar = document.createElement('span'); avatar.className = 'avatar'; avatar.textContent = account.email[0].toUpperCase();
      const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = active ? '● Selected' : 'Saved login';
      top.append(avatar, badge);
      const title = document.createElement('h3'); title.textContent = account.email;
      const detail = document.createElement('p'); detail.textContent = `${account.plan} · Workspace …${account.workspace}`;
      const button = document.createElement('button'); button.dataset.account = account.id; button.textContent = active ? 'Currently selected' : 'Use this account →';
      button.addEventListener('click', () => action('switch', { id: account.id }));

      // Two clicks rather than a confirm() dialog, which does nothing inside
      // the Mac app's window.
      const confirming = pendingRemoval === account.id;
      const remove = document.createElement('button');
      remove.dataset.remove = account.id;
      remove.className = `remove${confirming ? ' confirming' : ''}`;
      remove.textContent = confirming ? 'Remove this account?' : 'Remove';
      remove.addEventListener('click', () => {
        if (!confirming) { pendingRemoval = account.id; return render(); }
        pendingRemoval = null;
        void action('forget', { id: account.id });
      });
      card.append(top, title, detail, usageView(state.usage?.[account.id]), button, remove); $('accounts').append(card);
    }
  }
  $('login').hidden = !state.login;
  if (state.login) {
    $('login-message').textContent = state.login.message;
    $('login-link').hidden = !state.login.url;
    if (state.login.url) $('login-link').href = state.login.url;
    else $('login-link').removeAttribute('href');
  }
  renderButtons();
}
async function refresh() {
  const response = await fetch('/api/state');
  if (!response.ok) throw new Error('Could not load accounts.');
  state = await response.json();
  checkExhaustion(state);
  render();
  if (!requestedUsage && !state.warning) { requestedUsage = true; void action('usage'); }
}
// Clicking anything else abandons a pending removal. The redraw is deferred so
// that click still reaches its own button, which this would otherwise replace.
document.addEventListener('click', event => {
  if (!pendingRemoval || event.target.closest('[data-remove]')) return;
  pendingRemoval = null;
  setTimeout(() => { if (state) render(); }, 0);
}, true);
$('sound').checked = soundWanted();
$('sound').onchange = () => {
  try { localStorage.setItem('sound', $('sound').checked ? 'on' : 'off'); } catch { /* private window */ }
  if ($('sound').checked) { alarm.currentTime = 0; void alarm.play().catch(() => {}); }
};
$('logins-refresh').onclick = () => action('logins');
$('capture').onclick = () => action('capture');
$('add').onclick = () => action('login');
$('usage-refresh').onclick = () => action('usage');
refresh().catch(e => notify(e.message, true));
setInterval(() => { if (!acting) refresh().catch(() => notify('Dashboard disconnected. Restart it with npm start.', true)); }, 2500);
setInterval(() => { if (!document.hidden && state && !acting && !state.warning && state.login?.status !== 'pending') void action('usage'); }, 60000);
