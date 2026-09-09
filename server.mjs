import http from 'node:http';
import { readFile, readdir, mkdtemp, rm, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Vault, readOptional } from './vault.mjs';
import { UsageCache } from './usage.mjs';
import { Runs, projectPath } from './runs.mjs';
import { agents } from './adapters.mjs';
import { Logins, agentUsage } from './logins.mjs';
import { Secrets } from './secrets.mjs';
import { Models } from './models.mjs';

const base = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.DASHBOARD_PORT || 4783);
const origin = `http://127.0.0.1:${port}`;
const secret = randomBytes(32).toString('hex');
const root = process.env.DASHBOARD_DATA_DIR || join(homedir(), '.local/share/codex-account-dashboard');
const vault = new Vault(root, process.env.CODEX_HOME || join(homedir(), '.codex'));
await vault.init();
const usage = new UsageCache(vault);
const secrets = new Secrets(root);
await secrets.init();
const models = new Models(root, vault.codexDir);
await models.init();
const runs = new Runs(process.env.DASHBOARD_RUNS_DIR || join(homedir(), '.local/share/codex-agent-runs'), vault, secrets, models);
await runs.init();
const logins = new Logins(vault);
const agentLabels = Object.fromEntries(Object.entries(agents).map(([id, agent]) => [id, agent.label]));
const packageAvailable = await access(join(base, 'dist', 'codex-account-dashboard-1.1.0.tgz')).then(() => true, () => false);
let lastUsageRequest = 0;
let login = null;
let busy = false;

async function startLogin() {
  if (login?.status === 'pending') throw new Error('A sign-in is already in progress.');
  await vault.compatible();
  const temp = await mkdtemp(join(root, 'login-'));
  const state = { status: 'pending', url: null, message: 'Preparing the OpenAI sign-in page…' };
  login = state;
  // A separate Codex home prevents adding an account from changing the active terminal login.
  const child = spawn(process.env.DASHBOARD_CODEX_BIN || 'codex', ['-c', 'cli_auth_credentials_store="file"', 'login'], {
    env: { ...process.env, CODEX_HOME: temp }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  const consume = chunk => {
    output = (output + chunk.toString()).slice(-24000);
    const match = output.match(/https:\/\/auth\.openai\.com\/[^\s\x1b]+/);
    if (match) { state.url = match[0]; state.message = 'Complete sign-in in your browser. Choose the account you want to add.'; }
  };
  child.stdout.on('data', consume);
  child.stderr.on('data', consume);
  const timer = setTimeout(() => { state.message = 'Sign-in timed out. Try Add account again.'; child.kill(); }, 5 * 60 * 1000);
  child.on('error', () => { state.status = 'error'; state.message = 'Could not start Codex. Check that the codex command is installed.'; });
  child.on('close', async code => {
    clearTimeout(timer);
    try {
      if (code !== 0) throw new Error('Sign-in did not complete. Close other login attempts and try again.');
      const raw = await readOptional(join(temp, 'auth.json'));
      if (!raw) throw new Error('No login was saved. Try signing in again.');
      await vault.save(raw);
      state.status = 'done'; state.message = 'Account added. Select it whenever you are ready.';
    } catch (e) { state.status = 'error'; state.message = e.message; }
    finally { state.url = null; await rm(temp, { recursive: true, force: true }); }
  });
  return state;
}

const server = http.createServer(async (req, res) => {
  const headers = type => ({ 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
  const send = (code, value, type = 'application/json') => {
    res.writeHead(code, headers(type));
    res.end(type === 'application/json' ? JSON.stringify(value) : value);
  };
  try {
    if (req.headers.host !== `127.0.0.1:${port}`) return send(403, { error: 'Invalid host.' });
    if (req.headers.origin && req.headers.origin !== origin) return send(403, { error: 'Invalid origin.' });
    const path = new URL(req.url, origin).pathname;
    if (req.method === 'GET' && path === '/download') {
      res.setHeader('Content-Disposition', 'attachment; filename="codex-account-dashboard-1.1.0.tgz"');
      return send(200, await readFile(join(base, 'dist', 'codex-account-dashboard-1.1.0.tgz')), 'application/gzip');
    }
    const pages = { '/': 'index.html', '/runs': 'runs.html' };
    // A picture of the user's choosing, if they have dropped one in. Kept in the
    // data folder rather than shipped: it is theirs, not the app's.
    if (req.method === 'GET' && path === '/runner') {
      for (const name of ['runner.gif', 'runner.png', 'runner.webp', 'runner.jpg']) {
        const picture = await readFile(join(root, name)).catch(() => null);
        if (!picture) continue;
        const type = name.endsWith('.gif') ? 'image/gif' : name.endsWith('.png') ? 'image/png'
          : name.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
        res.writeHead(200, { ...headers(type), 'Cache-Control': 'no-store', 'Content-Length': String(picture.length) });
        return res.end(picture);
      }
      return send(404, { error: 'No runner picture has been added.' });
    }
    // Audio needs a length and range support: without them the media element
    // waits on a chunked response it cannot measure, and never becomes ready.
    if (req.method === 'GET' && path === '/fahh.mp3') {
      const audio = await readFile(join(base, 'public', 'fahh.mp3'));
      const asked = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      const start = asked && asked[1] ? Number(asked[1]) : 0;
      const end = asked && asked[2] ? Math.min(Number(asked[2]), audio.length - 1) : audio.length - 1;
      const partial = !!asked && (start > 0 || end < audio.length - 1);
      if (start >= audio.length || start > end) {
        res.writeHead(416, { ...headers('audio/mpeg'), 'Content-Range': `bytes */${audio.length}` });
        return res.end();
      }
      const body = partial ? audio.subarray(start, end + 1) : audio;
      res.writeHead(partial ? 206 : 200, {
        ...headers('audio/mpeg'),
        'Cache-Control': 'private, max-age=31536000, immutable',
        'Accept-Ranges': 'bytes',
        'Content-Length': String(body.length),
        ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${audio.length}` } : {})
      });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    if (req.method === 'GET' && (pages[path] || ['/app.js', '/style.css', '/usage.css', '/runs.js', '/runs.css'].includes(path))) {
      const file = pages[path] || path.slice(1);
      return send(200, await readFile(join(base, 'public', file)), file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'text/css');
    }
    if (req.method === 'GET' && path === '/api/runs') {
      const { accounts, current } = await vault.list().catch(() => ({ accounts: [], current: null }));
      if (current && !accounts.some(a => a.id === current.id)) accounts.push(current);
      const chosen = await models.summary(runs.lastModelSeen).catch(() => ({}));
      const catalog = Object.entries(agents).map(([id, agent]) => ({
        id, label: agent.label, strength: agent.strength || null,
        model: chosen[id]?.model || null, effort: chosen[id]?.effort || null, source: chosen[id]?.source || null,
        efforts: agent.efforts || [], effortInModel: !!agent.effortInModel,
        planner: agent.planner !== false
      }));
      const runner = await readdir(root).then(files => files.some(f => /^runner\.(gif|png|webp|jpg)$/.test(f)), () => false);
      return send(200, { runs: runs.list(), agents: catalog, accounts, token: secret, runner });
    }
    // Names and hints only: a saved value never travels back to the page.
    if (req.method === 'GET' && path === '/api/secrets') {
      const asked = new URL(req.url, origin).searchParams.get('repo') || '';
      const repo = asked.trim() ? projectPath(asked) : '';
      return send(200, { repo, keys: repo ? await secrets.list(repo) : [], projects: await secrets.projects() });
    }
    if (req.method === 'GET' && path === '/api/models') {
      return send(200, { chosen: await models.summary(runs.lastModelSeen), suggestions: await models.suggestions() });
    }
    if (req.method === 'GET' && path === '/api/project') {
      const asked = new URL(req.url, origin).searchParams.get('repo') || '';
      if (!asked.trim()) return send(200, { git: false });
      return send(200, await runs.projectStatus(asked).catch(e => ({ git: false, error: e.message })));
    }
    if (req.method === 'GET' && path === '/api/runs/summary') return send(200, await runs.summariseAndExplain());
    if (req.method === 'GET' && path === '/api/runs/changes') {
      const query = new URL(req.url, origin).searchParams;
      return send(200, await runs.changes(query.get('id')));
    }
    if (req.method === 'GET' && path === '/api/runs/log') {
      const query = new URL(req.url, origin).searchParams;
      return send(200, await runs.log(query.get('id'), Number(query.get('from')) || 0));
    }
    if (req.method === 'GET' && path === '/api/state') {
      let warning = null;
      try { await vault.compatible(); } catch (e) { warning = e.message; }
      // Probing the other agents spawns processes, so it happens on a timer in
      // the background rather than on every poll of this endpoint.
      if (logins.stale()) void logins.refresh(agentLabels).catch(() => {});
      return send(200, { ...await vault.list(), login, token: secret, warning, usage: usage.entries, usageRefreshing: usage.refreshing, packageAvailable,
        logins: logins.entries, loginsCheckedAt: logins.checkedAt,
        agentUsage: await agentUsage(vault, usage.entries).catch(() => ({})) });
    }
    if (req.method !== 'POST') return send(404, { error: 'Not found.' });
    if (req.headers['x-dashboard-token'] !== secret || req.headers.origin !== origin)
      return send(403, { error: 'Reload the dashboard and try again.' });
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 32768) return send(413, { error: 'Request too large.' }); }
    const data = JSON.parse(body || '{}');
    // Agent runs last minutes, so they never take the account lock; without this
    // one running agent would freeze every other control on the dashboard.
    if (path === '/api/runs/start') return send(200, await runs.start(data));
    if (path === '/api/runs/stop') return send(200, await runs.stop(data.id));
    if (path === '/api/runs/remove') return send(200, await runs.remove(data.id, data.branch));
    if (path === '/api/runs/merge') return send(200, await runs.merge(data.id, { force: !!data.force }));
    if (path === '/api/runs/check') return send(200, await runs.check(data.id));
    if (path === '/api/runs/continue') return send(200, await runs.carryOn(data.id));
    if (path === '/api/runs/merge-all') return send(200, await runs.mergeAll({ force: !!data.force }));
    if (path === '/api/runs/push') return send(200, await runs.push(data.repo));
    if (path === '/api/runs/remove-finished') return send(200, await runs.removeFinished());
    if (path === '/api/models/set') return send(200, await models.set(data.agent, data.model, data.effort));
    if (path === '/api/secrets/set') return send(200, await secrets.set(projectPath(data.repo), data.name, data.value));
    if (path === '/api/secrets/remove') return send(200, await secrets.remove(projectPath(data.repo), String(data.name || '')));
    // Planning takes a minute of model time; it must not hold the account lock.
    if (path === '/api/runs/plan') return send(200, await runs.plan(data));
    // Also outside the account lock: it shells out to the other agents.
    if (path === '/api/logins') { logins.checkedAt = 0; return send(200, { logins: await logins.refresh(agentLabels) }); }
    if (busy) return send(409, { error: 'Another action is in progress.' });
    busy = true;
    try {
      if (path === '/api/usage') {
        if (Date.now() - lastUsageRequest < 30000) return send(200, { refreshing: usage.refreshing });
        await vault.compatible();
        lastUsageRequest = Date.now();
        void usage.refresh().catch(() => {});
        return send(202, { refreshing: true });
      }
      if (path === '/api/capture') return send(200, await vault.capture());
      if (path === '/api/forget') {
        const removed = await vault.forget(data.id);
        delete usage.entries[data.id];
        return send(200, removed);
      }
      if (path === '/api/login') return send(200, await startLogin());
      if (path === '/api/switch') {
        if (login?.status === 'pending') throw new Error('Finish adding the account before switching.');
        return send(200, await vault.switchTo(data.id));
      }
      return send(404, { error: 'Not found.' });
    } finally { busy = false; }
  } catch (e) { send(400, { error: e.code ? 'The local account file could not be read or saved.' : e.message }); }
});
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Master AI's port is already in use. Open ${origin}, or set DASHBOARD_PORT to another port.` : 'Unable to start Master AI.'); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => {
  console.log(`Master AI: ${origin}`);
  if (process.env.DASHBOARD_OPEN === '1') {
    const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
    const browser = spawn(command, [origin], { stdio: 'ignore' });
    browser.on('error', () => console.log('Open the address above in your browser.'));
  }
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  void runs.shutdown().finally(() => process.exit(0));
});
