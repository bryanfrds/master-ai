// Keys a project's code needs at runtime, typed into the dashboard once and
// handed to every agent that works on that project.
//
// Stored beside the Codex logins, with the same handling: 0700 directory, 0600
// files, and values that never travel back to the page once saved.
import { mkdir, chmod, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readOptional, privateWrite } from './vault.mjs';

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_VALUE = 8192;
const MAX_KEYS = 50;

export function checkName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('Give the key a name.');
  if (!NAME.test(trimmed))
    throw new Error('A key name can use letters, numbers and underscores, and cannot start with a number.');
  return trimmed;
}

export function checkValue(value) {
  const text = String(value ?? '');
  if (!text.trim()) throw new Error('Paste the value for this key.');
  if (text.length > MAX_VALUE) throw new Error('That value is too long to be a key.');
  // A newline would break the .env line it is written to, and no real key has one.
  if (/[\r\n]/.test(text)) throw new Error('A key cannot contain a line break.');
  return text;
}

// Shown instead of the value: enough to recognise a key, not enough to use it.
export function hint(value) {
  if (value.length <= 8) return `${'•'.repeat(value.length)}`;
  return `${value.slice(0, 3)}${'•'.repeat(6)}${value.slice(-3)}`;
}

// .env values are quoted so spaces and # survive being read back.
export function toEnvFile(entries) {
  return Object.entries(entries)
    .map(([name, value]) => `${name}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
    .join('\n') + '\n';
}

export class Secrets {
  constructor(root) { this.root = join(root, 'secrets'); }
  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
  }
  // Keyed by project path: one set of keys per project, not one global pile.
  file(repo) { return join(this.root, `${createHash('sha256').update(repo).digest('hex')}.json`); }

  async all(repo) {
    const raw = await readOptional(this.file(repo));
    if (!raw) return {};
    try {
      const saved = JSON.parse(raw);
      return saved && saved.repo === repo && saved.keys && typeof saved.keys === 'object' ? saved.keys : {};
    } catch { return {}; }
  }

  async list(repo) {
    const keys = await this.all(repo);
    return Object.entries(keys).map(([name, value]) => ({ name, hint: hint(value) }));
  }

  async set(repo, name, value) {
    const key = checkName(name);
    const secret = checkValue(value);
    const keys = await this.all(repo);
    if (!(key in keys) && Object.keys(keys).length >= MAX_KEYS) throw new Error(`A project can hold ${MAX_KEYS} keys.`);
    keys[key] = secret;
    await privateWrite(this.file(repo), JSON.stringify({ repo, keys }, null, 2));
    return { name: key, hint: hint(secret) };
  }

  async remove(repo, name) {
    const keys = await this.all(repo);
    if (!(name in keys)) throw new Error('That key is not saved for this project.');
    delete keys[name];
    if (Object.keys(keys).length) await privateWrite(this.file(repo), JSON.stringify({ repo, keys }, null, 2));
    else await rm(this.file(repo), { force: true });
    return { name };
  }

  // Projects the user has set keys for, so the page can say so before one is chosen.
  async projects() {
    const found = [];
    for (const entry of await readdir(this.root).catch(() => [])) {
      if (!/^[a-f0-9]{64}\.json$/.test(entry)) continue;
      const raw = await readOptional(join(this.root, entry));
      try {
        const saved = JSON.parse(raw);
        if (saved?.repo) found.push({ repo: saved.repo, count: Object.keys(saved.keys || {}).length });
      } catch { /* skip an unreadable file */ }
    }
    return found;
  }
}
