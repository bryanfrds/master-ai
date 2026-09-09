import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe } from './vault.mjs';

export function normalizeUsage(result) {
  const buckets = result.rateLimitsByLimitId && Object.keys(result.rateLimitsByLimitId).length
    ? Object.entries(result.rateLimitsByLimitId) : result.rateLimits ? [[result.rateLimits.limitId || 'codex', result.rateLimits]] : [];
  return buckets.map(([id, bucket]) => ({
    id, name: bucket.limitName || id,
    windows: ['primary', 'secondary'].flatMap(key => {
      const w = bucket[key];
      if (!w || !Number.isFinite(w.usedPercent)) return [];
      return [{ key, remainingPercent: Math.max(0, Math.min(100, 100 - w.usedPercent)),
        durationMins: Number.isFinite(w.windowDurationMins) ? w.windowDurationMins : null,
        resetsAt: Number.isFinite(w.resetsAt) ? w.resetsAt : null }];
    })
  }));
}

// Codex may still be writing into its home as it exits, so deleting the
// scratch directory can fail. That must never become the usage result: a
// leftover directory is swept up on the next refresh.
export async function discard(path) {
  try {
    await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return true;
  } catch { return false; }
}

// Remove scratch directories left behind by earlier checks, including ones from
// a previous run of the dashboard. Recent ones are spared in case a second
// dashboard is mid-check against the same vault.
export const STALE_AFTER = 5 * 60 * 1000;
export async function sweep(root, now = Date.now()) {
  let removed = 0;
  for (const entry of await readdir(root).catch(() => [])) {
    if (!/^usage-/.test(entry)) continue;
    const path = join(root, entry);
    const age = await stat(path).then(s => now - s.mtimeMs, () => 0);
    if (age < STALE_AFTER) continue;
    if (await discard(path)) removed++;
  }
  return removed;
}

// Use only the existing access token. Never rotate a refresh token from a second process.
export async function fetchUsage(raw, root, executable = process.env.DASHBOARD_CODEX_BIN || 'codex') {
  const account = describe(raw);
  const { tokens } = JSON.parse(raw);
  const temp = await mkdtemp(join(root, 'usage-'));
  const child = spawn(executable, ['app-server', '--listen', 'stdio://'], {
    env: { ...process.env, CODEX_HOME: temp }, stdio: ['pipe', 'pipe', 'ignore']
  });
  let seq = 0;
  const pending = new Map();
  const fail = error => { for (const p of pending.values()) p.reject(error); pending.clear(); };
  const stopped = new Promise(resolve => child.once('close', resolve));
  child.on('error', () => fail(new Error('Codex could not start. Check your Codex installation.')));
  child.on('close', () => fail(new Error('Codex stopped before returning usage.')));
  child.stdin.on('error', () => fail(new Error('Could not communicate with Codex.')));
  const send = msg => child.stdin.write(`${JSON.stringify(msg)}\n`);
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.method && msg.id !== undefined) {
      send({ id: msg.id, error: { code: -32000, message: 'Reauthentication required.' } });
      fail(new Error('Login expired. Use this account in Codex, or add it again, then refresh usage.'));
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error('Usage unavailable. Check your connection, update Codex, or sign into this account again.'));
    else p.resolve(msg.result);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject }); send({ id, method, params });
  });
  const timer = setTimeout(() => { fail(new Error('Usage request timed out. Try refreshing again.')); child.kill(); }, 20000);
  try {
    await request('initialize', { clientInfo: { name: 'codex_account_dashboard', version: '1.1.0' }, capabilities: { experimentalApi: true } });
    send({ method: 'initialized', params: {} });
    await request('account/login/start', { type: 'chatgptAuthTokens', accessToken: tokens.access_token, chatgptAccountId: tokens.account_id });
    const buckets = normalizeUsage(await request('account/rateLimits/read', {}));
    return { buckets, checkedAt: Date.now(), error: buckets.some(b => b.windows.length) ? null : 'OpenAI did not return usage windows for this account.' };
  } finally {
    clearTimeout(timer); lines.close(); child.kill();
    const force = setTimeout(() => child.kill('SIGKILL'), 2000);
    await stopped; clearTimeout(force);
    await discard(temp);
  }
}

export class UsageCache {
  constructor(vault, loader = fetchUsage) { this.vault = vault; this.loader = loader; this.entries = {}; this.refreshing = false; }
  async refresh() {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      await sweep(this.vault.root);
      const { accounts, current } = await this.vault.list();
      if (current && !accounts.some(a => a.id === current.id)) accounts.push(current);
      for (const account of accounts) {
        try {
          const raw = await this.vault.rawFor(account.id);
          this.entries[account.id] = await this.loader(raw, this.vault.root);
        } catch (e) {
          this.entries[account.id] = { ...this.entries[account.id], error: e.message, attemptedAt: Date.now() };
        }
      }
    } finally { this.refreshing = false; }
  }
}
