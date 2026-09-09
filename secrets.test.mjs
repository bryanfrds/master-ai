import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Secrets, checkName, checkValue, hint, toEnvFile } from './secrets.mjs';

async function store(t) {
  const root = await mkdtemp(join(tmpdir(), 'secrets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secrets = new Secrets(root);
  await secrets.init();
  return { root, secrets };
}

test('key names are checked, and values are refused when unusable', () => {
  assert.equal(checkName(' OPENAI_API_KEY '), 'OPENAI_API_KEY');
  assert.throws(() => checkName(''), /Give the key a name/);
  assert.throws(() => checkName('2FAST'), /cannot start with a number/);
  assert.throws(() => checkName('has space'), /letters, numbers and underscores/);
  assert.throws(() => checkValue('   '), /Paste the value/);
  // A line break would break the .env line it is written to.
  assert.throws(() => checkValue('one\ntwo'), /line break/);
  assert.throws(() => checkValue('x'.repeat(9000)), /too long/);
});

test('a hint identifies a key without giving it away', () => {
  assert.equal(hint('sk-ant-api03-abcdefghijklmnop'), 'sk-••••••nop');
  assert.equal(hint('short'), '•••••');
  assert.equal(hint('sk-ant-api03-abcdefghijklmnop').includes('api03'), false);
});

test('quoting survives a round trip through a .env file', () => {
  const written = toEnvFile({ A: 'plain', B: 'has "quotes" and \\ slash', C: 'has # hash and spaces' });
  assert.match(written, /^A="plain"$/m);
  assert.match(written, /^B="has \\"quotes\\" and \\\\ slash"$/m);
  assert.match(written, /^C="has # hash and spaces"$/m);
});

test('keys are stored per project and never handed back', async t => {
  const { secrets } = await store(t);
  const shop = '/projects/shop';
  const blog = '/projects/blog';
  await secrets.set(shop, 'OPENAI_API_KEY', 'sk-shop-secret-value');
  await secrets.set(blog, 'OPENAI_API_KEY', 'sk-blog-secret-value');

  const listed = await secrets.list(shop);
  assert.deepEqual(listed, [{ name: 'OPENAI_API_KEY', hint: 'sk-••••••lue' }]);
  assert.equal(JSON.stringify(listed).includes('shop-secret'), false, 'a listing must not carry the value');
  // Only the agent-facing read returns the real thing.
  assert.equal((await secrets.all(shop)).OPENAI_API_KEY, 'sk-shop-secret-value');
  assert.equal((await secrets.all(blog)).OPENAI_API_KEY, 'sk-blog-secret-value');
  assert.deepEqual(await secrets.all('/projects/unknown'), {});
});

test('saved keys are written as private files', async t => {
  const { root, secrets } = await store(t);
  await secrets.set('/projects/shop', 'TOKEN', 'value');
  assert.equal((await stat(join(root, 'secrets'))).mode & 0o777, 0o700);
  const [file] = await readdir(join(root, 'secrets'));
  assert.equal((await stat(join(root, 'secrets', file))).mode & 0o777, 0o600);
  // The file name must not be the project path in the clear.
  assert.match(file, /^[a-f0-9]{64}\.json$/);
});

test('keys can be replaced and removed, and the file goes with the last one', async t => {
  const { root, secrets } = await store(t);
  const repo = '/projects/shop';
  await secrets.set(repo, 'A', 'first');
  await secrets.set(repo, 'A', 'second');
  assert.equal((await secrets.all(repo)).A, 'second', 'saving again replaces rather than duplicates');

  await secrets.set(repo, 'B', 'other');
  await secrets.remove(repo, 'A');
  assert.deepEqual(Object.keys(await secrets.all(repo)), ['B']);
  await assert.rejects(secrets.remove(repo, 'A'), /not saved for this project/);

  await secrets.remove(repo, 'B');
  assert.deepEqual(await readdir(join(root, 'secrets')), [], 'no empty leftovers');
});

test('projects with keys can be listed without their values', async t => {
  const { secrets } = await store(t);
  await secrets.set('/projects/shop', 'A', 'one');
  await secrets.set('/projects/shop', 'B', 'two');
  await secrets.set('/projects/blog', 'C', 'three');
  const projects = (await secrets.projects()).sort((a, b) => a.repo.localeCompare(b.repo));
  assert.deepEqual(projects, [{ repo: '/projects/blog', count: 1 }, { repo: '/projects/shop', count: 2 }]);
  assert.equal(JSON.stringify(projects).includes('three'), false);
});
