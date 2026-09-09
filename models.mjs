// Which model each agent should use. Kept here rather than in each CLI's own
// config so all four can be set in one place — except Codex, whose own config
// stays the source of truth when nothing is set here.
import { mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readOptional, privateWrite } from './vault.mjs';
import { agents } from './adapters.mjs';
import { run } from './runs.mjs';

const MAX_NAME = 120;

const SUGGESTION_TTL = 10 * 60 * 1000;

export function checkModel(model) {
  const name = String(model ?? '').trim();
  if (!name) return null;              // empty means: let the agent decide
  if (name.length > MAX_NAME) throw new Error('That model name is too long.');
  // Passed straight to a CLI as one argument; keep it to what a model id is.
  if (!/^[A-Za-z0-9._:@\/-]+$/.test(name))
    throw new Error('A model name can use letters, numbers and . _ : / - only.');
  return name;
}

// Each agent names its own levels; they do not agree with each other.
export function checkEffort(agent, effort) {
  const value = String(effort ?? '').trim();
  if (!value) return null;
  const allowed = agents[agent]?.efforts || [];
  if (!allowed.includes(value))
    throw new Error(allowed.length
      ? `${agents[agent].label} takes one of ${allowed.join(', ')}.`
      : `${agents[agent]?.label || agent} has no reasoning setting.`);
  return value;
}

// `devin models list` prints a family per block, with its id in brackets and
// any aliases underneath. The per-effort variants are too many to choose from,
// so the families are what gets offered.
export function parseDevinModels(text) {
  const found = [];
  for (const line of text.split('\n')) {
    const family = line.match(/^\S.*\(([A-Za-z0-9._:\/-]+)\)\s*$/);
    if (family) { found.push(family[1]); continue; }
    const aliases = line.match(/^\s+aliases:\s*(.+)$/);
    if (aliases) for (const alias of aliases[1].split(',')) {
      const name = alias.trim();
      if (name) found.push(name);
    }
  }
  return [...new Set(found)];
}

// Claude Code takes these names directly; there is no listing command.
const CLAUDE_MODELS = ['opus', 'sonnet', 'haiku'];

// What each CLI's own configuration says it will use, when it says anything.
// Read rather than assumed, so the dashboard agrees with the agent.
export async function configuredModel(agent, homes = {}) {
  const home = homes.home || homedir();
  if (agent === 'codex') {
    const config = await readOptional(join(homes.codexDir || join(home, '.codex'), 'config.toml')) || '';
    return {
      model: config.match(/^\s*model\s*=\s*["']([^"']+)["']/m)?.[1] || null,
      effort: config.match(/^\s*model_reasoning_effort\s*=\s*["']([^"']+)["']/m)?.[1] || null
    };
  }
  if (agent === 'hermes') {
    const config = await readOptional(join(homes.hermesDir || join(home, '.hermes'), 'config.yaml')) || '';
    // The model block names a default; the reasoning level sits beside it.
    const block = config.match(/^model:\n((?:[ \t]+.*\n)+)/m)?.[1] || '';
    return {
      model: block.match(/^[ \t]+default:\s*(\S+)/m)?.[1] || null,
      effort: config.match(/^[ \t]*reasoning_effort:\s*(\S+)/m)?.[1] || null
    };
  }
  if (agent === 'claude') {
    const raw = await readOptional(join(homes.claudeDir || join(home, '.claude'), 'settings.json'));
    if (!raw) return { model: null, effort: null };
    try {
      const settings = JSON.parse(raw).modelSettings || {};
      const named = Object.keys(settings);
      // Only when it names exactly one: more than that says nothing about which.
      if (named.length !== 1) return { model: null, effort: null };
      return { model: named[0], effort: settings[named[0]]?.effortLevel || null };
    } catch { return { model: null, effort: null }; }
  }
  return { model: null, effort: null };   // Devin keeps no model in its config
}

export class Models {
  constructor(root, codexDir) {
    this.file = join(root, 'models.json');
    this.root = root;
    this.codexDir = codexDir;
    this.suggestionCache = { at: 0, devin: [] };
  }
  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
  }

  async all() {
    const raw = await readOptional(this.file);
    if (!raw) return {};
    try {
      const saved = JSON.parse(raw);
      return saved && typeof saved === 'object' ? saved : {};
    } catch { return {}; }
  }

  async for(agent) {
    const saved = await this.all();
    return saved[agent] || { model: null, effort: null };
  }

  async set(agent, model, effort) {
    if (!agents[agent]) throw new Error('Choose a supported agent.');
    const saved = await this.all();
    const entry = { model: checkModel(model), effort: checkEffort(agent, effort) };
    if (!entry.model && !entry.effort) delete saved[agent];
    else saved[agent] = entry;
    await privateWrite(this.file, JSON.stringify(saved, null, 2));
    return { agent, ...entry };
  }

  async suggestions() {
    if (Date.now() - this.suggestionCache.at > SUGGESTION_TTL) {
      const listed = await run(process.env.DASHBOARD_DEVIN_BIN || 'devin', ['models', 'list']).catch(() => ({ code: -1, out: '' }));
      this.suggestionCache = { at: Date.now(), devin: listed.code === 0 ? parseDevinModels(listed.out) : [] };
    }
    return { claude: CLAUDE_MODELS, devin: this.suggestionCache.devin, codex: [], hermes: [] };
  }

  // What each agent will actually use, including where the setting came from:
  // chosen here, stated in the agent's own configuration, or neither.
  async summary(seen = {}) {
    const saved = await this.all();
    const entries = await Promise.all(Object.keys(agents).map(async agent => {
      const set = saved[agent] || {};
      if (set.model || set.effort)
        return [agent, { model: set.model || null, effort: set.effort || null, source: 'set here' }];
      const config = await configuredModel(agent, { codexDir: this.codexDir });
      if (config.model || config.effort)
        return [agent, { ...config, source: 'its own settings' }];
      if (seen[agent]) return [agent, { model: seen[agent], effort: null, source: 'the last run' }];
      return [agent, { model: null, effort: null, source: 'the agent default' }];
    }));
    return Object.fromEntries(entries);
  }

}
