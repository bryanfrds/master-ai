import { mkdtemp, mkdir, chmod, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsage, UsageCache, discard, sweep, STALE_AFTER } from './usage.mjs';

test('usage supports multiple buckets, missing windows, and zero remaining', () => {
  const buckets = normalizeUsage({ rateLimitsByLimitId: {
    codex: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 12345 }, secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 23456 } },
    special: { limitName: 'Special model', primary: { usedPercent: 120 }, secondary: null }
  } });
  assert.equal(buckets[0].windows[0].remainingPercent, 0);
  assert.equal(buckets[0].windows[1].remainingPercent, 88);
  assert.equal(buckets[0].windows[1].durationMins, 10080);
  assert.equal(buckets[1].name, 'Special model');
  assert.equal(buckets[1].windows[0].remainingPercent, 0);
  assert.equal(buckets[1].windows[0].resetsAt, null);
  assert.deepEqual(normalizeUsage({}), []);
  assert.deepEqual(normalizeUsage({ rateLimits: { primary: { usedPercent: null } } })[0].windows, []);
  assert.equal(normalizeUsage({ rateLimits: { primary: { usedPercent: 25 } } })[0].windows[0].remainingPercent, 75);
});
test('failed refresh retains timestamp and marks previous usage as stale', async () => {
  let fail = false;
  const vault = { root: '/unused', list: async () => ({ current: { id: 'a' }, accounts: [] }), rawFor: async id => id };
  const cache = new UsageCache(vault, async () => { if (fail) throw new Error('Login expired.'); return { checkedAt: 123, buckets: [{ id: 'codex', windows: [] }], error: null }; });
  await cache.refresh(); fail = true; await cache.refresh();
  assert.equal(cache.entries.a.checkedAt, 123);
  assert.equal(cache.entries.a.error, 'Login expired.');
  assert.equal(cache.refreshing, false);
});
test('overlapping usage refreshes are coalesced', async () => {
  let finish, calls = 0;
  const cache = new UsageCache({ root: '/unused', list: async () => ({ accounts: [{ id: 'a' }] }), rawFor: async () => 'a' }, async () => { calls++; await new Promise(resolve => { finish = resolve; }); return {}; });
  const first = cache.refresh();
  // Wait for the loader to actually be reached rather than assuming how many
  // ticks refresh takes to get there.
  while (calls === 0) await new Promise(resolve => setImmediate(resolve));
  await cache.refresh();
  assert.equal(calls, 1, 'a refresh already in flight must not start a second one');
  finish(); await first;
});

test('a scratch directory that will not delete never becomes the usage result', async t => {
  const root = await mkdtemp(join(tmpdir(), 'usage-sweep-'));
  t.after(async () => { await chmod(root, 0o700).catch(() => {}); await rm(root, { recursive: true, force: true }); });

  const stuck = join(root, 'usage-stuck');
  await mkdir(join(stuck, 'inner'), { recursive: true });
  await writeFile(join(stuck, 'inner', 'file'), 'x');
  await chmod(root, 0o500);           // read-only parent: the directory cannot be removed
  assert.equal(await discard(stuck), false, 'discard reports failure instead of throwing');
  await chmod(root, 0o700);
  assert.equal(await discard(stuck), true);
});

test('sweep clears stale scratch directories and spares fresh ones', async t => {
  const root = await mkdtemp(join(tmpdir(), 'usage-sweep-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'usage-old'));
  await mkdir(join(root, 'usage-new'));
  await mkdir(join(root, 'keep-me'));
  await writeFile(join(root, 'account.json'), '{}');

  assert.equal(await sweep(root, Date.now() + STALE_AFTER + 1000), 2);
  const left = (await readdir(root)).sort();
  assert.deepEqual(left, ['account.json', 'keep-me']);

  await mkdir(join(root, 'usage-fresh'));
  assert.equal(await sweep(root), 0, 'a check that may still be running is left alone');
});
