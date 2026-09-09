import { readFile, mkdir, chmod, writeFile, rename, readdir, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export async function readOptional(path) {
  try { return await readFile(path, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export function describe(raw) {
  let auth, claims;
  try {
    auth = JSON.parse(raw);
    claims = JSON.parse(Buffer.from(auth.tokens.id_token.split('.')[1], 'base64url'));
  } catch { throw new Error('A saved ChatGPT login is required. API-key logins are not supported here.'); }
  if (!auth.tokens.access_token || !auth.tokens.refresh_token || !claims.sub || !auth.tokens.account_id)
    throw new Error('The ChatGPT login is incomplete. Sign in again.');
  const identity = `${claims.sub}:${auth.tokens.account_id}`;
  return {
    id: createHash('sha256').update(identity).digest('hex'),
    email: claims.email || 'ChatGPT account',
    plan: claims['https://api.openai.com/auth']?.chatgpt_plan_type || 'ChatGPT',
    workspace: auth.tokens.account_id.slice(-8)
  };
}
export async function privateWrite(path, text) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, text, { mode: 0o600, flag: 'wx' });
  await rename(tmp, path);
}
export class Vault {
  constructor(root, codexDir) { this.root = root; this.codexDir = codexDir; }
  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
  }
  async compatible() {
    const config = await readOptional(join(this.codexDir, 'config.toml')) || '';
    if (/^\s*cli_auth_credentials_store\s*=\s*["'](?:keyring|auto)["']/m.test(config))
      throw new Error('This dashboard requires file-based Codex credentials. Your config selects keyring or auto storage.');
    if (/^\s*forced_(?:login_method|chatgpt_workspace_id)\s*=/m.test(config))
      throw new Error('Your Codex configuration restricts accounts. Account switching is disabled.');
  }
  async currentRaw() { return readOptional(join(this.codexDir, 'auth.json')); }
  async rawFor(id) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid account.');
    const current = await this.currentRaw();
    if (current && describe(current).id === id) return current;
    const saved = await readFile(join(this.root, `${id}.json`), 'utf8');
    if (describe(saved).id !== id) throw new Error('Saved account identity does not match.');
    return saved;
  }
  async save(raw) {
    const account = describe(raw);
    await privateWrite(join(this.root, `${account.id}.json`), raw);
    return account;
  }
  async list() {
    const currentRaw = await this.currentRaw();
    let current = null;
    try { if (currentRaw) current = describe(currentRaw); } catch { /* unsupported login */ }
    const accounts = [];
    for (const file of await readdir(this.root)) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      accounts.push(describe(await readFile(join(this.root, file), 'utf8')));
    }
    return { current, accounts };
  }
  async capture() {
    await this.compatible();
    const raw = await this.currentRaw();
    if (!raw) throw new Error('No current login found. Use Add account.');
    return this.save(raw);
  }
  async forget(id) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid account.');
    const raw = await readOptional(join(this.root, `${id}.json`));
    if (!raw) throw new Error('That account is not saved on this computer.');
    const account = describe(raw);
    await rm(join(this.root, `${id}.json`), { force: true });
    // Removing the saved copy of the account the terminal is using does not log
    // it out: those credentials live in the Codex home, which is left alone.
    const current = await this.currentRaw();
    let selected = false;
    try { selected = !!current && describe(current).id === id; } catch { /* unsupported login */ }
    return { ...account, selected };
  }

  async switchTo(id) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid account.');
    await this.compatible();
    const selected = await readFile(join(this.root, `${id}.json`), 'utf8');
    const account = describe(selected);
    if (account.id !== id) throw new Error('Saved account does not match its identity.');
    const current = await this.currentRaw();
    if (current && describe(current).id === id) return account; // Never restore an older refresh token.
    const authPath = join(this.codexDir, 'auth.json');
    try { if ((await lstat(authPath)).isSymbolicLink()) throw new Error('Symlinked auth files are not supported.'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (current) {
      await this.save(current); // Preserve the outgoing account's latest refreshed tokens.
      await privateWrite(join(this.root, 'previous-auth.backup'), current);
    }
    await mkdir(this.codexDir, { recursive: true, mode: 0o700 });
    await privateWrite(authPath, selected);
    return account;
  }
}
