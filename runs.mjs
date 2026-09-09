import { spawn } from 'node:child_process';
import { mkdir, chmod, writeFile, readdir, rm, stat, realpath } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { agents, splitLines } from './adapters.mjs';
import { privateWrite, readOptional } from './vault.mjs';
import { toEnvFile } from './secrets.mjs';

const MEMORY_EVENTS = 4000;   // Per run, in memory. The full log stays on disk.
const DIFF_INTERVAL = 4000;
const SIZE_INTERVAL = 30_000;
const MAX_PROMPT = 8000;
const CHECK_TIMEOUT = 6 * 60 * 1000;

export function run(command, args, options = {}) {
  const { timeout, ...spawnOptions } = options;
  return new Promise(resolve => {
    const child = spawn(command, args, { ...spawnOptions, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', timedOut = false;
    // A command that never returns must be stopped, not abandoned: an orphan
    // holds the dashboard's exit and, in tests, the test runner's.
    const timer = timeout ? setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref?.();
    }, timeout) : null;
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { err += c; });
    child.on('error', e => { clearTimeout(timer); resolve({ code: -1, out, err: e.message }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code: timedOut ? -2 : code, out, err, timedOut }); });
  });
}

// One reading of a project path, so keys saved for `~/shop` are found by a run
// started against `/Users/me/shop`.
export function projectPath(repo) {
  const typed = String(repo || '').trim();
  // Never resolve an empty field: it would quietly become the working directory
  // of whatever started the dashboard, and fail later as a puzzling message.
  if (!typed) throw new Error('Choose a project folder first.');
  return resolve(typed.replace(/^~(?=\/|$)/, process.env.HOME || ''));
}

export function parseDiff(numstat, untracked) {
  let added = 0, removed = 0;
  const files = new Set();
  for (const line of numstat.split('\n')) {
    const [a, r, path] = line.split('\t');
    if (!path) continue;
    files.add(path);
    added += Number(a) || 0;
    removed += Number(r) || 0;
  }
  for (const path of untracked.split('\n')) if (path.trim()) files.add(path.trim());
  return { files: files.size, added, removed };
}

// The planner is asked for bare JSON but may still wrap it in prose or fences,
// so take the outermost object rather than trusting the whole reply.
export function parsePlan(stdout) {
  let text = stdout;
  let envelope = null;
  try { envelope = JSON.parse(stdout); } catch { /* not the JSON envelope; treat it as raw text */ }
  if (envelope && typeof envelope === 'object') {
    if (envelope.is_error) throw new Error(envelope.result || 'The planner reported an error.');
    if (typeof envelope.result === 'string') text = envelope.result;
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('The planner did not return a plan. Try describing the goal differently.');
  let plan;
  try { plan = JSON.parse(text.slice(start, end + 1)); }
  catch { throw new Error('The planner\'s reply could not be read as a plan. Try again.'); }

  const tasks = [];
  for (const task of Array.isArray(plan.tasks) ? plan.tasks : []) {
    const prompt = typeof task.prompt === 'string' ? task.prompt.trim() : '';
    if (!prompt) continue;
    const index = tasks.length;
    // Only a task earlier in the list can be depended on; anything else would
    // deadlock or point at nothing.
    const after = Number.isInteger(task.after) && task.after >= 0 && task.after < index ? task.after : null;
    tasks.push({
      agent: agents[task.agent] && agents[task.agent].planner !== false ? task.agent : 'claude',
      title: (typeof task.title === 'string' && task.title.trim()) || `Task ${index + 1}`,
      why: (typeof task.why === 'string' && task.why.trim().slice(0, 200)) || null,
      prompt: prompt.slice(0, MAX_PROMPT),
      after
    });
  }
  if (!tasks.length) throw new Error('The planner did not return any tasks. Try describing the goal differently.');
  return tasks;
}

const PATCH_LIMIT = 400_000;
const FILE_LINE_LIMIT = 500;

// Split a unified diff into one entry per file, with the line counts alongside.
export function splitPatch(patch, numstat = '') {
  const counts = new Map();
  for (const line of numstat.split('\n')) {
    const [added, removed, path] = line.split('\t');
    if (path) counts.set(path, { added: Number(added) || 0, removed: Number(removed) || 0 });
  }
  const files = [];
  let current = null;
  for (const line of patch.slice(0, PATCH_LIMIT).split('\n')) {
    const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (header) {
      current = { path: header[2], lines: [], ...(counts.get(header[2]) || { added: 0, removed: 0 }), truncated: false };
      files.push(current);
      continue;
    }
    if (!current) continue;
    // Keep the hunks; drop index/mode noise that says nothing to a reader.
    if (/^(index |new file mode |deleted file mode |similarity index |rename |old mode |new mode |---|\+\+\+)/.test(line)) continue;
    if (current.lines.length >= FILE_LINE_LIMIT) { current.truncated = true; continue; }
    current.lines.push(line);
  }
  return files;
}

export class Runs {
  constructor(dir, vault, secrets = null, models = null) { this.dir = dir; this.vault = vault; this.secrets = secrets; this.models = models; this.runs = new Map(); this.lastModelSeen = {}; }

  async init() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    for (const id of await readdir(this.dir).catch(() => [])) {
      const meta = await readOptional(join(this.dir, id, 'meta.json'));
      if (!meta) continue;
      try {
        const record = JSON.parse(meta);
        // Nothing survives a dashboard restart, so a run left 'running' in its
        // metadata is really an orphan from the previous process.
        const orphaned = ['running', 'starting', 'waiting'].includes(record.status);
        if (orphaned)
          Object.assign(record, { status: 'interrupted', endedAt: record.endedAt || Date.now(), error: 'The dashboard restarted while this run was active.' });
        const restored = { ...record, events: [], child: null, stream: null, diffAt: 0 };
        this.runs.set(record.id, restored);
        // Whatever it had written is committed now, so a restart never strands
        // work that has to be rescued by hand afterwards.
        if (orphaned && restored.branch) await this.salvage(restored);
      } catch { /* skip an unreadable run */ }
    }
  }

  // A worktree that ran an install can be hundreds of megabytes, and nothing
  // else on this page would ever say so.
  async refreshSize(record) {
    if (Date.now() - (record.sizeAt || 0) < SIZE_INTERVAL) return;
    record.sizeAt = Date.now();
    const measured = await run('du', ['-sk', join(this.dir, record.id)]);
    const kilobytes = Number(measured.out.trim().split(/\s+/)[0]);
    if (Number.isFinite(kilobytes)) record.size = kilobytes * 1024;
  }

  list() {
    const records = [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt);
    for (const record of records) {
      if (record.status === 'running') void this.refreshDiff(record);
      void this.refreshSize(record);
    }
    return records.map(r => ({
      id: r.id, agent: r.agent, label: r.label, prompt: r.prompt, repo: r.repo, dir: r.dir,
      branch: r.branch, account: r.account, sandbox: r.sandbox, status: r.status,
      startedAt: r.startedAt, endedAt: r.endedAt, error: r.error, diff: r.diff,
      commit: r.commit ?? null, commitError: r.commitError ?? null, after: r.after ?? null, merged: r.merged ?? null, keys: r.keys ?? [],
      continues: r.continues ?? null, supersededBy: this.supersededBy(r.id)?.id ?? null, canCarryOn: this.canCarryOn(r),
      size: r.size ?? null, model: r.model ?? null, checked: r.checked ?? null,
      files: r.files.slice(0, 40), seq: r.seq, headline: r.headline
    }));
  }

  async log(id, from = 0) {
    const record = this.runs.get(id);
    if (!record) throw new Error('That run no longer exists.');
    // A run restored from disk after a restart has no events in memory yet.
    if (!record.events.length && record.seq) await this.hydrate(record);
    const oldest = record.events[0]?.seq ?? from + 1;
    return { seq: record.seq, status: record.status, truncated: oldest > from + 1, events: record.events.filter(e => e.seq > from) };
  }

  async hydrate(record) {
    const raw = await readOptional(join(this.dir, record.id, 'events.jsonl'));
    if (!raw) return;
    const events = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { /* skip a partial line */ }
    }
    record.events = events.slice(-MEMORY_EVENTS);
  }

  async refreshDiff(record) {
    if (!record.git || Date.now() - record.diffAt < DIFF_INTERVAL) return;
    record.diffAt = Date.now();
    const [tracked, untracked] = await Promise.all([
      run('git', ['-C', record.dir, '--no-pager', 'diff', '--numstat', 'HEAD']),
      run('git', ['-C', record.dir, 'ls-files', '--others', '--exclude-standard'])
    ]);
    if (tracked.code === 0 || untracked.code === 0) record.diff = parseDiff(tracked.out, untracked.out);
  }

  async persist(record) {
    const { events, child, stream, diffAt, sizeAt, finishing, stopping, ...meta } = record;
    await writeFile(join(this.dir, record.id, 'meta.json'), JSON.stringify(meta, null, 2), { mode: 0o600 });
  }

  emit(record, event) {
    // Claude names its model when a session opens; remember it, so an agent
    // that keeps no model in its config can still say what it last used.
    const named = event.kind === 'status' && event.text.match(/^Session started · (.+)$/)?.[1];
    if (named) this.lastModelSeen[record.agent] = named.trim();

    // Agents report absolute paths; inside a worktree those are long and identical
    // up to the run directory, so show them relative to where the agent is working.
    const file = event.file?.startsWith(`${record.dir}/`) ? event.file.slice(record.dir.length + 1) : event.file;
    const entry = { seq: ++record.seq, ts: Date.now(), ...event, ...(event.file ? { file, text: event.text.replace(event.file, file) } : {}) };
    record.events.push(entry);
    if (record.events.length > MEMORY_EVENTS) record.events.splice(0, record.events.length - MEMORY_EVENTS);
    if (entry.file && !record.files.includes(entry.file)) record.files.push(entry.file);
    if (entry.kind === 'message' || entry.kind === 'tool' || entry.kind === 'file' || entry.kind === 'status')
      record.headline = entry.text.split('\n')[0].slice(0, 160);
    record.stream?.write(`${JSON.stringify(entry)}\n`);
    return entry;
  }

  async prepare({ agent, prompt, repo, worktree }) {
    const definition = agents[agent];
    if (!definition) throw new Error('Choose a supported agent.');
    const text = String(prompt || '').trim();
    if (!text) throw new Error('Describe what the agent should do.');
    if (text.length > MAX_PROMPT) throw new Error(`Keep the task under ${MAX_PROMPT} characters.`);
    const path = projectPath(repo);
    if (!(await stat(path).catch(() => null))?.isDirectory()) throw new Error(`There is no folder at ${path}.`);
    const git = (await run('git', ['-C', path, 'rev-parse', '--show-toplevel'])).code === 0;
    if (worktree && !git)
      throw new Error(`${path} is not a git repository, so an agent cannot have its own branch there. Choose the project folder, or untick "Own git branch".`);
    return { definition, prompt: text, repo: path, git };
  }

  // Claude reads the project and proposes who does what. The result is a
  // suggestion: nothing starts until the tasks are dispatched.
  async plan({ goal, repo }) {
    const wanted = String(goal || '').trim();
    if (!wanted) throw new Error('Describe what you want built.');
    if (wanted.length > MAX_PROMPT) throw new Error(`Keep the goal under ${MAX_PROMPT} characters.`);
    const path = projectPath(repo);
    if (!(await stat(path).catch(() => null))?.isDirectory()) throw new Error(`There is no folder at ${path}.`);

    const roster = Object.entries(agents)
      .filter(([, agent]) => agent.planner !== false)
      .map(([id, agent]) => `- ${id} (${agent.label})${agent.strength ? ` — ${agent.strength}` : ''}`).join('\n');
    const instructions = [
      'You are planning work for a team of coding agents on this project.',
      '', 'The agents, and what they tend to be good at:', roster, '',
      'Those are tendencies, not rules. Judge each task on what it actually needs and pick',
      'whoever fits it best — including going against the usual split when this job calls for it.',
      '', `Goal: ${wanted}`, '',
      'Read the project first so the instructions match what is actually there. Then split the',
      'goal into as few tasks as it honestly needs: one is fine if one agent should just do it,',
      'and up to four. Do not spread work across agents for the sake of it, and do not use an',
      'agent that has nothing useful to add. The same agent may take more than one task.',
      'Each task prompt must be self-contained instructions for that agent, written as if you',
      'are handing it the job.',
      'Give each task a "why": one short sentence on why that agent, for this task.',
      'If a task needs another task\'s code, set "after" to that task\'s index (0-based); otherwise null.',
      '', 'Reply with ONLY this JSON, no prose and no code fences:',
      '{"tasks":[{"agent":"codex","title":"short title","why":"why this agent","prompt":"full instructions","after":null}]}'
    ].join('\n');

    const binary = agents.claude.binary();
    // Plan mode so the planner can read the project but change nothing.
    const planning = await run(binary, ['--print', instructions, '--output-format', 'json', '--permission-mode', 'plan'], { cwd: path });
    if (planning.code !== 0)
      throw new Error(planning.err.trim().split('\n').filter(Boolean).at(-1) || 'Claude could not produce a plan.');
    return { tasks: parsePlan(planning.out) };
  }

  async start({ agent, prompt, repo, account = null, worktree = true, sandbox = 'workspace-write', after = null, continues = null }) {
    const prepared = await this.prepare({ agent, prompt, repo, worktree });
    if (after) {
      const earlier = this.runs.get(after);
      if (!earlier) throw new Error('The run this one waits for no longer exists.');
      // Following a run that stopped early is fine when it committed something;
      // that commit is exactly what carrying on means.
      const stoppedEarly = ['failed', 'stopped', 'interrupted', 'skipped'].includes(earlier.status);
      if (stoppedEarly && !earlier.commit)
        throw new Error('The run this one follows did not get far enough to leave anything to build on.');
    }
    // Only queue behind a run that has not finished. Waiting on one that is
    // already done would wait forever: nothing is left to release it.
    const queued = !!after && ['running', 'waiting'].includes(this.runs.get(after).status);
    const id = randomUUID();
    await mkdir(join(this.dir, id), { recursive: true, mode: 0o700 });

    const record = {
      id, agent, label: prepared.definition.label, prompt: prepared.prompt, repo: prepared.repo,
      dir: prepared.repo, branch: null, account, sandbox, after, continues, worktree: !!(worktree && prepared.git),
      git: prepared.git, status: queued ? 'waiting' : 'running',
      startedAt: Date.now(), endedAt: null, exitCode: null, error: null,
      headline: queued ? 'Waiting for the run before it…' : 'Starting…',
      seq: 0, files: [], diff: { files: 0, added: 0, removed: 0 }, commit: null, commitError: null, baseCommit: null, merged: null, keys: [],
      events: [], child: null, stream: null, diffAt: 0
    };
    this.runs.set(id, record);
    await this.persist(record);
    if (record.status === 'running') await this.launch(record);
    return { id };
  }

  // Split out from start so a waiting run can be launched later, once the run
  // it follows has finished and there is something to branch from.
  async launch(record) {
    const definition = agents[record.agent];
    const home = join(this.dir, record.id);
    record.status = 'running';
    record.startedAt = Date.now();
    record.stream = createWriteStream(join(home, 'events.jsonl'), { mode: 0o600, flags: 'a' });
    record.stream.on('error', () => { record.stream = null; });

    if (record.worktree) {
      // Branch from the work this run follows, not from the project's tip:
      // a run that waits for the backend needs to see the backend.
      const earlier = record.after ? this.runs.get(record.after) : null;
      const base = earlier?.commit || earlier?.branch || 'HEAD';
      record.branch = `agents/${record.agent}-${record.id.slice(0, 8)}`;
      // Resolved now: the diff has to be against what this run actually started
      // from, not against wherever the project has moved to since.
      record.baseCommit = (await run('git', ['-C', record.repo, 'rev-parse', base])).out.trim() || null;
      const dir = join(home, 'tree');
      const created = await run('git', ['-C', record.repo, 'worktree', 'add', '-b', record.branch, dir, base]);
      if (created.code !== 0) {
        record.branch = null;
        return this.finish(record, -1, `Could not create a worktree: ${created.err.trim().split('\n').at(-1) || 'git failed.'}`, null);
      }
      record.dir = dir;
    }
    // Agents report the paths they actually see, so canonicalize first — on
    // macOS a /var directory is reported under /private/var and never matches.
    record.dir = await realpath(record.dir);

    const env = { ...process.env };
    // The project's keys, so an agent can actually run the code it writes.
    // Both forms: the process environment, and a .env for code that reads one.
    const keys = this.secrets ? await this.secrets.all(record.repo) : {};
    const names = Object.keys(keys);
    if (names.length) {
      Object.assign(env, keys);
      const envFile = join(record.dir, '.env');
      // Never over a .env the project already has: that one is the real thing.
      if (!(await readOptional(envFile))) await privateWrite(envFile, toEnvFile(keys));
      record.keys = names;
    }

    let codexHome = null;
    if (record.agent === 'codex' && record.account) {
      // A private CODEX_HOME lets this run use a chosen account without
      // touching the login the terminal is using.
      codexHome = join(home, 'codex');
      await mkdir(codexHome, { recursive: true, mode: 0o700 });
      await privateWrite(join(codexHome, 'auth.json'), await this.vault.rawFor(record.account));
      const config = await readOptional(join(this.vault.codexDir, 'config.toml'));
      if (config) await privateWrite(join(codexHome, 'config.toml'), config);
      env.CODEX_HOME = codexHome;
    }

    const binary = definition.binary();
    const chosen = this.models ? await this.models.for(record.agent) : {};
    record.model = chosen.model || null;
    const args = definition.args({ prompt: record.prompt, sandbox: record.sandbox, ...chosen });
    const child = spawn(binary, args, { cwd: record.dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    record.child = child;
    this.emit(record, { kind: 'status', text: `${definition.label} started in ${record.branch ? `branch ${record.branch}` : record.dir}` });

    let buffer = '';
    child.stdout.on('data', chunk => {
      const split = splitLines(buffer, chunk.toString());
      buffer = split.buffer;
      for (const line of split.lines) {
        if (!line.trim()) continue;
        for (const event of definition.parse(line)) this.emit(record, event);
      }
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', () => this.finish(record, -1, `Could not start ${binary}. Check that it is installed.`, codexHome));
    child.on('close', code => {
      if (buffer.trim()) for (const event of definition.parse(buffer)) this.emit(record, event);
      // An agent that explained itself in its own output gives a far better reason
      // than the last line on stderr, which is often unrelated noise.
      const reported = [...record.events].reverse().find(e => e.kind === 'error')?.text;
      const failure = code === 0 || record.stopping ? null
        : reported || stderr.trim().split('\n').filter(Boolean).at(-1) || `${definition.label} exited with code ${code}.`;
      void this.finish(record, code, failure, codexHome);
    });
    await this.persist(record);
  }

  // Commit the half-finished work of a run that was killed mid-flight.
  async salvage(record) {
    if (record.keys?.length) await rm(join(record.dir, '.env'), { force: true }).catch(() => {});
    const staged = await run('git', ['-C', record.dir, 'add', '-A']);
    if (staged.code !== 0) return;
    record.diffAt = 0;
    await this.refreshDiff(record);
    if (!record.diff.files) return;
    await this.commit(record);
    if (record.commit) {
      record.error = 'The dashboard restarted while this run was active. What it had written is committed.';
      record.headline = record.error;
    }
    await this.persist(record).catch(() => {});
  }

  // Start whatever was queued behind this run, or give up on it clearly.
  async release(finished) {
    for (const record of [...this.runs.values()]) {
      if (record.after !== finished.id || record.status !== 'waiting') continue;
      if (finished.status !== 'done') {
        record.status = 'skipped';
        record.endedAt = Date.now();
        record.error = `Skipped: ${finished.label} did not finish, so there was nothing to build on.`;
        record.headline = record.error;
        await this.persist(record).catch(() => {});
        await this.release(record);
        continue;
      }
      await this.launch(record).catch(async e => {
        record.status = 'failed';
        record.endedAt = Date.now();
        record.error = e.message;
        await this.persist(record).catch(() => {});
      });
    }
  }

  async finish(record, code, error, codexHome) {
    // 'error' and 'close' both fire when a binary is missing. Claim the record
    // synchronously; a status check alone would let the second call through
    // while the first is still awaiting the diff below.
    if (record.status !== 'running' || record.finishing) return;
    record.finishing = true;
    // Settle the diff before the run reports itself finished, so a client never
    // sees a completed run still showing zero changed files.
    // Remove the keys file before anything is staged: deleting it later would be
    // too late, since `add -A` would already have picked it up.
    if (record.keys?.length) await rm(join(record.dir, '.env'), { force: true }).catch(() => {});
    // Stage first so a brand new file is counted with its line numbers, not just
    // as an untracked name. Only inside a worktree — staging the user's own
    // checkout would sweep up whatever they were working on.
    if (record.branch) await run('git', ['-C', record.dir, 'add', '-A']);
    record.diffAt = 0;
    await this.refreshDiff(record);
    if (record.branch && record.diff.files) await this.commit(record);
    record.status = record.stopping ? 'stopped' : error ? 'failed' : 'done';
    record.exitCode = code;
    record.error = error;
    record.endedAt = Date.now();
    record.child = null;
    const repeated = error && record.events.at(-1)?.text === error;
    if (!repeated) this.emit(record, { kind: error ? 'error' : 'status', text: error || (record.stopping ? 'Stopped.' : 'Run complete.') });
    record.stream?.end();
    record.stream = null;
    if (codexHome) {
      // Codex may have refreshed the account's tokens; keep the newest copy so
      // the vault never holds a refresh token the provider has rotated away.
      const raw = await readOptional(join(codexHome, 'auth.json'));
      if (raw) await this.vault.save(raw).catch(() => {});
      await rm(codexHome, { recursive: true, force: true }).catch(() => {});
    }
    await this.persist(record).catch(() => {});
    await this.release(record);
  }

  async commit(record) {
    const subject = `${record.agent}: ${record.prompt.split('\n')[0].slice(0, 72)}`;
    const made = await run('git', ['-C', record.dir, 'commit', '-m', subject]);
    if (made.code !== 0) {
      // Usually an unset user.email. The work is still in the worktree.
      record.commitError = 'The changes are in the worktree but could not be committed. Set git user.name and user.email.';
      return;
    }
    record.commit = (await run('git', ['-C', record.dir, 'rev-parse', '--short', 'HEAD'])).out.trim() || null;
  }

  // The run that replaced this one, if any.
  supersededBy(id) { return [...this.runs.values()].find(r => r.continues === id) || null; }

  // Follow the chain of replacements forward to whatever stands for this run now.
  latestOf(id, seen = new Set()) {
    let at = id;
    while (at && !seen.has(at)) {
      seen.add(at);
      const next = this.supersededBy(at);
      if (!next) break;
      at = next.id;
    }
    return at;
  }

  canCarryOn(record) {
    return ['interrupted', 'stopped', 'failed', 'skipped'].includes(record.status) && !this.supersededBy(record.id);
  }

  // Pick a task up again. A run that got some way through carries on from its
  // own commit; one that never started simply runs, behind whatever now stands
  // for the run it was waiting on.
  async carryOn(id) {
    const record = this.runs.get(id);
    if (!record) throw new Error('That run no longer exists.');
    if (['running', 'waiting'].includes(record.status)) throw new Error('That run is still going.');
    if (record.status === 'done') throw new Error('That run finished, so there is nothing to carry on.');
    const already = this.supersededBy(record.id);
    if (already) throw new Error('That run has already been picked up again.');

    const preface = 'You are carrying on work that was interrupted. Your branch already contains what was done so far — read it before changing anything, and continue rather than starting over.\n\n';
    const base = record.commit ? id : (record.after ? this.latestOf(record.after) : null);
    const usable = base && (this.runs.get(base)?.commit || ['running', 'waiting'].includes(this.runs.get(base)?.status));

    const fresh = await this.start({
      agent: record.agent,
      prompt: record.commit ? preface + record.prompt : record.prompt,
      repo: record.repo,
      account: record.account,
      worktree: !!record.branch || record.worktree,
      sandbox: record.sandbox,
      after: usable ? base : null,
      continues: id
    });
    // Whatever was queued behind it comes too, so one click restarts the chain.
    await this.requeue(id, fresh.id);
    return fresh;
  }

  async requeue(oldId, newId, seen = new Set()) {
    if (seen.has(oldId)) return;
    seen.add(oldId);
    for (const other of [...this.runs.values()]) {
      if (other.after !== oldId || other.commit) continue;
      if (!['interrupted', 'stopped', 'skipped'].includes(other.status)) continue;
      if (this.supersededBy(other.id)) continue;
      const next = await this.start({
        agent: other.agent, prompt: other.prompt, repo: other.repo, account: other.account,
        worktree: !!other.branch || other.worktree, sandbox: other.sandbox,
        after: newId, continues: other.id
      }).catch(() => null);
      if (next) await this.requeue(other.id, next.id, seen);
    }
  }

  // What the batch did, which is not changed by merging it: keeping the summary
  // across a merge is the difference between writing it once and every time.
  static accountSignature(entries) {
    return entries.map(e => `${e.id}:${e.status}`).join(',');
  }

  // Agents close with release notes: code, SQL, absolute paths. Strip the worst
  // of it before anything is shown or sent on.
  static tidy(text) {
    return String(text || '')
      .replace(/```[\s\S]*?```/g, '')                      // fenced code
      .replace(/```[\s\S]*$/, '')                           // a fence left open
      .replace(/\(\/[^)\s]+\)/g, '')                       // (/absolute/path) links
      .replace(/\/(?:Users|home|private|var)\/[^\s`)]+/g, 'a file')
      .replace(/`([^`]+)`/g, '$1')                         // backticks
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/^#+\s*/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // A plain-English account of the batch, written by a small fast model from
  // what the agents said. Generated once per batch and cached: it costs a call,
  // so it is not redone on every poll.
  async explain(summary) {
    const signature = Runs.accountSignature(summary.entries);
    if (this.explained?.signature === signature) return this.explained.text;
    if (this.explaining === signature) return null;
    this.explaining = signature;
    try {
      const facts = summary.entries.map(e => [
        `${e.label}: asked to ${Runs.tidy(e.task)}`,
        `changed ${e.files} file(s), ${e.merged ? `merged into ${e.merged}` : 'not merged yet'}${e.error ? `, note: ${e.error}` : ''}`,
        e.said ? `it reported: ${Runs.tidy(e.said).slice(0, 1500)}` : 'it reported nothing'
      ].join('\n')).join('\n\n');

      const instructions = [
        'Rewrite this for someone who wants to know what happened without reading code.',
        '',
        'One short paragraph per agent, two or three sentences, in plain English.',
        'Say what it actually did and whether it worked. Mention anything that still needs a person',
        'to decide or check. No code, no file paths, no function names, no jargon.',
        'Start each paragraph with the agent name followed by a colon.',
        'End with one line starting "Next:" saying what is left to do.',
        'Reply with the text only — no preamble, no headings, no bullet points.',
        '', facts
      ].join('\n');

      // A small model: this is rewriting, not thinking, and it should be quick.
      const written = await run(agents.claude.binary(),
        ['--print', instructions, '--output-format', 'json', '--model', 'haiku', '--permission-mode', 'plan'],
        { timeout: 90_000 });
      if (written.timedOut) throw new Error('it took too long to write');
      if (written.code !== 0)
        throw new Error(`${agents.claude.label} exited ${written.code}: ${(written.err || written.out).trim().split('\n').filter(Boolean).at(-1) || 'no output'}`);
      let envelope;
      try { envelope = JSON.parse(written.out); }
      catch { throw new Error(`the reply was not readable: ${written.out.trim().slice(0, 200) || '(empty)'}`); }
      const text = typeof envelope.result === 'string' ? envelope.result.trim() : '';
      if (envelope.is_error) throw new Error(envelope.result || 'the writer reported an error');
      if (!text) throw new Error('the reply came back empty');
      this.explained = { signature, text };
      this.explainError = null;
      return text;
    } catch (e) {
      // Kept and shown: "no summary this time" with no reason is not a report.
      this.explainError = e.message;
      return null;   // the facts and the agents' own words are still there
    } finally {
      if (this.explaining === signature) this.explaining = null;
    }
  }

  // What the batch actually did: each run's own account of itself, next to what
  // it changed. Written from what is already recorded, so it costs nothing and
  // cannot invent anything.
  async summarise() {
    const runs = this.list().filter(r => !r.supersededBy).reverse();
    const entries = [];
    for (const run of runs) {
      let said = null;
      if (!['running', 'waiting'].includes(run.status)) {
        const record = this.runs.get(run.id);
        if (record && !record.events.length && record.seq) await this.hydrate(record);
        const messages = (record?.events || []).filter(e => e.kind === 'message');
        said = messages.at(-1)?.text || null;
      }
      entries.push({
        id: run.id, agent: run.agent, label: run.label, status: run.status,
        task: run.prompt.split('\n')[0].slice(0, 160),
        files: run.diff.files, added: run.diff.added, removed: run.diff.removed,
        branch: run.branch, commit: run.commit, merged: run.merged?.onto || null,
        error: run.error, said
      });
    }
    const totals = entries.reduce((sum, e) => ({
      files: sum.files + e.files, added: sum.added + e.added, removed: sum.removed + e.removed,
      merged: sum.merged + (e.merged ? 1 : 0), unmerged: sum.unmerged + (e.commit && !e.merged ? 1 : 0)
    }), { files: 0, added: 0, removed: 0, merged: 0, unmerged: 0 });
    const working = entries.filter(e => ['running', 'waiting'].includes(e.status)).length;
    const signature = Runs.accountSignature(entries);
    // Tidied for reading; the untouched text stays available behind a toggle.
    // Tidied first, then trimmed: trimming first left half a code fence behind.
    for (const entry of entries) {
      entry.saidPlainly = entry.said ? Runs.tidy(entry.said).slice(0, 700) : null;
      entry.said = entry.said ? entry.said.slice(0, 700) : null;
    }
    return {
      entries, totals, working, signature,
      plain: this.explained?.signature === signature ? this.explained.text : null,
      writing: !!this.explaining,
      plainError: this.explained?.signature === signature ? null : this.explainError || null
    };
  }

  async summariseAndExplain() {
    const summary = await this.summarise();
    if (!summary.working && summary.entries.length && !summary.plain) void this.explain(summary);
    return summary;
  }

  // What this run changed: its own commit against the point it branched from,
  // so a follower shows its own work and not the run it built on.
  async changes(id) {
    const record = this.runs.get(id);
    if (!record) throw new Error('That run no longer exists.');
    const range = record.commit && record.baseCommit ? [`${record.baseCommit}..${record.commit}`] : [];
    const where = record.commit ? record.repo : record.dir;
    const [patch, stat] = await Promise.all([
      run('git', ['-C', where, '--no-pager', 'diff', '--unified=3', ...range]),
      run('git', ['-C', where, '--no-pager', 'diff', '--numstat', ...range])
    ]);
    if (patch.code !== 0) throw new Error('Could not read the changes for this run.');
    return { files: splitPatch(patch.out, stat.out), truncated: patch.out.length > PATCH_LIMIT };
  }

  // Where the project stands: what is on it, and what is not yet published.
  async projectStatus(repo) {
    const path = projectPath(repo);
    if (!(await stat(path).catch(() => null))?.isDirectory()) throw new Error(`There is no folder at ${path}.`);
    if ((await run('git', ['-C', path, 'rev-parse', '--show-toplevel'])).code !== 0)
      return { repo: path, git: false };
    const branch = (await run('git', ['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD'])).out.trim();
    const upstream = (await run('git', ['-C', path, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).out.trim();
    const dirty = (await run('git', ['-C', path, 'status', '--porcelain'])).out.trim();
    const ahead = upstream
      ? Number((await run('git', ['-C', path, 'rev-list', '--count', `${upstream}..HEAD`])).out.trim()) || 0
      : 0;
    return { repo: path, git: true, branch, upstream: upstream || null, ahead, dirty: !!dirty };
  }

  // Publishing is the one step here that leaves this computer, so it is never
  // part of merging: it is asked for on its own.
  async push(repo) {
    const where = await this.projectStatus(repo);
    if (!where.git) throw new Error('That folder is not a git repository.');
    if (!where.upstream) throw new Error(`${where.branch} has no upstream branch set, so there is nowhere to push it.`);
    if (!where.ahead) throw new Error('Everything on this branch is already pushed.');
    const pushed = await run('git', ['-C', where.repo, 'push']);
    if (pushed.code !== 0)
      throw new Error(pushed.err.trim().split('\n').filter(Boolean).at(-1) || 'The push failed.');
    return { branch: where.branch, upstream: where.upstream, commits: where.ahead };
  }

  // Everything finished and not yet merged, oldest first. A branch that already
  // contains another merges it too, so the later one becomes a no-op rather
  // than a conflict.
  mergeable() {
    return this.list()
      .filter(r => r.commit && !r.merged && !r.supersededBy && !['running', 'waiting'].includes(r.status))
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  async mergeAll({ force = false } = {}) {
    const waiting = this.mergeable();
    if (!waiting.length) throw new Error('There is nothing waiting to be merged.');
    const merged = [];
    for (const run of waiting) {
      try {
        const result = await this.merge(run.id, { force });
        merged.push({ id: run.id, agent: run.agent, onto: result.onto });
      } catch (e) {
        // Stop at the first refusal: the rest would land on a project that is
        // no longer in the state this decision was made about.
        return { merged, stoppedAt: { agent: run.agent, reason: e.message } };
      }
    }
    return { merged, stoppedAt: null };
  }

  // What this project uses to say whether it is sound. Read from its own
  // package.json rather than assumed, and skipped entirely when it has none.
  async checkCommands(dir) {
    const raw = await readOptional(join(dir, 'package.json'));
    if (!raw) return [];
    let scripts;
    try { scripts = JSON.parse(raw).scripts || {}; } catch { return []; }
    const commands = [];
    if (scripts.build) commands.push(['npm', ['run', 'build'], 'build']);
    // A watch-mode test script never exits; prefer the one meant for CI.
    const testScript = ['test:run', 'test:ci', 'test'].find(name => scripts[name]);
    if (testScript) commands.push(['npm', ['run', testScript], testScript]);
    return commands;
  }

  // Run them where the agent worked, so what is checked is what would be merged.
  async check(id) {
    const record = this.runs.get(id);
    if (!record) throw new Error('That run no longer exists.');
    if (!record.branch) return { checked: false, why: 'This run worked in the project itself, so there is nothing separate to check.', results: [] };
    const commands = await this.checkCommands(record.dir);
    if (!commands.length) return { checked: false, why: 'This project has no build or test script to run.', results: [] };
    if (!(await stat(join(record.dir, 'node_modules')).catch(() => null))?.isDirectory())
      return { checked: false, why: 'The agent never installed this project\'s dependencies, so its build and tests cannot be run here.', results: [] };

    const results = [];
    for (const [binary, args, label] of commands) {
      const started = Date.now();
      const finished = await run(binary, args, { cwd: record.dir, timeout: CHECK_TIMEOUT });
      const output = `${finished.out}\n${finished.err}`.trim().split('\n').filter(Boolean);
      results.push({
        label,
        ok: finished.code === 0,
        timedOut: finished.code === -2,
        seconds: Math.round((Date.now() - started) / 1000),
        tail: finished.code === 0 ? [] : output.slice(-12)
      });
    }
    record.checked = { at: Date.now(), ok: results.every(r => r.ok), results };
    await this.persist(record).catch(() => {});
    return { checked: true, why: null, results };
  }

  // Merge into whatever the project is currently on. Refused rather than forced
  // whenever the result would not be obvious.
  async merge(id, { force = false } = {}) {
    const record = this.runs.get(id);
    if (!record) throw new Error('That run no longer exists.');
    if (!record.branch || !record.commit) throw new Error('This run has nothing committed to merge.');
    if (record.merged) throw new Error('This run has already been merged.');
    // A branch whose work is already in the project has nothing left to give.
    const contained = await run('git', ['-C', record.repo, 'merge-base', '--is-ancestor', record.commit, 'HEAD']);
    if (contained.code === 0) {
      record.merged = { onto: (await run('git', ['-C', record.repo, 'rev-parse', '--abbrev-ref', 'HEAD'])).out.trim() || 'HEAD', at: Date.now(), already: true };
      await this.persist(record);
      return { id: record.id, onto: record.merged.onto, already: true };
    }
    if (record.status === 'running' || record.status === 'waiting') throw new Error('Wait for the run to finish first.');

    // Whether the work stands up, before it becomes the project's problem.
    if (!force) {
      const checked = await this.check(id);
      const failed = checked.results.filter(r => !r.ok);
      if (failed.length) {
        const named = failed.map(r => r.timedOut ? `${r.label} did not finish in time` : `${r.label} failed`).join(' and ');
        const why = failed[0].tail.slice(-4).join('\n');
        throw new Error(`Not merged: ${named}.${why ? `\n\n${why}` : ''}`);
      }
    }

    const dirty = await run('git', ['-C', record.repo, 'status', '--porcelain']);
    if (dirty.out.trim())
      throw new Error('Your project has uncommitted changes. Commit or stash them first, so a merge cannot bury them.');
    const onto = (await run('git', ['-C', record.repo, 'rev-parse', '--abbrev-ref', 'HEAD'])).out.trim() || 'HEAD';

    const merged = await run('git', ['-C', record.repo, 'merge', '--no-ff', '-m', `Merge ${record.branch}: ${record.prompt.split('\n')[0].slice(0, 60)}`, record.branch]);
    if (merged.code !== 0) {
      // Leave the project exactly as it was rather than mid-merge.
      const conflicts = (await run('git', ['-C', record.repo, 'diff', '--name-only', '--diff-filter=U'])).out.trim();
      await run('git', ['-C', record.repo, 'merge', '--abort']);
      throw new Error(conflicts
        ? `Merge stopped on conflicts in ${conflicts.split('\n').join(', ')}. Nothing was changed; merge it yourself to resolve them.`
        : (merged.err.trim().split('\n').at(-1) || 'The merge failed. Nothing was changed.'));
    }
    record.merged = { onto, at: Date.now() };
    await this.persist(record);
    return { id, onto };
  }

  async stop(id) {
    const record = this.runs.get(id);
    if (!record) throw new Error('That run no longer exists.');
    if (record.status === 'waiting') {
      record.status = 'stopped';
      record.endedAt = Date.now();
      record.headline = 'Cancelled before it started.';
      await this.persist(record);
      await this.release(record);
      return { id };
    }
    if (record.status !== 'running' || !record.child) throw new Error('That run is not active.');
    record.stopping = true;
    record.child.kill('SIGTERM');
    const child = record.child;
    setTimeout(() => { if (record.status === 'running') child.kill('SIGKILL'); }, 3000).unref?.();
    return { id };
  }

  async remove(id, branch = 'keep') {
    const record = this.runs.get(id);
    if (!record) throw new Error('That run no longer exists.');
    if (record.status === 'running') throw new Error('Stop the run before removing it.');
    if (record.branch) {
      await run('git', ['-C', record.repo, 'worktree', 'remove', '--force', record.dir]);
      await run('git', ['-C', record.repo, 'worktree', 'prune']);
      if (branch === 'delete') {
        // -D, not -d: an unmerged branch is exactly what discarding means.
        const deleted = await run('git', ['-C', record.repo, 'branch', '-D', record.branch]);
        if (deleted.code !== 0) throw new Error(`The worktree is gone but the branch could not be deleted: ${deleted.err.trim().split('\n').at(-1)}`);
      }
    }
    await rm(join(this.dir, id), { recursive: true, force: true });
    this.runs.delete(id);
    return { id };
  }

  // Clear out everything that has stopped. Branches are kept: the worktrees are
  // the bulk on disk, and the work itself lives in the branch.
  async removeFinished() {
    const finished = [...this.runs.values()].filter(r => !['running', 'waiting'].includes(r.status));
    if (!finished.length) throw new Error('There is nothing finished to remove.');
    let freed = 0;
    let removed = 0;
    for (const record of finished) {
      const size = record.size || 0;
      try {
        await this.remove(record.id);
        freed += size;
        removed += 1;
      } catch { /* leave the ones that will not go, and report the rest */ }
    }
    return { removed, freed, left: this.runs.size };
  }

  async shutdown() {
    for (const record of this.runs.values()) {
      if (record.child) { record.stopping = true; record.child.kill('SIGTERM'); }
      record.stream?.end();
    }
  }
}
