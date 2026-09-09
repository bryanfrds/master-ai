import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile, chmod, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runs, run, parseDiff, parsePlan, splitPatch } from './runs.mjs';
import { Secrets } from './secrets.mjs';

// A stand-in for the real CLI. It writes a file and prints the same
// stream-json Claude Code prints, so no account or network is involved.
const FAKE = `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync('added.txt', 'from the agent\\n');
const line = value => console.log(JSON.stringify(value));
line({ type: 'system', subtype: 'init', model: 'test-model' });
line({ type: 'assistant', message: { content: [
  { type: 'text', text: 'Writing the file.' },
  { type: 'tool_use', name: 'Write', input: { file_path: process.cwd() + '/added.txt' } }
] } });
line({ type: 'result', subtype: 'success', result: 'All done.', num_turns: 1 });
if (process.env.FAKE_FAIL) { console.error('the agent could not finish'); process.exit(3); }
`;

async function workspace() {
  const base = await mkdtemp(join(tmpdir(), 'runs-test-'));
  const repo = join(base, 'repo');
  await mkdir(repo);
  for (const args of [['init', '-b', 'main'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 'Test']])
    await run('git', ['-C', repo, ...args]);
  await writeFile(join(repo, 'README.md'), 'start\n');
  await run('git', ['-C', repo, 'add', '.']);
  await run('git', ['-C', repo, 'commit', '-m', 'first']);
  const binary = join(base, 'fake-agent.mjs');
  await writeFile(binary, FAKE);
  await chmod(binary, 0o755);
  process.env.DASHBOARD_CLAUDE_BIN = binary;
  const runs = new Runs(join(base, 'runs'), { rawFor: async () => { throw new Error('unused'); }, codexDir: base, save: async () => {} });
  await runs.init();
  return { base, repo, runs, cleanup: () => rm(base, { recursive: true, force: true }) };
}

// 'waiting' is not finished: a queued run has not started yet.
const BUSY = new Set(['running', 'waiting']);
const settle = async (runs, id) => {
  for (let i = 0; i < 400; i++) {
    if (!BUSY.has(runs.runs.get(id).status)) return runs.runs.get(id);
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error('the run never finished');
};

test('parseDiff counts changed lines and untracked files', () => {
  assert.deepEqual(parseDiff('3\t1\tsrc/a.js\n0\t4\tsrc/b.js\n', 'new.txt\n'), { files: 3, added: 3, removed: 5 });
  assert.deepEqual(parseDiff('', ''), { files: 0, added: 0, removed: 0 });
  assert.deepEqual(parseDiff('-\t-\tlogo.png\n', ''), { files: 1, added: 0, removed: 0 });
});

test('a run works in its own branch and leaves the project untouched', async t => {
  const { repo, runs, cleanup } = await workspace();
  t.after(cleanup);
  const { id } = await runs.start({ agent: 'claude', prompt: 'write a file', repo });
  const record = await settle(runs, id);

  assert.equal(record.status, 'done');
  assert.match(record.branch, /^agents\/claude-/);
  assert.notEqual(record.dir, repo);
  assert.deepEqual(record.files, ['added.txt']);
  assert.equal(record.diff.files, 1);
  assert.equal(await readFile(join(record.dir, 'added.txt'), 'utf8'), 'from the agent\n');
  // The original checkout must not have gained the agent's file.
  assert.equal((await run('git', ['-C', repo, 'status', '--porcelain'])).out, '');

  const log = await runs.log(id);
  // Paths arrive absolute; the log shows them relative to the agent's worktree.
  const write = log.events.find(e => e.kind === 'file');
  assert.equal(write.file, 'added.txt');
  assert.equal(write.text, 'Write · added.txt');
  assert.deepEqual(log.events.map(e => e.kind), ['status', 'status', 'message', 'file', 'status', 'status']);
  assert.equal(log.events.at(-1).text, 'Run complete.');
  assert.deepEqual((await runs.log(id, log.seq)).events, []);
});

test('the work is committed on the branch so it can be merged', async t => {
  const { repo, runs, cleanup } = await workspace();
  t.after(cleanup);
  const { id } = await runs.start({ agent: 'claude', prompt: 'write a file', repo });
  const record = await settle(runs, id);
  assert.ok(record.commit, 'the run should record a commit');
  assert.equal(record.commitError, null);
  // The diff still describes the work, rather than resetting once committed,
  // and a newly created file is counted by its lines rather than just its name.
  assert.deepEqual(record.diff, { files: 1, added: 1, removed: 0 });
  const log = await run('git', ['-C', repo, 'log', '--format=%s', '-1', record.branch]);
  assert.equal(log.out.trim(), 'claude: write a file');
  const changed = await run('git', ['-C', repo, 'diff', '--name-only', `main..${record.branch}`]);
  assert.equal(changed.out.trim(), 'added.txt');
  assert.equal((await run('git', ['-C', record.dir, 'status', '--porcelain'])).out, '');
});

test('working in the folder itself never commits the user\'s own changes', async t => {
  const { base, runs, cleanup } = await workspace();
  t.after(cleanup);
  const plain = join(base, 'own');
  await mkdir(plain);
  for (const args of [['init', '-b', 'main'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 'Test']])
    await run('git', ['-C', plain, ...args]);
  await writeFile(join(plain, 'README.md'), 'start\n');
  await run('git', ['-C', plain, 'add', '.']);
  await run('git', ['-C', plain, 'commit', '-m', 'first']);
  await writeFile(join(plain, 'my-work-in-progress.txt'), 'do not commit this\n');

  const { id } = await runs.start({ agent: 'claude', prompt: 'x', repo: plain, worktree: false });
  const record = await settle(runs, id);
  assert.equal(record.commit, null);
  const status = (await run('git', ['-C', plain, 'status', '--porcelain'])).out;
  assert.match(status, /my-work-in-progress\.txt/);
  assert.equal((await run('git', ['-C', plain, 'log', '--oneline'])).out.trim().split('\n').length, 1);
});

test('a failing agent is reported with the reason it gave', async t => {
  const { repo, runs, cleanup } = await workspace();
  t.after(cleanup);
  process.env.FAKE_FAIL = '1';
  t.after(() => { delete process.env.FAKE_FAIL; });
  const { id } = await runs.start({ agent: 'claude', prompt: 'fail please', repo });
  const record = await settle(runs, id);
  assert.equal(record.status, 'failed');
  assert.equal(record.error, 'the agent could not finish');
});

test('an agent that explains its own failure is quoted rather than stderr noise', async t => {
  const { repo, runs, base, cleanup } = await workspace();
  t.after(cleanup);
  const binary = join(base, 'explains.mjs');
  await writeFile(binary, `#!/usr/bin/env node
console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Your workspace is out of credits.' }));
console.error('Reading additional input from stdin...');
process.exit(1);
`);
  await chmod(binary, 0o755);
  process.env.DASHBOARD_CLAUDE_BIN = binary;
  const { id } = await runs.start({ agent: 'claude', prompt: 'x', repo });
  const record = await settle(runs, id);
  assert.equal(record.status, 'failed');
  assert.equal(record.error, 'Your workspace is out of credits.');
  // The reason is stated once, not echoed again as the closing line.
  const log = await runs.log(id);
  assert.equal(log.events.filter(e => e.text === record.error).length, 1);
});

test('a missing agent binary fails the run instead of the dashboard', async t => {
  const { repo, runs, cleanup } = await workspace();
  t.after(cleanup);
  process.env.DASHBOARD_CLAUDE_BIN = join(repo, 'no-such-binary');
  const { id } = await runs.start({ agent: 'claude', prompt: 'anything', repo });
  const record = await settle(runs, id);
  assert.equal(record.status, 'failed');
  assert.match(record.error, /Check that it is installed/);
  // Both 'error' and 'close' fire here; the run must still finish exactly once.
  const log = await runs.log(id);
  assert.equal(log.events.filter(e => e.kind === 'error').length, 1);
});

test('removing a finished run takes its worktree with it', async t => {
  const { repo, runs, cleanup } = await workspace();
  t.after(cleanup);
  const { id } = await runs.start({ agent: 'claude', prompt: 'write a file', repo });
  const record = await settle(runs, id);
  await runs.remove(id);
  assert.equal(runs.runs.size, 0);
  assert.equal((await run('git', ['-C', repo, 'worktree', 'list'])).out.includes(record.dir), false);
  await assert.rejects(runs.log(id), /no longer exists/);
});

test('bad requests are refused before anything is spawned', async t => {
  const { repo, runs, cleanup } = await workspace();
  t.after(cleanup);
  await assert.rejects(runs.start({ agent: 'nonesuch', prompt: 'x', repo }), /supported agent/);
  await assert.rejects(runs.start({ agent: 'claude', prompt: '   ', repo }), /Describe what/);
  await assert.rejects(runs.start({ agent: 'claude', prompt: 'x'.repeat(9000), repo }), /under 8000/);
  // The message names the folder it looked at, so a wrong path is obvious.
  await assert.rejects(runs.start({ agent: 'claude', prompt: 'x', repo: join(repo, 'nope') }), /There is no folder at .*nope/);
  // An empty field must not quietly become the dashboard's own directory.
  await assert.rejects(runs.start({ agent: 'claude', prompt: 'x', repo: '' }), /Choose a project folder first/);
  await assert.rejects(runs.start({ agent: 'claude', prompt: 'x', repo: '   ' }), /Choose a project folder first/);
  await assert.rejects(runs.plan({ goal: 'something', repo: '' }), /Choose a project folder first/);
  assert.equal(runs.runs.size, 0);
});

test('a plain folder runs in place when a worktree is not possible', async t => {
  const { base, runs, cleanup } = await workspace();
  t.after(cleanup);
  const plain = join(base, 'plain');
  await mkdir(plain);
  await assert.rejects(runs.start({ agent: 'claude', prompt: 'x', repo: plain, worktree: true }), /is not a git repository/);
  const { id } = await runs.start({ agent: 'claude', prompt: 'x', repo: plain, worktree: false });
  const record = await settle(runs, id);
  assert.equal(record.dir, await realpath(plain));
  assert.equal(record.branch, null);
  assert.equal(record.status, 'done');
});

test('runs left behind by a restart are shown as interrupted', async t => {
  const { repo, runs, base, cleanup } = await workspace();
  t.after(cleanup);
  const { id } = await runs.start({ agent: 'claude', prompt: 'write a file', repo });
  await settle(runs, id);
  const path = join(base, 'runs', id, 'meta.json');
  const meta = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...meta, status: 'running' }));

  const restarted = new Runs(join(base, 'runs'), {});
  await restarted.init();
  const [record] = restarted.list();
  assert.equal(record.status, 'interrupted');
  // Output written before the restart is still readable.
  const log = await restarted.log(id);
  assert.ok(log.events.some(e => e.text === 'Writing the file.'));
});

test('a run that follows another starts from its work, not from the project tip', async t => {
  const { repo, runs, base, cleanup } = await workspace();
  t.after(cleanup);
  // The follower reports what it can see, so the leader's file proves the base.
  const follower = join(base, 'follower.mjs');
  await writeFile(follower, `#!/usr/bin/env node
import { existsSync } from 'node:fs';
console.log(JSON.stringify({ type: 'assistant', message: { content: [
  { type: 'text', text: 'leader file present: ' + existsSync('added.txt') }
] } }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', num_turns: 1 }));
`);
  await chmod(follower, 0o755);

  const leader = await runs.start({ agent: 'claude', prompt: 'write a file', repo });
  process.env.DASHBOARD_CLAUDE_BIN = follower;
  const next = await runs.start({ agent: 'claude', prompt: 'read it', repo, after: leader.id });

  assert.equal(runs.runs.get(next.id).status, 'waiting');
  assert.equal(runs.runs.get(next.id).branch, null, 'no worktree is made until it actually starts');

  await settle(runs, leader.id);
  const record = await settle(runs, next.id);
  assert.equal(record.status, 'done');
  const log = await runs.log(next.id);
  assert.ok(log.events.some(e => e.text === 'leader file present: true'), "the follower must see the leader's commit");
});

test('a follower is skipped when the run before it fails', async t => {
  const { repo, runs, cleanup } = await workspace();
  t.after(cleanup);
  process.env.FAKE_FAIL = '1';
  t.after(() => { delete process.env.FAKE_FAIL; });
  const leader = await runs.start({ agent: 'claude', prompt: 'fail', repo });
  const middle = await runs.start({ agent: 'claude', prompt: 'second', repo, after: leader.id });
  const last = await runs.start({ agent: 'claude', prompt: 'third', repo, after: middle.id });

  await settle(runs, leader.id);
  await settle(runs, middle.id);
  const tail = await settle(runs, last.id);
  assert.equal(runs.runs.get(middle.id).status, 'skipped');
  assert.match(runs.runs.get(middle.id).error, /did not finish/);
  assert.equal(tail.status, 'skipped', 'skipping must cascade down the chain');
  // Nothing was spawned for them, so no worktree or branch was created.
  assert.equal(tail.branch, null);
});

test('a waiting run can be cancelled before it starts', async t => {
  const { repo, runs, cleanup } = await workspace();
  t.after(cleanup);
  const leader = await runs.start({ agent: 'claude', prompt: 'write a file', repo });
  const next = await runs.start({ agent: 'claude', prompt: 'later', repo, after: leader.id });
  await runs.stop(next.id);
  assert.equal(runs.runs.get(next.id).status, 'stopped');
  await settle(runs, leader.id);
  assert.equal(runs.runs.get(next.id).status, 'stopped', 'the leader finishing must not revive it');
});

test('following a run that left nothing behind is refused up front', async t => {
  const { repo, runs, cleanup } = await workspace();
  t.after(cleanup);
  // A missing binary writes nothing at all, so there is nothing to build on.
  process.env.DASHBOARD_CLAUDE_BIN = join(repo, 'no-such-binary');
  const leader = await runs.start({ agent: 'claude', prompt: 'fail', repo });
  await settle(runs, leader.id);
  assert.equal(runs.runs.get(leader.id).commit, null);
  await assert.rejects(runs.start({ agent: 'claude', prompt: 'x', repo, after: leader.id }), /did not get far enough/);
  await assert.rejects(runs.start({ agent: 'claude', prompt: 'x', repo, after: 'no-such-run' }), /no longer exists/);
});

test('a plan is read out of whatever the planner wraps it in', async () => {
  const wrapped = JSON.stringify({
    subtype: 'success',
    result: 'Here is the plan:\n```json\n{"tasks":[' +
      '{"agent":"codex","title":"API","prompt":"build the api","after":null},' +
      '{"agent":"claude","title":"UI","prompt":"build the ui","after":0}]}\n```'
  });
  assert.deepEqual(parsePlan(wrapped), [
    { agent: 'codex', title: 'API', why: null, prompt: 'build the api', after: null },
    { agent: 'claude', title: 'UI', why: null, prompt: 'build the ui', after: 0 }
  ]);
  // Bare JSON, with no envelope, works the same way.
  assert.equal(parsePlan('{"tasks":[{"agent":"devin","title":"T","prompt":"p"}]}')[0].agent, 'devin');
});

test('a plan is repaired where it can be and refused where it cannot', () => {
  const plan = t => parsePlan(JSON.stringify({ result: JSON.stringify({ tasks: t }) }));
  // An unknown agent falls back rather than failing the whole plan.
  assert.equal(plan([{ agent: 'gpt-9', prompt: 'x' }])[0].agent, 'claude');
  assert.equal(plan([{ agent: 'claude', prompt: 'x' }])[0].title, 'Task 1');
  // A dependency must point backwards; anything else would wait forever.
  assert.equal(plan([{ agent: 'claude', prompt: 'a', after: 3 }])[0].after, null);
  assert.equal(plan([{ agent: 'claude', prompt: 'a' }, { agent: 'codex', prompt: 'b', after: 0 }])[1].after, 0);
  assert.equal(plan([{ agent: 'claude', prompt: 'a' }, { agent: 'codex', prompt: 'b', after: 1 }])[1].after, null);
  // Tasks with no instructions are dropped.
  assert.equal(plan([{ agent: 'claude', prompt: '  ' }, { agent: 'codex', prompt: 'real' }]).length, 1);

  assert.throws(() => parsePlan('no json here'), /did not return a plan/);
  assert.throws(() => plan([]), /did not return any tasks/);
  assert.throws(() => parsePlan('{"tasks": [oops}'), /could not be read as a plan/);
  assert.throws(() => parsePlan(JSON.stringify({ is_error: true, result: 'Usage limit reached.' })), /Usage limit reached/);
});

test('splitPatch separates files and keeps the hunks, not the noise', () => {
  const patch = [
    'diff --git a/src/a.js b/src/a.js',
    'index 111..222 100644',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1,2 +1,3 @@',
    ' unchanged',
    '+added line',
    'diff --git a/b.txt b/b.txt',
    'new file mode 100644',
    '@@ -0,0 +1 @@',
    '+brand new'
  ].join('\n');
  const files = splitPatch(patch, '1\t0\tsrc/a.js\n1\t0\tb.txt\n');
  assert.deepEqual(files.map(f => f.path), ['src/a.js', 'b.txt']);
  assert.deepEqual(files[0].lines, ['@@ -1,2 +1,3 @@', ' unchanged', '+added line']);
  assert.deepEqual(files[0], { path: 'src/a.js', lines: files[0].lines, added: 1, removed: 0, truncated: false });
  assert.equal(files.some(f => f.lines.some(l => l.startsWith('index '))), false);
});

test('changes show a run its own work, not the run it built on', async t => {
  const { repo, runs, base, cleanup } = await workspace();
  t.after(cleanup);
  const follower = join(base, 'follower.mjs');
  await writeFile(follower, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync('second.txt', 'from the follower\\n');
console.log(JSON.stringify({ type: 'result', subtype: 'success', num_turns: 1 }));
`);
  await chmod(follower, 0o755);

  const leader = await runs.start({ agent: 'claude', prompt: 'first', repo });
  await settle(runs, leader.id);
  process.env.DASHBOARD_CLAUDE_BIN = follower;
  const next = await runs.start({ agent: 'claude', prompt: 'second', repo, after: leader.id });
  await settle(runs, next.id);

  const leaderChanges = await runs.changes(leader.id);
  assert.deepEqual(leaderChanges.files.map(f => f.path), ['added.txt']);
  const followerChanges = await runs.changes(next.id);
  assert.deepEqual(followerChanges.files.map(f => f.path), ['second.txt'],
    "the follower's diff must not repeat the leader's file");
  assert.ok(followerChanges.files[0].lines.some(l => l.includes('from the follower')));
});

test('merging puts the work on the branch the project is on', async t => {
  const { repo, runs, cleanup } = await workspace();
  t.after(cleanup);
  const { id } = await runs.start({ agent: 'claude', prompt: 'write a file', repo });
  const record = await settle(runs, id);

  const merged = await runs.merge(id);
  assert.equal(merged.onto, 'main');
  assert.equal((await run('git', ['-C', repo, 'show', 'main:added.txt'])).out, 'from the agent\n');
  assert.ok(record.merged.onto === 'main');
  await assert.rejects(runs.merge(id), /already been merged/);
});

test('a merge is refused rather than burying uncommitted work', async t => {
  const { repo, runs, cleanup } = await workspace();
  t.after(cleanup);
  const { id } = await runs.start({ agent: 'claude', prompt: 'write a file', repo });
  await settle(runs, id);
  await writeFile(join(repo, 'my-notes.txt'), 'work in progress\n');

  await assert.rejects(runs.merge(id), /uncommitted changes/);
  // Refusing must leave the project untouched, mid-merge state included.
  assert.match((await run('git', ['-C', repo, 'status', '--porcelain'])).out, /my-notes\.txt/);
  assert.equal((await run('git', ['-C', repo, 'show', 'main:added.txt'])).code !== 0, true);
});

test('a conflicting merge leaves the project exactly as it was', async t => {
  const { repo, runs, cleanup } = await workspace();
  t.after(cleanup);
  const { id } = await runs.start({ agent: 'claude', prompt: 'write a file', repo });
  await settle(runs, id);
  // The project gains its own version of the same file first.
  await writeFile(join(repo, 'added.txt'), 'mine, different\n');
  await run('git', ['-C', repo, 'add', '-A']);
  await run('git', ['-C', repo, 'commit', '-m', 'mine']);

  await assert.rejects(runs.merge(id), /conflict/i);
  assert.equal((await run('git', ['-C', repo, 'status', '--porcelain'])).out, '', 'no half-finished merge left behind');
  assert.equal(await readFile(join(repo, 'added.txt'), 'utf8'), 'mine, different\n');
});

test('discarding a run can take its branch with it', async t => {
  const { repo, runs, cleanup } = await workspace();
  t.after(cleanup);
  const kept = await runs.start({ agent: 'claude', prompt: 'one', repo });
  const kill = await runs.start({ agent: 'claude', prompt: 'two', repo });
  const keptRecord = await settle(runs, kept.id);
  const killRecord = await settle(runs, kill.id);

  await runs.remove(kept.id);
  await runs.remove(kill.id, 'delete');
  const branches = (await run('git', ['-C', repo, 'branch', '--format=%(refname:short)'])).out;
  assert.match(branches, new RegExp(keptRecord.branch), 'keeping is still the default');
  assert.doesNotMatch(branches, new RegExp(killRecord.branch));
});

test('following a run that has already finished starts straight away', async t => {
  const { repo, runs, cleanup } = await workspace();
  t.after(cleanup);
  const leader = await runs.start({ agent: 'claude', prompt: 'first', repo });
  await settle(runs, leader.id);
  // Nothing is left to release it, so it must not be queued.
  const next = await runs.start({ agent: 'claude', prompt: 'second', repo, after: leader.id });
  assert.notEqual(runs.runs.get(next.id).status, 'waiting');
  const record = await settle(runs, next.id);
  assert.equal(record.status, 'done');
  assert.equal(record.baseCommit?.startsWith(runs.runs.get(leader.id).commit), true,
    'it still branches from the run it follows');
});

test('project keys reach the agent, and never reach the branch', async t => {
  const { repo, runs, base, cleanup } = await workspace();
  t.after(cleanup);
  const secrets = new Secrets(join(base, 'store'));
  await secrets.init();
  await secrets.set(repo, 'OPENAI_API_KEY', 'sk-test-value');
  runs.secrets = secrets;

  // Reports what it can see, so the run's log proves what was handed over.
  const prober = join(base, 'prober.mjs');
  await writeFile(prober, `#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
const line = t => console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } }));
line('env: ' + (process.env.OPENAI_API_KEY || 'missing'));
line('dotenv: ' + (existsSync('.env') ? readFileSync('.env', 'utf8').trim() : 'missing'));
console.log(JSON.stringify({ type: 'result', subtype: 'success', num_turns: 1 }));
`);
  await chmod(prober, 0o755);
  process.env.DASHBOARD_CLAUDE_BIN = prober;

  const { id } = await runs.start({ agent: 'claude', prompt: 'look around', repo });
  const record = await settle(runs, id);
  const said = (await runs.log(id)).events.map(e => e.text);
  assert.ok(said.includes('env: sk-test-value'), 'the key must be in the environment');
  assert.ok(said.includes('dotenv: OPENAI_API_KEY="sk-test-value"'), 'and in a .env the code can read');
  assert.deepEqual(record.keys, ['OPENAI_API_KEY']);

  // The written .env must not survive into the commit that gets merged.
  const committed = (await run('git', ['-C', repo, '--no-pager', 'show', '--name-only', '--format=', record.branch])).out;
  assert.doesNotMatch(committed, /\.env/, 'the keys file must never be committed');
  assert.equal((await run('git', ['-C', repo, 'show', `${record.branch}:.env`])).code !== 0, true);
});

test("a project's own .env is left alone", async t => {
  const { repo, runs, base, cleanup } = await workspace();
  t.after(cleanup);
  const secrets = new Secrets(join(base, 'store2'));
  await secrets.init();
  await secrets.set(repo, 'FROM_DASHBOARD', 'dashboard-value');
  runs.secrets = secrets;

  // A .env that the project tracks itself is the real one.
  await writeFile(join(repo, '.env'), 'FROM_PROJECT="project-value"\n');
  await run('git', ['-C', repo, 'add', '-A']);
  await run('git', ['-C', repo, 'commit', '-m', 'add env']);

  const reader = join(base, 'reader.mjs');
  await writeFile(reader, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'dotenv: ' + readFileSync('.env', 'utf8').trim() }] } }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', num_turns: 1 }));
`);
  await chmod(reader, 0o755);
  process.env.DASHBOARD_CLAUDE_BIN = reader;

  const { id } = await runs.start({ agent: 'claude', prompt: 'read env', repo });
  await settle(runs, id);
  const said = (await runs.log(id)).events.map(e => e.text);
  assert.ok(said.includes('dotenv: FROM_PROJECT="project-value"'), "the project's own .env must win");
});

test('a run killed mid-flight has its work committed on the next start', async t => {
  const { repo, runs, base, cleanup } = await workspace();
  t.after(cleanup);
  // Writes a file, then hangs — the shape of an agent killed while working.
  const stuck = join(base, 'stuck.mjs');
  await writeFile(stuck, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync('half-done.txt', 'work in progress\\n');
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'started' }] } }));
setInterval(() => {}, 1000);
`);
  await chmod(stuck, 0o755);
  process.env.DASHBOARD_CLAUDE_BIN = stuck;

  const { id } = await runs.start({ agent: 'claude', prompt: 'do the thing', repo });
  for (let i = 0; i < 100 && !runs.runs.get(id).files.length && runs.runs.get(id).status === 'running'; i++)
    await new Promise(r => setTimeout(r, 25));
  // The dashboard dying means nothing is left to notice the exit, so drop the
  // handlers before killing: otherwise this process tidies up and there is
  // nothing for a restart to find.
  const child = runs.runs.get(id).child;
  child.removeAllListeners('close');
  child.removeAllListeners('error');
  child.kill('SIGKILL');
  await new Promise(r => setTimeout(r, 150));

  // A fresh dashboard over the same directory: the work must be rescued.
  const restarted = new Runs(runs.dir, runs.vault);
  await restarted.init();
  const record = restarted.runs.get(id);
  assert.equal(record.status, 'interrupted');
  assert.ok(record.commit, 'what it wrote must be committed, not left loose');
  assert.equal(record.diff.files, 1);
  assert.match(record.error, /is committed/);
  const committed = (await run('git', ['-C', repo, '--no-pager', 'show', '--name-only', '--format=', record.branch])).out;
  assert.match(committed, /half-done\.txt/);
  // canCarryOn is part of what the page is told, not stored on the record.
  assert.equal(restarted.list().find(r => r.id === id).canCarryOn, true);
});

test('carrying on starts the same task from where it stopped', async t => {
  const { repo, runs, base, cleanup } = await workspace();
  t.after(cleanup);
  const stuck = join(base, 'stuck2.mjs');
  await writeFile(stuck, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync('half-done.txt', 'partial\\n');
setInterval(() => {}, 1000);
`);
  await chmod(stuck, 0o755);
  process.env.DASHBOARD_CLAUDE_BIN = stuck;
  const { id } = await runs.start({ agent: 'claude', prompt: 'the original task', repo });
  for (let i = 0; i < 100 && runs.runs.get(id).status === 'running'; i++) {
    if (runs.runs.get(id).files.length) break;
    await new Promise(r => setTimeout(r, 25));
  }
  const dying = runs.runs.get(id).child;
  dying.removeAllListeners('close');
  dying.removeAllListeners('error');
  dying.kill('SIGKILL');
  await new Promise(r => setTimeout(r, 150));

  const restarted = new Runs(runs.dir, runs.vault);
  await restarted.init();
  // The follow-on can see the rescued work.
  const seer = join(base, 'seer.mjs');
  await writeFile(seer, `#!/usr/bin/env node
import { existsSync } from 'node:fs';
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'earlier work present: ' + existsSync('half-done.txt') }] } }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', num_turns: 1 }));
`);
  await chmod(seer, 0o755);
  process.env.DASHBOARD_CLAUDE_BIN = seer;

  const next = await restarted.carryOn(id);
  const record = await settle(restarted, next.id);
  assert.equal(record.status, 'done');
  assert.match(record.prompt, /carrying on work that was interrupted/);
  assert.match(record.prompt, /the original task/, 'the original task must be carried over');
  const said = (await restarted.log(next.id)).events.map(e => e.text);
  assert.ok(said.includes('earlier work present: true'));

  await assert.rejects(restarted.carryOn('nope'), /no longer exists/);
});

test('continuing a run that never started brings its whole chain back', async t => {
  const { repo, runs, base, cleanup } = await workspace();
  t.after(cleanup);
  // A leader that writes and hangs, so the pair can be killed mid-chain.
  const stuck = join(base, 'stuck3.mjs');
  await writeFile(stuck, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync('backend.txt', 'api\\n');
setInterval(() => {}, 1000);
`);
  await chmod(stuck, 0o755);
  process.env.DASHBOARD_CLAUDE_BIN = stuck;

  const leader = await runs.start({ agent: 'claude', prompt: 'build the backend', repo });
  const middle = await runs.start({ agent: 'claude', prompt: 'build the ui', repo, after: leader.id });
  const last = await runs.start({ agent: 'claude', prompt: 'write the tests', repo, after: middle.id });
  for (let i = 0; i < 100 && !runs.runs.get(leader.id).files.length; i++) await new Promise(r => setTimeout(r, 25));

  const child = runs.runs.get(leader.id).child;
  child.removeAllListeners('close');
  child.removeAllListeners('error');
  child.kill('SIGKILL');
  await new Promise(r => setTimeout(r, 150));

  // A restart: the leader's work is salvaged, the two behind it are stranded.
  const restarted = new Runs(runs.dir, runs.vault);
  await restarted.init();
  assert.equal(restarted.runs.get(middle.id).status, 'interrupted');
  assert.equal(restarted.runs.get(last.id).status, 'interrupted');
  // Every stranded run offers to be picked up, whether or not it wrote anything.
  const listed = restarted.list();
  assert.deepEqual(listed.filter(r => r.canCarryOn).map(r => r.id).sort(), [leader.id, middle.id, last.id].sort());

  const seer = join(base, 'seer3.mjs');
  await writeFile(seer, `#!/usr/bin/env node
import { existsSync } from 'node:fs';
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'backend present: ' + existsSync('backend.txt') }] } }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', num_turns: 1 }));
`);
  await chmod(seer, 0o755);
  process.env.DASHBOARD_CLAUDE_BIN = seer;

  // One click on the leader restarts the leader and everything behind it.
  const fresh = await restarted.carryOn(leader.id);
  const revived = restarted.list().filter(r => r.continues);
  assert.deepEqual(revived.map(r => r.continues).sort(), [leader.id, middle.id, last.id].sort(),
    'the whole chain comes back, not just the run that was clicked');

  for (const run of revived) await settle(restarted, run.id);
  assert.deepEqual(revived.map(r => restarted.runs.get(r.id).status), ['done', 'done', 'done']);

  // The revived followers see the salvaged work, and order is preserved.
  const follower = revived.find(r => r.continues === middle.id);
  assert.ok((await restarted.log(follower.id)).events.some(e => e.text === 'backend present: true'));
  assert.equal(restarted.runs.get(follower.id).after, fresh.id);

  // A run already picked up is not offered again.
  assert.equal(restarted.list().find(r => r.id === leader.id).canCarryOn, false);
  await assert.rejects(restarted.carryOn(leader.id), /already been picked up/);
  await assert.rejects(restarted.carryOn(fresh.id), /finished/);
});

test('one merge takes everything, and a branch already included is not a conflict', async t => {
  const { repo, runs, base, cleanup } = await workspace();
  t.after(cleanup);
  const writer = name => `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync('${name}', '${name}\\n');
console.log(JSON.stringify({ type: 'result', subtype: 'success', num_turns: 1 }));
`;
  const first = join(base, 'w1.mjs');
  await writeFile(first, writer('backend.txt'));
  await chmod(first, 0o755);
  process.env.DASHBOARD_CLAUDE_BIN = first;
  const backend = await runs.start({ agent: 'claude', prompt: 'backend', repo });
  await settle(runs, backend.id);

  // Chained, so this branch contains the backend commit as well.
  const second = join(base, 'w2.mjs');
  await writeFile(second, writer('ui.txt'));
  await chmod(second, 0o755);
  process.env.DASHBOARD_CLAUDE_BIN = second;
  const ui = await runs.start({ agent: 'claude', prompt: 'ui', repo, after: backend.id });
  await settle(runs, ui.id);

  // And one that started from the project tip instead.
  const third = join(base, 'w3.mjs');
  await writeFile(third, writer('docs.txt'));
  await chmod(third, 0o755);
  process.env.DASHBOARD_CLAUDE_BIN = third;
  const docs = await runs.start({ agent: 'claude', prompt: 'docs', repo });
  await settle(runs, docs.id);

  assert.deepEqual(runs.mergeable().map(r => r.id), [backend.id, ui.id, docs.id]);
  const result = await runs.mergeAll();
  assert.equal(result.stoppedAt, null);
  assert.equal(result.merged.length, 3);
  for (const name of ['backend.txt', 'ui.txt', 'docs.txt'])
    assert.equal((await run('git', ['-C', repo, 'show', `main:${name}`])).code, 0, `${name} must be on main`);

  // The backend branch was carried in by the ui branch; merging it is a no-op,
  // not a failure.
  assert.equal(runs.runs.get(backend.id).merged.onto, 'main');
  assert.deepEqual(runs.mergeable(), [], 'nothing is left waiting');
  await assert.rejects(runs.mergeAll(), /nothing waiting/);
});

test('merging everything stops rather than half-applying', async t => {
  const { repo, runs, cleanup } = await workspace();
  t.after(cleanup);
  const { id } = await runs.start({ agent: 'claude', prompt: 'write a file', repo });
  await settle(runs, id);
  await writeFile(join(repo, 'in-progress.txt'), 'mine\n');

  const result = await runs.mergeAll();
  assert.deepEqual(result.merged, []);
  assert.match(result.stoppedAt.reason, /uncommitted changes/);
  assert.equal(runs.runs.get(id).merged, null, 'nothing was merged');
});

test('removing the finished ones frees their worktrees and keeps their branches', async t => {
  const { repo, runs, base, cleanup } = await workspace();
  t.after(cleanup);
  const done = await runs.start({ agent: 'claude', prompt: 'one', repo });
  const record = await settle(runs, done.id);

  // One that is still going must survive the tidy-up.
  const stuck = join(base, 'busy.mjs');
  await writeFile(stuck, '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n');
  await chmod(stuck, 0o755);
  process.env.DASHBOARD_CLAUDE_BIN = stuck;
  const running = await runs.start({ agent: 'claude', prompt: 'still going', repo });
  t.after(() => runs.runs.get(running.id)?.child?.kill('SIGKILL'));

  runs.list();
  await new Promise(r => setTimeout(r, 50));
  const result = await runs.removeFinished();
  assert.equal(result.removed, 1);
  assert.equal(runs.runs.has(done.id), false);
  assert.equal(runs.runs.has(running.id), true, 'a run still working is left alone');

  // The work survives: the branch is still there, the worktree is not.
  const branches = (await run('git', ['-C', repo, 'branch', '--format=%(refname:short)'])).out;
  assert.match(branches, new RegExp(record.branch));
  assert.equal((await run('git', ['-C', repo, 'worktree', 'list'])).out.includes(record.dir), false);

  runs.runs.get(running.id).child.kill('SIGKILL');
  await settle(runs, running.id);
});

test('run size is measured so the page can say what is being held', async t => {
  const { repo, runs, cleanup } = await workspace();
  t.after(cleanup);
  const { id } = await runs.start({ agent: 'claude', prompt: 'one', repo });
  await settle(runs, id);
  runs.list();
  await new Promise(r => setTimeout(r, 200));
  const listed = runs.list().find(r => r.id === id);
  assert.ok(listed.size > 0, 'a run on disk has a size');
  // Measuring is throttled, so a second listing does not re-run du.
  const at = runs.runs.get(id).sizeAt;
  runs.list();
  assert.equal(runs.runs.get(id).sizeAt, at);
});

test('a plan cannot hand work to an agent the planner was never offered', () => {
  const plan = t => parsePlan(JSON.stringify({ result: JSON.stringify({ tasks: t }) }));
  // Hermes is not on the roster, so a plan naming it falls back rather than
  // quietly sending repo work somewhere it was deliberately kept from.
  assert.equal(plan([{ agent: 'hermes', prompt: 'write the docs' }])[0].agent, 'claude');
  assert.equal(plan([{ agent: 'devin', prompt: 'test it' }])[0].agent, 'devin');
});

test('the summary reports what each run said and changed', async t => {
  const { repo, runs, base, cleanup } = await workspace();
  t.after(cleanup);
  const talker = join(base, 'talker.mjs');
  await writeFile(talker, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync('added.txt', 'work\\n');
const say = t => console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } }));
say('First I looked around.');
say('Added the helper and wired it up. Tests pass.');
console.log(JSON.stringify({ type: 'result', subtype: 'success', num_turns: 2 }));
`);
  await chmod(talker, 0o755);
  process.env.DASHBOARD_CLAUDE_BIN = talker;

  const { id } = await runs.start({ agent: 'claude', prompt: 'do the thing\nwith detail', repo });
  await settle(runs, id);
  const summary = await runs.summarise();

  assert.equal(summary.working, 0);
  const [entry] = summary.entries;
  // The agent's closing account of itself, not its first thought.
  assert.equal(entry.said, 'Added the helper and wired it up. Tests pass.');
  assert.equal(entry.task, 'do the thing', 'the task is trimmed to its first line');
  assert.equal(entry.files, 1);
  assert.equal(entry.merged, null);
  assert.deepEqual(summary.totals, { files: 1, added: 1, removed: 0, merged: 0, unmerged: 1 });

  await runs.merge(id);
  const after = await runs.summarise();
  assert.equal(after.entries[0].merged, 'main');
  assert.deepEqual(after.totals, { files: 1, added: 1, removed: 0, merged: 1, unmerged: 0 });
});

test('a summary counts what is still working, and leaves superseded runs out', async t => {
  const { repo, runs, base, cleanup } = await workspace();
  t.after(cleanup);
  const busy = join(base, 'busy2.mjs');
  await writeFile(busy, '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n');
  await chmod(busy, 0o755);
  process.env.DASHBOARD_CLAUDE_BIN = busy;
  const running = await runs.start({ agent: 'claude', prompt: 'still going', repo });
  t.after(() => runs.runs.get(running.id)?.child?.kill('SIGKILL'));

  const summary = await runs.summarise();
  assert.equal(summary.working, 1);
  // Nothing is claimed about a run that has not finished.
  assert.equal(summary.entries[0].said, null);

  runs.runs.get(running.id).child.kill('SIGKILL');
  await settle(runs, running.id);
  await runs.carryOn(running.id).catch(() => null);
  const later = await runs.summarise();
  assert.equal(later.entries.some(e => e.id === running.id && later.entries.length > 1), false,
    'a run that was picked up again is not counted twice');
});

test('an agent\'s closing notes are stripped of code before being shown', () => {
  const messy = [
    'Implemented the **backend cover feature**.',
    '',
    '## Changed',
    '- Added helpers in [`lib/cover.ts`](/Users/bryan/rex-hub/lib/cover.ts):',
    '  - `isAway(cover): boolean`',
    '',
    '```sql',
    'ALTER TABLE "feedback" ADD COLUMN "responded_at" timestamp;',
    '```',
    '',
    'Migration needs approval.'
  ].join('\n');
  const tidy = Runs.tidy(messy);
  assert.doesNotMatch(tidy, /ALTER TABLE/, 'code blocks go');
  assert.doesNotMatch(tidy, /\/Users\/bryan/, 'absolute paths go');
  assert.doesNotMatch(tidy, /[`*#]/, 'markdown punctuation goes');
  assert.match(tidy, /Implemented the backend cover feature/);
  assert.match(tidy, /Migration needs approval/);
  assert.doesNotMatch(tidy, /\n\n\n/, 'the gaps left behind are closed up');
});

test('the plain summary is written once and reused', async t => {
  const { repo, runs, base, cleanup } = await workspace();
  t.after(cleanup);
  const talker = join(base, 'talker2.mjs');
  await writeFile(talker, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync('added.txt', 'work\\n');
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Did the thing.' }] } }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', num_turns: 1 }));
`);
  await chmod(talker, 0o755);
  process.env.DASHBOARD_CLAUDE_BIN = talker;
  const { id } = await runs.start({ agent: 'claude', prompt: 'do it', repo });
  await settle(runs, id);

  // The writer is the claude binary, which here just echoes a canned reply.
  const writer = join(base, 'writer.mjs');
  await writeFile(writer, `#!/usr/bin/env node
console.log(JSON.stringify({ subtype: 'success', is_error: false, result: 'Claude Code: it did the thing.\\nNext: nothing.' }));
`);
  await chmod(writer, 0o755);
  process.env.DASHBOARD_CLAUDE_BIN = writer;

  const summary = await runs.summarise();
  assert.equal(summary.plain, null, 'nothing is written until it is asked for');
  assert.equal(await runs.explain(summary), 'Claude Code: it did the thing.\nNext: nothing.');
  assert.equal((await runs.summarise()).plain, 'Claude Code: it did the thing.\nNext: nothing.');

  // Asking again with the same runs must not spend another call.
  await writeFile(writer, '#!/usr/bin/env node\nprocess.exit(1);\n');
  assert.match(await runs.explain(await runs.summarise()), /it did the thing/);
});

test('a summary that cannot be written leaves the facts standing', async t => {
  const { repo, runs, base, cleanup } = await workspace();
  t.after(cleanup);
  const { id } = await runs.start({ agent: 'claude', prompt: 'do it', repo });
  await settle(runs, id);
  const broken = join(base, 'broken.mjs');
  await writeFile(broken, '#!/usr/bin/env node\nprocess.exit(1);\n');
  await chmod(broken, 0o755);
  process.env.DASHBOARD_CLAUDE_BIN = broken;

  const summary = await runs.summarise();
  assert.equal(await runs.explain(summary), null, 'a failure is not an error, just no plain text');
  assert.equal(summary.entries.length, 1, 'the run and what it changed are still reported');
});

// A worktree that looks like a real project: package.json, node_modules, and
// scripts whose success can be steered per test.
async function projectWith(runs, id, scripts, { installed = true } = {}) {
  const dir = runs.runs.get(id).dir;
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'p', scripts }, null, 2));
  if (installed) await mkdir(join(dir, 'node_modules'), { recursive: true });
  return dir;
}

test('merging refuses when the project does not build', async t => {
  const { repo, runs, cleanup } = await workspace();
  t.after(cleanup);
  const { id } = await runs.start({ agent: 'claude', prompt: 'write a file', repo });
  await settle(runs, id);
  await projectWith(runs, id, { build: 'echo "TypeError: broken" && exit 1', test: 'exit 0' });

  await assert.rejects(runs.merge(id), /Not merged: build failed/);
  assert.equal(runs.runs.get(id).merged, null, 'nothing was merged');
  // The reason travels with the refusal, not just a failure code.
  await assert.rejects(runs.merge(id), /TypeError: broken/);

  // Overriding is possible, because a build can be broken for reasons that
  // predate the run.
  const merged = await runs.merge(id, { force: true });
  assert.equal(merged.onto, 'main');
});

test('merging goes ahead when the checks pass', async t => {
  const { repo, runs, cleanup } = await workspace();
  t.after(cleanup);
  const { id } = await runs.start({ agent: 'claude', prompt: 'write a file', repo });
  await settle(runs, id);
  await projectWith(runs, id, { build: 'exit 0', 'test:run': 'exit 0' });

  const result = await runs.check(id);
  assert.equal(result.checked, true);
  assert.deepEqual(result.results.map(r => [r.label, r.ok]), [['build', true], ['test:run', true]]);
  await runs.merge(id);
  assert.equal(runs.runs.get(id).merged.onto, 'main');
  assert.equal(runs.runs.get(id).checked.ok, true);
});

test('a project with nothing to check is not held up by it', async t => {
  const { repo, runs, base, cleanup } = await workspace();
  t.after(cleanup);
  const plain = await runs.start({ agent: 'claude', prompt: 'one', repo });
  await settle(runs, plain.id);
  // No package.json at all.
  let result = await runs.check(plain.id);
  assert.equal(result.checked, false);
  assert.match(result.why, /no build or test script/);
  await runs.merge(plain.id);   // and merging is not blocked by that

  // A different file, so this run actually has something of its own to commit.
  const other = join(base, 'other.mjs');
  await writeFile(other, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync('other.txt', 'different');
console.log(JSON.stringify({ type: 'result', subtype: 'success', num_turns: 1 }));
`);
  await chmod(other, 0o755);
  process.env.DASHBOARD_CLAUDE_BIN = other;
  const second = await runs.start({ agent: 'claude', prompt: 'two', repo });
  await settle(runs, second.id);
  assert.ok(runs.runs.get(second.id).commit, 'the second run must have something to merge');
  // Scripts but no dependencies: the checks cannot run, and say so.
  await projectWith(runs, second.id, { build: 'exit 1' }, { installed: false });
  result = await runs.check(second.id);
  assert.equal(result.checked, false);
  assert.match(result.why, /never installed/);
  await runs.merge(second.id);
});

test('a watch-mode test script is passed over for the one meant for CI', async t => {
  const { repo, runs, cleanup } = await workspace();
  t.after(cleanup);
  const { id } = await runs.start({ agent: 'claude', prompt: 'x', repo });
  await settle(runs, id);
  const dir = runs.runs.get(id).dir;

  await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest --watch', 'test:run': 'vitest run' } }));
  let commands = await runs.checkCommands(dir);
  assert.deepEqual(commands.map(c => c[2]), ['test:run']);

  await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'tsc', test: 'jest' } }));
  commands = await runs.checkCommands(dir);
  assert.deepEqual(commands.map(c => c[2]), ['build', 'test']);
});

test('merging everything stops at the first run that does not stand up', async t => {
  const { repo, runs, cleanup } = await workspace();
  t.after(cleanup);
  const good = await runs.start({ agent: 'claude', prompt: 'good', repo });
  await settle(runs, good.id);
  await projectWith(runs, good.id, { build: 'exit 0' });
  const bad = await runs.start({ agent: 'claude', prompt: 'bad', repo });
  await settle(runs, bad.id);
  await projectWith(runs, bad.id, { build: 'exit 1' });

  const result = await runs.mergeAll();
  assert.equal(result.merged.length, 1, 'the sound one lands');
  assert.match(result.stoppedAt.reason, /build failed/);
  assert.equal(runs.runs.get(bad.id).merged, null);
});

test('merging does not throw away the summary that was already written', async t => {
  const { repo, runs, base, cleanup } = await workspace();
  t.after(cleanup);
  const { id } = await runs.start({ agent: 'claude', prompt: 'do it', repo });
  await settle(runs, id);

  const writer = join(base, 'writer2.mjs');
  await writeFile(writer, `#!/usr/bin/env node
console.log(JSON.stringify({ subtype: 'success', is_error: false, result: 'Claude Code: it did the thing.' }));
`);
  await chmod(writer, 0o755);
  process.env.DASHBOARD_CLAUDE_BIN = writer;
  assert.match(await runs.explain(await runs.summarise()), /it did the thing/);

  // The writer now refuses, so anything asked for again would come back empty.
  await writeFile(writer, '#!/usr/bin/env node\nprocess.exit(1);\n');
  await runs.merge(id);
  const after = await runs.summarise();
  assert.match(after.plain, /it did the thing/, 'the account survives the merge');
  assert.equal(after.entries[0].merged, 'main', 'while the figures still move');
});

test('a summary that cannot be written says why', async t => {
  const { repo, runs, base, cleanup } = await workspace();
  t.after(cleanup);
  const { id } = await runs.start({ agent: 'claude', prompt: 'do it', repo });
  await settle(runs, id);

  const broken = join(base, 'broken2.mjs');
  await writeFile(broken, '#!/usr/bin/env node\nconsole.error("usage limit reached");\nprocess.exit(1);\n');
  await chmod(broken, 0o755);
  process.env.DASHBOARD_CLAUDE_BIN = broken;

  assert.equal(await runs.explain(await runs.summarise()), null);
  const summary = await runs.summarise();
  assert.equal(summary.plain, null);
  assert.match(summary.plainError, /usage limit reached/, 'the reason is reported, not swallowed');
});

test('half a code fence does not survive into the details', () => {
  // Agent notes are trimmed for length, which used to cut a fence in two.
  const cut = 'Did the work.\n\n```sql\n-- Store quarterly r';
  assert.doesNotMatch(Runs.tidy(cut), /```/);
  assert.match(Runs.tidy(cut), /Did the work/);
});

test('a plan may use one agent, and says why each was chosen', () => {
  const plan = t => parsePlan(JSON.stringify({ result: JSON.stringify({ tasks: t }) }));
  // One task is a valid plan: not everything needs splitting up.
  const single = plan([{ agent: 'devin', title: 'API', why: 'it wrote the tests this depends on', prompt: 'build it' }]);
  assert.equal(single.length, 1);
  assert.equal(single[0].why, 'it wrote the tests this depends on');

  // The same agent may take more than one task.
  const twice = plan([
    { agent: 'devin', prompt: 'backend', why: 'closest to the data model' },
    { agent: 'devin', prompt: 'tests', why: 'it just wrote this', after: 0 }
  ]);
  assert.deepEqual(twice.map(t => t.agent), ['devin', 'devin']);
  assert.equal(twice[1].after, 0);

  // A missing reason is left empty rather than invented.
  assert.equal(plan([{ agent: 'claude', prompt: 'x' }])[0].why, null);
  assert.equal(plan([{ agent: 'claude', prompt: 'x', why: '   ' }])[0].why, null);
});

// Stands in for the settings file, so the tests do not touch one.
const autoSetTo = mode => ({ mode: async () => mode });

test('a finished batch merges itself when that is what was asked for', async t => {
  const { repo, runs, base, cleanup } = await workspace();
  t.after(cleanup);
  runs.auto = autoSetTo('merge');

  const leader = await runs.start({ agent: 'claude', prompt: 'first', repo });
  const follower = await runs.start({ agent: 'claude', prompt: 'second', repo, after: leader.id });
  // Nothing merges while the follower is still queued behind the leader.
  await settle(runs, leader.id);
  assert.equal(runs.runs.get(leader.id).merged, null, 'a batch is not merged halfway through');

  await settle(runs, follower.id);
  await new Promise(r => setTimeout(r, 300));
  assert.ok(runs.runs.get(leader.id).merged, 'and is merged once the batch is done');
  assert.equal((await run('git', ['-C', repo, 'show', 'main:added.txt'])).code, 0);
  const [note] = runs.autoLog;
  assert.equal(note.ok, true);
  assert.equal(note.pushed, 0, 'merging alone does not push');
});

test('work that does not stand up is not merged behind your back', async t => {
  const { repo, runs, cleanup } = await workspace();
  t.after(cleanup);
  // Switched on only once the failing build is in place: otherwise the run
  // finishes, merges itself, and there is nothing left to refuse.
  runs.auto = autoSetTo('off');
  const { id } = await runs.start({ agent: 'claude', prompt: 'x', repo });
  const record = await settle(runs, id);
  await writeFile(join(record.dir, 'package.json'), JSON.stringify({ scripts: { build: 'exit 1' } }));
  await mkdir(join(record.dir, 'node_modules'), { recursive: true });

  runs.auto = autoSetTo('merge');
  await runs.settleProject(repo);
  assert.equal(runs.runs.get(id).merged, null);
  const [note] = runs.autoLog;
  assert.equal(note.ok, false);
  assert.match(note.reason, /build failed/);
});

test('nothing happens on its own while it is switched off', async t => {
  const { repo, runs, cleanup } = await workspace();
  t.after(cleanup);
  runs.auto = autoSetTo('off');
  const { id } = await runs.start({ agent: 'claude', prompt: 'x', repo });
  await settle(runs, id);
  await new Promise(r => setTimeout(r, 200));
  assert.equal(runs.runs.get(id).merged, null, 'merging stays a decision');
  assert.deepEqual(runs.autoLog, []);
});

test('pushing on its own is reported, including when it cannot', async t => {
  const { repo, runs, cleanup } = await workspace();
  t.after(cleanup);
  runs.auto = autoSetTo('push');
  const { id } = await runs.start({ agent: 'claude', prompt: 'x', repo });
  await settle(runs, id);
  await new Promise(r => setTimeout(r, 300));

  assert.ok(runs.runs.get(id).merged, 'it still merges');
  const [note] = runs.autoLog;
  // This test repo has no upstream, so the push cannot happen and says so.
  assert.equal(note.ok, false);
  assert.match(note.reason, /Merged, but not pushed.*upstream/);
});

test('runs started together stay together, and separate rounds stay apart', async t => {
  const { repo, runs, cleanup } = await workspace();
  t.after(cleanup);
  const first = await runs.start({ agent: 'claude', prompt: 'one', repo, batch: 'round-one' });
  const second = await runs.start({ agent: 'claude', prompt: 'two', repo, batch: 'round-one' });
  await settle(runs, first.id);
  await settle(runs, second.id);
  const later = await runs.start({ agent: 'claude', prompt: 'three', repo });
  await settle(runs, later.id);

  const listed = runs.list();
  const batchOf = id => listed.find(r => r.id === id).batch;
  assert.equal(batchOf(first.id), batchOf(second.id), 'started together, grouped together');
  assert.notEqual(batchOf(later.id), batchOf(first.id), 'a later round is its own group');
  assert.ok(batchOf(later.id), 'a run started alone still belongs to a round');

  // Picking a run up again keeps it with the round it came from.
  const stopped = runs.runs.get(later.id);
  stopped.status = 'interrupted';
  stopped.error = 'stopped';
  const again = await runs.carryOn(later.id);
  assert.equal(runs.list().find(r => r.id === again.id).batch, batchOf(later.id));
});
