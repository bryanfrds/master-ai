import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redact, parseHermes, probeClaude, probeCodex, probeDevin, probeHermes, Logins } from './logins.mjs';

const runner = (out, code = 0, err = '') => async () => ({ code, out, err });

test('anything key-shaped is stripped before it can reach the page', () => {
  assert.equal(redact('sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), '…');
  assert.equal(redact('bryan@example.com id=bca76d'), 'bryan@example.com');
  assert.equal(redact('short ok'), 'short ok');
});

test('claude is read from its own config, with the plan named', async t => {
  const home = await mkdtemp(join(tmpdir(), 'logins-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, '.claude.json'), JSON.stringify({
    oauthAccount: { emailAddress: 'someone@example.test', organizationType: 'claude_max' }
  }));
  assert.deepEqual(await probeClaude(home), { signedIn: true, account: 'someone@example.test', detail: 'Max plan' });

  await writeFile(join(home, '.claude.json'), 'not json');
  const broken = await probeClaude(home);
  assert.equal(broken.signedIn, false);
  assert.match(broken.detail, /Not signed in/);
});

test('codex reports the selected login and how many are saved', async () => {
  const vault = { list: async () => ({ current: { email: 'a@example.test', plan: 'team' }, accounts: [1, 2, 3] }) };
  assert.deepEqual(await probeCodex(vault), { signedIn: true, account: 'a@example.test', detail: 'team · 3 saved here' });
  const empty = { list: async () => ({ current: null, accounts: [] }) };
  assert.equal((await probeCodex(empty)).signedIn, false);
});

test('devin is read from its status output', async () => {
  const inn = await probeDevin(runner('Logged in (via Devin).\n  Account: person@example.test\n'));
  assert.deepEqual(inn, { signedIn: true, account: 'person@example.test', detail: 'via Devin' });
  // "Not logged in" must not read as logged in.
  assert.equal((await probeDevin(runner('Not logged in.'))).signedIn, false);
  assert.equal((await probeDevin(runner('You are not logged in to Devin.'))).signedIn, false);
  // A missing binary is a state, not a crash.
  assert.match((await probeDevin(runner('', -1, 'ENOENT'))).detail, /Not installed/);
});

test('hermes credentials are listed by provider without their ids', async () => {
  const output = [
    'copilot (1 credentials):',
    '  #1  gh auth token        api_key id=bca76d priority=0 gh_cli ←',
    '',
    'nous (1 credentials):',
    '  #1  person@example.test oauth   id=838f64 priority=0 device_code ←'
  ].join('\n');
  const providers = parseHermes(output);
  assert.deepEqual(providers.map(p => p.name), ['copilot', 'nous']);
  assert.ok(providers[1].identities[0].includes('person@example.test'));
  assert.ok(!JSON.stringify(providers).includes('838f64'), 'credential ids must not survive');

  const probed = await probeHermes(runner(output));
  assert.equal(probed.account, 'person@example.test');
  assert.equal(probed.detail, 'copilot, nous');
  assert.match((await probeHermes(runner('', -1)))?.detail, /Not installed/);
});

test('one failing probe does not take the others down', async () => {
  const logins = new Logins(null, {
    good: async () => ({ signedIn: true, account: 'ok@example.test', detail: 'fine' }),
    bad: async () => { throw new Error('devin exploded'); }
  });
  const entries = await logins.refresh({ good: 'Good' });
  assert.equal(entries.length, 2);
  assert.equal(entries[0].label, 'Good');
  assert.equal(entries[1].signedIn, false);
  assert.equal(entries[1].detail, 'devin exploded');
  assert.equal(logins.stale(), false);
  assert.equal(logins.stale(Date.now() + 120000), true);
});

test('the codex model is read from the config the runs actually use', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codexcfg-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { codexModel } = await import('./logins.mjs');

  assert.equal(await codexModel(dir), null, 'no config means nothing to claim');
  await writeFile(join(dir, 'config.toml'), 'model = "gpt-5.6-luna"\nmodel_reasoning_effort = "medium"\n');
  assert.equal(await codexModel(dir), 'gpt-5.6-luna · medium');
  await writeFile(join(dir, 'config.toml'), "model = 'o3'\n");
  assert.equal(await codexModel(dir), 'o3', 'the effort is optional');
  // A commented-out setting is not a setting.
  await writeFile(join(dir, 'config.toml'), '# model = "ignored"\nmodel = "real"\n');
  assert.equal(await codexModel(dir), 'real');
});

test('Claude Code plan limits are read from what it recorded', async () => {
  const { claudeUsage } = await import('./logins.mjs');
  const raw = JSON.stringify({
    cachedUsageUtilization: {
      fetchedAtMs: 1788536028756,
      utilization: {
        five_hour: { utilization: 3, resets_at: '2026-09-04T19:29:59.550571+00:00' },
        seven_day: { utilization: 15, resets_at: '2026-09-06T07:59:59.550589+00:00' },
        seven_day_opus: null
      }
    }
  });
  const usage = claudeUsage(raw);
  assert.equal(usage.checkedAt, 1788536028756);
  // Reported as remaining, matching how Codex usage already reads.
  assert.deepEqual(usage.buckets[0].windows.map(w => [w.key, w.remainingPercent, w.durationMins]),
    [['primary', 97, 300], ['secondary', 85, 10080]]);
  assert.equal(typeof usage.buckets[0].windows[0].resetsAt, 'number');

  // Nothing recorded yet, and nothing invented.
  assert.equal(claudeUsage('{}'), null);
  assert.equal(claudeUsage('not json'), null);
  assert.equal(claudeUsage(JSON.stringify({ cachedUsageUtilization: { utilization: { five_hour: null } } })), null);
});

test('agents that report no limits say so rather than showing nothing', async t => {
  const { agentUsage } = await import('./logins.mjs');
  const home = await mkdtemp(join(tmpdir(), 'usage-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = { list: async () => ({ current: { id: 'a', email: 'a@example.test' }, accounts: [] }) };

  const usage = await agentUsage(vault, { a: { buckets: [{ id: 'codex', windows: [] }], checkedAt: 1 } }, home);
  assert.match(usage.devin.note, /does not report/);
  assert.match(usage.hermes.note, /does not report/);
  assert.deepEqual(usage.devin.buckets, []);
  // No Claude config in this home, so it says that rather than claiming a figure.
  assert.match(usage.claude.note, /not recorded/);
  assert.equal(usage.codex.note, 'For a@example.test');
});
