// Who each agent is signed in as. Read-only: Codex is the one this dashboard
// can switch, and the rest are reported so the whole set is visible in one
// place rather than four terminal commands.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readOptional } from './vault.mjs';
import { run } from './runs.mjs';

const CACHE_MS = 60_000;

// Credentials must never reach the page. Identities are shown; anything that
// looks like a key, token, or opaque id is not.
export function redact(text) {
  return String(text)
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '…')
    .replace(/\bid=[A-Za-z0-9]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const plans = {
  claude_max: 'Max', claude_pro: 'Pro', claude_team: 'Team', claude_enterprise: 'Enterprise'
};

export async function probeClaude(home = homedir()) {
  const raw = await readOptional(join(home, '.claude.json'));
  const account = raw && (() => { try { return JSON.parse(raw).oauthAccount; } catch { return null; } })();
  if (account?.emailAddress) {
    const plan = plans[account.organizationType] || account.organizationType || null;
    return { signedIn: true, account: account.emailAddress, detail: plan ? `${plan} plan` : 'Signed in' };
  }
  if (process.env.ANTHROPIC_API_KEY) return { signedIn: true, account: 'API key', detail: 'From ANTHROPIC_API_KEY' };
  return { signedIn: false, account: null, detail: 'Not signed in. Run claude in a terminal.' };
}

export async function probeCodex(vault) {
  const { current, accounts } = await vault.list().catch(() => ({ current: null, accounts: [] }));
  const saved = accounts.length;
  if (!current) return { signedIn: false, account: null, detail: saved ? `${saved} saved, none selected` : 'Not signed in. Use Add account.' };
  return { signedIn: true, account: current.email, detail: `${current.plan} · ${saved} saved here` };
}

export async function probeDevin(runner = run) {
  const result = await runner(process.env.DASHBOARD_DEVIN_BIN || 'devin', ['auth', 'status']);
  if (result.code === -1) return { signedIn: false, account: null, detail: 'Not installed.' };
  const text = `${result.out}\n${result.err}`;
  // Anchored: a plain /logged in/ also matches "Not logged in".
  if (!/(^|\n)\s*logged in/i.test(text)) return { signedIn: false, account: null, detail: 'Not signed in. Run devin auth login.' };
  const via = text.match(/logged in\s*\(via ([^)]+)\)/i)?.[1];
  const email = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0];
  return { signedIn: true, account: email || 'Signed in', detail: via ? `via ${via}` : 'Signed in' };
}

// hermes auth list prints one block per provider; the entry marked with an
// arrow is the one in use.
export function parseHermes(text) {
  const providers = [];
  let provider = null;
  for (const line of text.split('\n')) {
    const header = line.match(/^(\S+)\s+\((\d+) credential/);
    if (header) { provider = { name: header[1], identities: [] }; providers.push(provider); continue; }
    const entry = line.match(/^\s+#\d+\s+(.+)$/);
    if (entry && provider) {
      const identity = redact(entry[1].replace(/[←*]\s*$/, ''))
        .replace(/\b(oauth|api_key|device_code|gh_cli|priority=\d+)\b/g, '').replace(/\s{2,}/g, ' ').trim();
      if (identity) provider.identities.push(identity);
    }
  }
  return providers;
}

export async function probeHermes(runner = run) {
  const result = await runner(process.env.DASHBOARD_HERMES_BIN || 'hermes', ['auth', 'list']);
  if (result.code === -1) return { signedIn: false, account: null, detail: 'Not installed.' };
  const providers = parseHermes(`${result.out}\n${result.err}`);
  if (!providers.length) return { signedIn: false, account: null, detail: 'No credentials. Run hermes auth add.' };
  const named = providers.find(p => p.identities.some(i => i.includes('@')));
  const account = named?.identities.find(i => i.includes('@')) || providers[0].identities[0] || 'Signed in';
  return { signedIn: true, account, detail: providers.map(p => p.name).join(', ') };
}

// Which model Codex will actually use. Read from the user's own config rather
// than pinned here: the dashboard copies that config into each run, so this is
// the same setting the agent sees, and it stays right when they change it.
export async function codexModel(codexDir) {
  const config = await readOptional(join(codexDir, 'config.toml')) || '';
  const model = config.match(/^\s*model\s*=\s*["']([^"']+)["']/m)?.[1] || null;
  const effort = config.match(/^\s*model_reasoning_effort\s*=\s*["']([^"']+)["']/m)?.[1] || null;
  if (!model) return null;
  return effort ? `${model} · ${effort}` : model;
}

// Claude Code keeps its plan limits in its own config, refreshed whenever it
// runs. Read rather than asked for: there is no command that reports them, and
// starting a session just to find out would spend some of the very thing being
// measured.
export function claudeUsage(raw) {
  let cached;
  try { cached = JSON.parse(raw)?.cachedUsageUtilization; } catch { return null; }
  if (!cached?.utilization) return null;
  const windows = [
    ['five_hour', 'primary', 300],
    ['seven_day', 'secondary', 10080]
  ].flatMap(([name, key, durationMins]) => {
    const window = cached.utilization[name];
    if (!window || !Number.isFinite(window.utilization)) return [];
    const resets = window.resets_at ? Date.parse(window.resets_at) : NaN;
    return [{
      key,
      remainingPercent: Math.max(0, Math.min(100, 100 - window.utilization)),
      durationMins,
      resetsAt: Number.isFinite(resets) ? Math.round(resets / 1000) : null
    }];
  });
  if (!windows.length) return null;
  return {
    buckets: [{ id: 'claude', name: 'claude', windows }],
    checkedAt: Number.isFinite(cached.fetchedAtMs) ? cached.fetchedAtMs : null
  };
}

// What each agent can say about its own limits. Only two of the four can say
// anything, and one of those is a reading taken when it last ran.
export async function agentUsage(vault, usageEntries, home = homedir()) {
  const claude = claudeUsage(await readOptional(join(home, '.claude.json')) || '');
  const { current } = await vault.list().catch(() => ({ current: null }));
  const codex = current ? usageEntries[current.id] : null;
  return {
    claude: claude
      ? { ...claude, note: 'As of when Claude Code last ran' }
      : { buckets: [], checkedAt: null, note: 'Claude Code has not recorded its limits yet' },
    codex: codex
      ? { buckets: codex.buckets || [], checkedAt: codex.checkedAt || null, error: codex.error || null, note: current ? `For ${current.email}` : null }
      : { buckets: [], checkedAt: null, note: 'Not checked yet' },
    devin: { buckets: [], checkedAt: null, note: 'Devin does not report usage limits' },
    hermes: { buckets: [], checkedAt: null, note: 'Hermes does not report usage limits' }
  };
}

export class Logins {
  constructor(vault, probes) {
    this.vault = vault;
    this.entries = [];
    this.checkedAt = 0;
    this.refreshing = false;
    this.probes = probes || {
      claude: () => probeClaude(),
      codex: () => probeCodex(this.vault),
      devin: () => probeDevin(),
      hermes: () => probeHermes()
    };
  }
  stale(now = Date.now()) { return now - this.checkedAt > CACHE_MS; }
  async refresh(labels = {}) {
    if (this.refreshing) return this.entries;
    this.refreshing = true;
    try {
      // In parallel: devin and hermes each spawn a process that takes a moment.
      this.entries = await Promise.all(Object.entries(this.probes).map(async ([id, probe]) => {
        const result = await probe().catch(e => ({ signedIn: false, account: null, detail: e.message }));
        return { id, label: labels[id] || id, ...result, account: result.account ? redact(result.account) : null };
      }));
      this.checkedAt = Date.now();
      return this.entries;
    } finally { this.refreshing = false; }
  }
}
