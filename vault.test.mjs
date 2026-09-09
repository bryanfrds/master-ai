import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Vault, describe } from './vault.mjs';

function credential(name, refresh = 'initial') {
  const claims = { sub: name, email: `${name}@example.test`, 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } };
  return JSON.stringify({ tokens: { id_token: `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`, access_token: 'synthetic-access-token', refresh_token: refresh, account_id: `workspace-${name}` } });
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'codex-dashboard-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexDir = join(root, 'codex'); await mkdir(codexDir);
  const vault = new Vault(join(root, 'vault'), codexDir); await vault.init();
  return { root, codexDir, vault };
}
test('switch preserves outgoing refreshed credentials and can restore them', async t => {
  const { codexDir, vault } = await fixture(t);
  const a = await vault.save(credential('alice'));
  const b = await vault.save(credential('bob'));
  const latest = credential('alice', 'rotated-refresh');
  await writeFile(join(codexDir, 'auth.json'), latest);
  await vault.switchTo(b.id);
  assert.equal(describe(await vault.currentRaw()).id, b.id);
  assert.equal(await readFile(join(vault.root, `${a.id}.json`), 'utf8'), latest);
  assert.equal(await readFile(join(vault.root, 'previous-auth.backup'), 'utf8'), latest);
  await vault.switchTo(a.id);
  assert.equal(await vault.currentRaw(), latest);
  assert.equal((await stat(join(codexDir, 'auth.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(vault.root)).mode & 0o777, 0o700);
  assert.equal((await stat(join(vault.root, `${a.id}.json`))).mode & 0o777, 0o600);
});
test('selecting current account does not replace newer tokens with stale saved tokens', async t => {
  const { codexDir, vault } = await fixture(t);
  const a = await vault.save(credential('alice'));
  const latest = credential('alice', 'new-refresh');
  await writeFile(join(codexDir, 'auth.json'), latest);
  await vault.switchTo(a.id);
  assert.equal(await vault.currentRaw(), latest);
});
test('invalid target and incompatible config leave current auth unchanged', async t => {
  const { codexDir, vault } = await fixture(t);
  const original = credential('alice');
  await writeFile(join(codexDir, 'auth.json'), original);
  const b = await vault.save(credential('bob'));
  await assert.rejects(vault.switchTo('../auth'));
  await writeFile(join(codexDir, 'config.toml'), 'cli_auth_credentials_store = "keyring"');
  await assert.rejects(vault.switchTo(b.id), /file-based/);
  assert.equal(await vault.currentRaw(), original);
  await writeFile(join(codexDir, 'config.toml'), 'forced_chatgpt_workspace_id = "restricted"');
  await assert.rejects(vault.switchTo(b.id), /restricts/);
});
test('metadata never includes credential tokens and unsupported credentials are rejected', async t => {
  const { vault } = await fixture(t);
  await vault.save(credential('alice'));
  const output = JSON.stringify(await vault.list());
  assert.ok(!output.includes('synthetic-access-token'));
  assert.ok(!output.includes('refresh_token'));
  assert.throws(() => describe('{"OPENAI_API_KEY":"synthetic"}'), /ChatGPT login/);
});
test('HTTP dashboard enforces origin and mutation token; capture and switch work end to end', async t => {
  const { root, codexDir } = await fixture(t);
  await writeFile(join(codexDir, 'auth.json'), credential('alice'));
  const port = 24783;
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.mjs'], { cwd: import.meta.dirname, env: { ...process.env, CODEX_HOME: codexDir, DASHBOARD_DATA_DIR: join(root, 'http-vault'), DASHBOARD_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode !== null || child.signalCode !== null) return; const closed = new Promise(resolve => child.once('close', resolve)); child.kill(); await closed; });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', code => reject(new Error(`Server exited ${code}`))); setTimeout(() => reject(new Error('Server startup timed out')), 5000).unref(); });
  assert.equal((await fetch(origin)).status, 200);
  const state = await (await fetch(`${origin}/api/state`)).json();
  assert.equal(state.current.email, 'alice@example.test');
  assert.equal((await fetch(`${origin}/api/capture`, { method: 'POST', headers: { Origin: origin } })).status, 403);
  assert.equal((await fetch(`${origin}/api/state`, { headers: { Origin: 'https://untrusted.test' } })).status, 403);
  const post = (route, body) => fetch(`${origin}/api/${route}`, { method: 'POST', headers: { Origin: origin, 'X-Dashboard-Token': state.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('capture', {})).status, 200);
  const isolated = new Vault(join(root, 'http-vault'), codexDir);
  const bob = await isolated.save(credential('bob'));
  assert.equal((await post('switch', { id: bob.id })).status, 200);
  assert.equal(describe(await readFile(join(codexDir, 'auth.json'), 'utf8')).email, 'bob@example.test');

  // The alert sound: a media element stalls without a length and range support.
  const audio = await fetch(`${origin}/fahh.mp3`);
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get('content-type'), 'audio/mpeg');
  assert.equal(audio.headers.get('accept-ranges'), 'bytes');
  const length = Number(audio.headers.get('content-length'));
  assert.ok(length > 1000, 'the sound must be served with its length');
  assert.equal((await audio.arrayBuffer()).byteLength, length);

  const part = await fetch(`${origin}/fahh.mp3`, { headers: { Range: 'bytes=0-1023' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 0-1023/${length}`);
  assert.equal((await part.arrayBuffer()).byteLength, 1024);

  const past = await fetch(`${origin}/fahh.mp3`, { headers: { Range: `bytes=${length + 10}-` } });
  assert.equal(past.status, 416);
  // Audio has to be allowed by the policy that locks everything else down.
  assert.match(audio.headers.get('content-security-policy'), /media-src 'self'/);
});

test('forget deletes only the saved copy and reports whether it was in use', async t => {
  const { codexDir, vault } = await fixture(t);
  const alice = await vault.save(credential('alice'));
  const bob = await vault.save(credential('bob'));
  await writeFile(join(codexDir, 'auth.json'), credential('alice'));

  const gone = await vault.forget(bob.id);
  assert.equal(gone.email, 'bob@example.test');
  assert.equal(gone.selected, false);
  assert.deepEqual((await vault.list()).accounts.map(a => a.email), ['alice@example.test']);

  // Removing the account in use leaves the terminal logged in.
  const removed = await vault.forget(alice.id);
  assert.equal(removed.selected, true);
  assert.equal((await vault.list()).accounts.length, 0);
  assert.equal(describe(await vault.currentRaw()).email, 'alice@example.test');

  await assert.rejects(vault.forget(alice.id), /not saved on this computer/);
  await assert.rejects(vault.forget('../../etc/passwd'), /Invalid account/);
  await assert.rejects(vault.forget('nothex'), /Invalid account/);
});
