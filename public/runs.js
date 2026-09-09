const $ = id => document.getElementById(id);
let state = { runs: [], agents: [], accounts: [] };
let busy = false, selected = null, seq = 0;

let noticeTimer = null;
function notify(message, error = false) {
  $('notice').textContent = message;
  $('notice').className = error ? 'error' : '';
  clearTimeout(noticeTimer);
  // Errors stay until something replaces them; confirmations get out of the way.
  if (message && !error) noticeTimer = setTimeout(() => {
    if ($('notice').textContent === message) notify('');
  }, 6000);
}

async function postTo(url, data) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Dashboard-Token': state.token },
    body: JSON.stringify(data)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

async function post(route, data) {
  const response = await fetch(`/api/runs/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Dashboard-Token': state.token },
    body: JSON.stringify(data)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

async function act(route, data, message) {
  if (busy) return;
  busy = true;
  try {
    await post(route, data);
    notify(message);
    if (route === 'merge') await loadProject(true);
    await refresh();
  } catch (e) { notify(e.message, true); }
  finally { busy = false; render(); }
}

function since(from, to) {
  const seconds = Math.round(((to || Date.now()) - from) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}

// Sizes are only interesting once they are large; a few megabytes is noise.
function readableSize(bytes) {
  if (!bytes || bytes < 20 * 1024 * 1024) return null;
  const megabytes = bytes / (1024 * 1024);
  return megabytes >= 1024 ? `${(megabytes / 1024).toFixed(1)} GB` : `${Math.round(megabytes)} MB`;
}

function tag(parent, text, className = '') {
  const element = document.createElement('span');
  element.className = `tag ${className}`.trim();
  element.textContent = text;
  parent.append(element);
}

// A card is built once and updated in place. Rebuilding the list on every poll
// would flicker and drop focus from a button the moment it was clicked.
function card(id) {
  const article = document.createElement('article');
  const top = document.createElement('div');
  top.className = 'run-top';
  const dot = document.createElement('span'); dot.className = 'dot';
  const agent = document.createElement('span'); agent.className = 'run-agent';
  const status = document.createElement('span'); status.className = 'run-state';
  top.append(dot, agent, status);

  const title = document.createElement('h3');
  const more = document.createElement('button');
  more.className = 'more';
  more.type = 'button';
  more.addEventListener('click', () => {
    expanded.has(id) ? expanded.delete(id) : expanded.add(id);
    render();
  });
  const headline = document.createElement('div'); headline.className = 'headline';
  const meta = document.createElement('div'); meta.className = 'meta';
  const actions = document.createElement('div'); actions.className = 'run-actions';
  const open = document.createElement('button');
  const second = document.createElement('button');
  const carry = document.createElement('button');
  carry.textContent = 'Continue';
  carry.hidden = true;
  carry.addEventListener('click', () => act('continue', { id }, 'Carrying on from where it stopped.'));
  actions.append(open, second, carry);
  article.append(top, title, more, headline, meta, actions);

  open.addEventListener('click', () => select(id));
  second.addEventListener('click', () => {
    if (second.dataset.act === 'stop') return act('stop', { id }, 'Stopping the agent…');
    if (selected === id) closeDetail();
    return act('remove', { id }, 'Run removed. Its branch stays in the project.');
  });

  const update = run => {
    article.className = `run ${run.status}`;
    agent.textContent = run.label;
    status.textContent = `${run.status} · ${since(run.startedAt, run.endedAt)}`;
    title.textContent = run.prompt;
    // Task text runs to hundreds of words; two lines is enough to tell cards
    // apart, and the rest is one click away.
    // Not named `open`: that would shadow the View output button above, and
    // setting .textContent on a boolean fails silently.
    const showingAll = expanded.has(id);
    title.classList.toggle('open', showingAll);
    more.hidden = run.prompt.length <= 140;
    more.textContent = showingAll ? 'Show less' : 'Show the whole task';
    headline.textContent = run.error || run.commitError || run.headline || 'Waiting…';
    if (run.supersededBy) {
      headline.textContent = 'Picked up again by a later run.';
    } else if (run.after && run.status === 'waiting') {
      const leader = state.runs.find(r => r.id === run.after);
      headline.textContent = leader ? `Waiting for ${leader.label}: ${leader.prompt.slice(0, 60)}…` : 'Waiting for an earlier run…';
    }

    meta.replaceChildren();
    if (run.branch) tag(meta, run.branch);
    if (run.account) tag(meta, `account …${run.account.slice(-6)}`);
    if (run.sandbox === 'read-only') tag(meta, 'read only');
    if (run.diff.files) tag(meta, `${run.diff.files} file${run.diff.files === 1 ? '' : 's'}`);
    if (run.diff.added) tag(meta, `+${run.diff.added}`, 'add');
    if (run.diff.removed) tag(meta, `−${run.diff.removed}`, 'del');
    if (run.commit) tag(meta, `commit ${run.commit}`);
    const size = readableSize(run.size);
    if (size) tag(meta, `${size} on disk`);
    if (run.supersededBy) tag(meta, 'picked up again');
    if (run.continues) tag(meta, `attempt ${attemptNumber(run)}`);
    if (run.merged) {
      const badge = document.createElement('span');
      badge.className = 'merged';
      badge.textContent = `merged into ${run.merged.onto}`;
      meta.append(badge);
    }
    if (run.commitError) tag(meta, 'not committed', 'del');

    open.textContent = selected === id ? 'Viewing output' : 'View output';
    open.disabled = selected === id;
    second.dataset.act = run.status === 'running' ? 'stop' : 'remove';
    second.textContent = run.status === 'running' ? 'Stop' : 'Remove';
    second.disabled = busy;
    // Offered on any run that stopped early and has not been picked up yet.
    carry.hidden = !run.canCarryOn;
    carry.disabled = busy;
    carry.textContent = run.commit ? 'Continue' : 'Run it again';
  };
  return { article, update };
}

const cards = new Map();
const groups = new Map();     // one section per project folder
const expanded = new Set();      // run ids whose task is shown in full
let showEarlier = false;         // whether superseded attempts are listed
let forceKeepAll = false;        // checks failed and were overridden

// ---- what was done --------------------------------------------------------
// Assembled from what each run recorded and said about itself. No model is
// asked to write this: it costs nothing and cannot embellish.
let summaryHidden = false;
let summaryFor = '';

function summaryText(summary) {
  const lines = ['# What the agents did', ''];
  if (summary.plain) lines.push(summary.plain, '');
  for (const entry of summary.entries) {
    const changed = entry.files ? `${entry.files} file${entry.files === 1 ? '' : 's'}, +${entry.added} −${entry.removed}` : 'no files changed';
    lines.push(`## ${entry.label} — ${entry.status}`);
    lines.push(`Task: ${entry.task}`);
    lines.push(`Changed: ${changed}${entry.branch ? ` on ${entry.branch}` : ''}${entry.merged ? ` (merged into ${entry.merged})` : ''}`);
    if (entry.error) lines.push(`Note: ${entry.error}`);
    if (entry.said) lines.push('', entry.said);
    lines.push('');
  }
  const t = summary.totals;
  lines.push(`Altogether: ${t.files} files, +${t.added} −${t.removed}. ${t.merged} merged, ${t.unmerged} waiting.`);
  return lines.join('\n');
}

let summaryDetails = false;

function renderPlain(summary) {
  const panel = $('summary-plain');
  panel.replaceChildren();
  if (!summary.plain) {
    const waiting = document.createElement('span');
    waiting.className = 'waiting';
    waiting.textContent = summary.writing
      ? 'Writing a plain summary…'
      : summary.plainError
        ? `The plain summary could not be written — ${summary.plainError} The details are below.`
        : 'No plain summary this time — the details are below.';
    panel.append(waiting);
    $('summary-body').hidden = !!summary.writing;
    return;
  }
  // The closing "Next:" line is the actionable part, so it is set apart.
  const [account, ...rest] = summary.plain.split(/\n(?=Next:)/);
  panel.append(document.createTextNode(account.trim()));
  if (rest.length) {
    const next = document.createElement('strong');
    next.className = 'next';
    next.textContent = rest.join('\n').trim();
    panel.append(next);
  }
  $('summary-body').hidden = !summaryDetails;
}

function renderSummary(summary) {
  const body = $('summary-body');
  body.replaceChildren();
  for (const entry of summary.entries) {
    const row = document.createElement('div');
    row.className = 'summary-row';
    const line = document.createElement('div');
    line.className = 'summary-line';
    const who = document.createElement('strong');
    who.textContent = entry.label;
    const what = document.createElement('span');
    what.className = 'what';
    what.textContent = entry.task;
    line.append(who, what);
    if (entry.files) tag(line, `${entry.files} file${entry.files === 1 ? '' : 's'}`);
    if (entry.added) tag(line, `+${entry.added}`, 'add');
    if (entry.removed) tag(line, `−${entry.removed}`, 'del');
    if (entry.merged) tag(line, `merged into ${entry.merged}`, 'add');
    else if (entry.commit) tag(line, 'not merged');
    row.append(line);

    const said = document.createElement('p');
    said.className = entry.saidPlainly ? 'said' : 'said none';
    said.textContent = entry.saidPlainly || entry.error || 'It finished without saying anything.';
    row.append(said);
    body.append(row);
  }
  const t = summary.totals;
  $('summary-totals').textContent =
    `Altogether ${t.files} file${t.files === 1 ? '' : 's'}, +${t.added} −${t.removed}. ` +
    `${t.merged} merged, ${t.unmerged} still waiting to be kept.`;
}

async function loadSummary() {
  const finished = state.runs.filter(r => !r.supersededBy);
  const working = finished.filter(r => ['running', 'waiting'].includes(r.status)).length;
  // Only once everything has settled: a summary of half a batch is noise.
  if (working || !finished.length) { $('summary').hidden = true; return; }
  if (summaryHidden) { $('summary').hidden = true; return; }
  const signature = finished.map(r => `${r.id}:${r.status}:${r.merged ? 1 : 0}`).join(',');
  if (signature === summaryFor) return;
  try {
    const response = await fetch('/api/runs/summary');
    if (!response.ok) return;
    const summary = await response.json();
    summaryFor = summary.plain || !summary.writing ? signature : '';   // re-ask while it is being written
    renderSummary(summary);
    renderPlain(summary);
    $('summary').hidden = false;
    $('summary').dataset.text = summaryText(summary);
  } catch { /* the next tick tries again */ }
}

// ---- telling you it finished ----------------------------------------------
// Runs take minutes, so the window is usually behind something by the time one
// lands. Only the native app can raise a notification; a browser gets the
// on-page message and nothing more.
const lastStatus = new Map();

function announce(title, body) {
  if (!window.dashboardNative) return;
  try { window.webkit.messageHandlers.notify.postMessage({ title, body }); } catch { /* no bridge */ }
}

// Said once, and only where a banner was actually expected.
let mentionedNotifications = false;
function checkNotificationPermission() {
  if (mentionedNotifications || !window.dashboardNative) return;
  if (window.dashboardNotifications !== false) return;
  mentionedNotifications = true;
  notify('Notifications are off for Master AI, so finished runs bounce the Dock icon instead. Turn them on in System Settings → Notifications.', true);
}

const ENDED = { done: 'finished', failed: 'failed', stopped: 'was stopped', interrupted: 'was interrupted', skipped: 'was skipped' };

function announceFinished(runs) {
  const first = lastStatus.size === 0;
  const landed = [];
  for (const run of runs) {
    const before = lastStatus.get(run.id);
    lastStatus.set(run.id, run.status);
    // A run seen for the first time is the current state, not news.
    if (first || before === undefined || before === run.status) continue;
    if (!['running', 'waiting'].includes(before) || !ENDED[run.status]) continue;
    landed.push(run);
  }
  if (!landed.length) return;
  checkNotificationPermission();
  const busy = runs.filter(r => ['running', 'waiting'].includes(r.status)).length;
  for (const run of landed) {
    const changed = run.diff.files ? `${run.diff.files} file${run.diff.files === 1 ? '' : 's'} changed` : 'nothing changed';
    announce(`${run.label} ${ENDED[run.status]}`, run.status === 'done' ? changed : (run.error || changed));
  }
  if (!busy) announce('All agents finished', `${runs.filter(r => r.status === 'done').length} of ${runs.length} finished cleanly.`);
}

// ---- publishing -----------------------------------------------------------
// Pushing leaves this computer and, on a branch that deploys, changes what is
// live. It is a separate, deliberate step from merging, and it asks twice.
let project = { git: false };
let projectFor = null;
let projectAt = 0;
let armedPush = false;
const PROJECT_TTL = 4000;

async function loadProject(force = false) {
  const repo = $('repo').value.trim();
  if (!repo) { project = { git: false }; projectFor = null; return renderPush(); }
  // Re-read on a timer, not just when the folder changes: merging alters how
  // much is unpushed, and a cached reading kept the Push button hidden.
  if (!force && projectFor === repo && Date.now() - projectAt < PROJECT_TTL) return;
  projectFor = repo;
  projectAt = Date.now();
  try {
    const response = await fetch(`/api/project?repo=${encodeURIComponent(repo)}`);
    const result = await response.json();
    if (projectFor === repo) { project = result; renderPush(); }
  } catch { /* the next tick tries again */ }
}

function renderPush() {
  const button = $('push');
  const ready = project.git && project.upstream && project.ahead > 0;
  button.hidden = !ready;
  button.disabled = busy;
  button.classList.toggle('arming', armedPush);
  if (!ready) { armedPush = false; return; }
  button.textContent = armedPush
    ? `Push to ${project.upstream}?`
    : `Push ${project.ahead} commit${project.ahead === 1 ? '' : 's'}`;
  button.title = `Sends ${project.branch} to ${project.upstream}. If that branch deploys, this publishes it.`;
}

// ---- project keys ---------------------------------------------------------
// Values are write-only: saved keys come back as a name and a hint, never as
// the secret itself, so the page cannot leak what it never holds.
let keys = [];
let keysFor = null;

function renderKeys() {
  const list = $('key-list');
  list.replaceChildren();
  if (!$('repo').value.trim()) {
    list.append(Object.assign(document.createElement('span'), { className: 'key-none', textContent: 'Choose a project folder first.' }));
    return;
  }
  if (!keys.length) {
    list.append(Object.assign(document.createElement('span'), { className: 'key-none', textContent: 'No keys yet. Agents will run without them.' }));
    return;
  }
  for (const key of keys) {
    const chip = document.createElement('span');
    chip.className = 'key';
    const name = document.createElement('code');
    name.textContent = key.name;
    const value = document.createElement('span');
    value.className = 'val';
    value.textContent = key.hint;
    const drop = document.createElement('button');
    drop.type = 'button';
    drop.textContent = '×';
    drop.setAttribute('aria-label', `Remove ${key.name}`);
    drop.disabled = busy;
    drop.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      try {
        await postTo('/api/secrets/remove', { repo: $('repo').value, name: key.name });
        notify(`Removed ${key.name}.`);
        await loadKeys(true);
      } catch (e) { notify(e.message, true); }
      finally { busy = false; render(); }
    });
    chip.append(name, value, drop);
    list.append(chip);
  }
}

async function loadKeys(force = false) {
  const repo = $('repo').value.trim();
  if (!repo) { keys = []; keysFor = null; return renderKeys(); }
  if (!force && keysFor === repo) return;
  keysFor = repo;
  try {
    const response = await fetch(`/api/secrets?repo=${encodeURIComponent(repo)}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    if (keysFor === repo) { keys = result.keys; renderKeys(); }
  } catch { keys = []; renderKeys(); }
}

// ---- planning -------------------------------------------------------------
// Proposed tasks live only in the page until dispatched, so they stay editable
// and nothing is spawned by planning alone.
let tasks = [];

function taskRow(task, index) {
  const article = document.createElement('article');
  article.className = 'task';

  const top = document.createElement('div');
  top.className = 'task-top';
  const title = document.createElement('h3');
  title.textContent = `${index + 1}. ${task.title}`;

  const agent = document.createElement('select');
  agent.replaceChildren(...state.agents.map(a => new Option(a.label, a.id)));
  agent.value = task.agent;
  agent.setAttribute('aria-label', `Agent for ${task.title}`);
  agent.addEventListener('change', () => { task.agent = agent.value; });

  const after = document.createElement('select');
  const options = [new Option('Starts right away', '')];
  tasks.forEach((other, i) => { if (i < index) options.push(new Option(`After ${i + 1}. ${other.title}`, String(i))); });
  after.replaceChildren(...options);
  after.value = task.after === null || task.after === undefined ? '' : String(task.after);
  after.setAttribute('aria-label', `When ${task.title} starts`);
  after.addEventListener('change', () => { task.after = after.value === '' ? null : Number(after.value); });

  const drop = document.createElement('button');
  drop.className = 'drop';
  drop.textContent = 'Remove';
  drop.addEventListener('click', () => {
    tasks.splice(index, 1);
    // Anything that pointed at a removed or shifted task has to be repaired.
    tasks.forEach((other, i) => {
      if (other.after === null) return;
      if (other.after === index) other.after = null;
      else if (other.after > index) other.after -= 1;
      if (other.after !== null && other.after >= i) other.after = null;
    });
    renderTasks();
  });

  const role = document.createElement('p');
  role.className = 'task-role';
  // The planner's reason for this agent, so the choice can be judged and
  // changed. Its own description takes over once you pick someone else.
  const chosenByPlanner = task.agent;
  const describe = () => {
    role.textContent = task.agent === chosenByPlanner && task.why
      ? task.why
      : state.agents.find(a => a.id === task.agent)?.strength || '';
  };
  describe();
  agent.addEventListener('change', describe);

  top.append(title, agent, after, drop, role);

  const prompt = document.createElement('textarea');
  prompt.rows = 4;
  prompt.value = task.prompt;
  prompt.setAttribute('aria-label', `Instructions for ${task.title}`);
  prompt.addEventListener('input', () => { task.prompt = prompt.value; });

  article.append(top, prompt);
  return article;
}

// How many times this task has been picked up, counting back through the chain.
function attemptNumber(run) {
  let count = 1;
  let at = run.continues;
  const seen = new Set();
  while (at && !seen.has(at)) {
    seen.add(at);
    count += 1;
    at = state.runs.find(r => r.id === at)?.continues || null;
  }
  return count;
}

function renderKeyButtons() {
  $('key-save').disabled = busy;
  document.querySelectorAll('.key button').forEach(button => { button.disabled = busy; });
}

function renderTasks() {
  $('tasks').hidden = !tasks.length;
  $('task-count').textContent = tasks.length;
  // Say where they will run, so an empty or wrong folder is visible before the
  // click rather than as an error after it.
  const repo = $('repo').value.trim();
  $('task-where').textContent = repo ? `in ${repo}` : 'no project folder chosen';
  $('task-list').replaceChildren(...tasks.map(taskRow));
}

// Throwing away deletes an unmerged branch, so it asks once.
let confirmingDiscard = null;
function confirmDiscard(run) {
  if (confirmingDiscard === run?.id) { confirmingDiscard = null; return true; }
  confirmingDiscard = run?.id;
  $('discard-branch').textContent = 'Throw away for good?';
  setTimeout(() => {
    if (confirmingDiscard !== run?.id) return;
    confirmingDiscard = null;
    $('discard-branch').textContent = 'Throw away';
  }, 5000);
  return false;
}

async function dispatch() {
  if (!tasks.length) return;
  if (busy) return notify('Something else is still finishing. Try again in a moment.', true);
  busy = true;
  $('dispatch').disabled = true;
  const started = [];
  try {
    // In order, so a task that follows another already has its id to point at.
    for (const [index, task] of tasks.entries()) {
      const { id } = await post('start', {
        agent: task.agent,
        prompt: task.prompt,
        repo: $('repo').value,
        account: task.agent === 'codex' ? $('account').value || null : null,
        worktree: $('worktree').checked,
        sandbox: $('readonly').checked ? 'read-only' : 'workspace-write',
        after: task.after === null || task.after === undefined ? null : started[task.after] || null
      });
      started[index] = id;
    }
    tasks = [];
    renderTasks();
    summaryHidden = false;
    summaryFor = '';
    notify(`Started ${started.length} agent${started.length === 1 ? '' : 's'}.`);
    await refresh();
  } catch (e) {
    notify(started.length
      ? `Started ${started.length} of ${tasks.length}, then stopped: ${e.message}`
      : `Could not start: ${e.message}`, true);
    await refresh().catch(() => {});
  } finally { busy = false; $('dispatch').disabled = false; render(); }
}

let modelChoices = { suggestions: {}, efforts: [] };

async function loadModelChoices() {
  try {
    const response = await fetch('/api/models');
    if (response.ok) modelChoices = await response.json();
  } catch { /* suggestions are a convenience, not a requirement */ }
}

function modelPicker(agent) {
  const row = document.createElement('div');
  row.className = 'model-picker';

  const chosenHere = agent.source === 'set here';
  const field = document.createElement('input');
  field.type = 'text';
  field.spellcheck = false;
  // What it will actually use shows as the placeholder when it was not chosen
  // here, so the box says the model rather than the word "Default".
  field.placeholder = !chosenHere && agent.model ? agent.model : 'Default';
  field.value = chosenHere ? agent.model || '' : '';
  field.setAttribute('aria-label', `Model for ${agent.label}`);
  const listId = `models-${agent.id}`;
  const options = modelChoices.suggestions?.[agent.id] || [];
  if (options.length) {
    field.setAttribute('list', listId);
    const list = document.createElement('datalist');
    list.id = listId;
    list.replaceChildren(...options.map(name => { const o = document.createElement('option'); o.value = name; return o; }));
    row.append(list);
  }

  let effort = null;
  if (agent.efforts?.length) {
    effort = document.createElement('select');
    effort.setAttribute('aria-label', `Reasoning effort for ${agent.label}`);
    const current = !chosenHere && agent.effort ? `${agent.effort} (its own)` : 'Default effort';
    effort.replaceChildren(
      new Option(current, ''),
      ...agent.efforts.map(name => new Option(name, name))
    );
    effort.value = chosenHere ? agent.effort || '' : '';
    // Devin has no effort flag; the level is part of the model name.
    if (agent.effortInModel) effort.title = 'Devin puts the level in the model name, so it needs a model chosen too.';
  }

  const save = async () => {
    if (busy) return;
    busy = true;
    try {
      await postTo('/api/models/set', { agent: agent.id, model: field.value, effort: effort ? effort.value : null });
      notify(field.value.trim()
        ? `${agent.label} will use ${field.value.trim()}${effort?.value ? ` on ${effort.value}` : ''}.`
        : `${agent.label} is back to its own default.`);
      await refresh();
    } catch (e) { notify(e.message, true); field.value = agent.model || ''; }
    finally { busy = false; render(); }
  };
  field.addEventListener('change', save);
  if (effort) effort.addEventListener('change', save);

  row.append(field);
  if (effort) row.append(effort);
  return row;
}

function renderRoster() {
  const roster = $('roster');
  const signature = JSON.stringify(state.agents.map(a => [a.id, a.model, a.effort]));
  if (roster.dataset.built === signature) return;
  roster.dataset.built = signature;
  roster.replaceChildren(...state.agents.map(agent => {
    const card = document.createElement('article');
    const name = document.createElement('h3');
    name.textContent = agent.label;
    const role = document.createElement('p');
    role.textContent = agent.strength || 'General purpose';
    card.append(name, role);
    if (agent.planner === false) {
      const aside = document.createElement('p');
      aside.className = 'aside';
      aside.textContent = 'Not assigned by the planner — pick it yourself';
      card.append(aside);
    }
    // Everything below sits in a footer pinned to the bottom of the card, so
    // the boxes line up across the row however long each description runs.
    const footer = document.createElement('div');
    footer.className = 'card-footer';
    footer.append(modelPicker(agent));
    card.append(footer);
    const source = document.createElement('p');
    source.className = 'model';
    // The boxes above already show what will be used, so this only says where
    // that came from.
    if (agent.effortInModel && agent.effort && !agent.model) {
      source.textContent = 'Needs a model too — Devin puts the level in its name';
    } else if (agent.model || agent.effort) {
      source.textContent = `From ${agent.source}`;
    } else {
      source.textContent = 'Using the agent default';
    }
    source.title = agent.model
      ? `${agent.model}${agent.effort ? ` · ${agent.effort}` : ''} — from ${agent.source}`
      : `Using ${agent.source}`;
    footer.append(source);
    return card;
  }));
}

// Progress across the batch: what is finished out of what was started.
// Swapped in once, when the page learns a picture is there.
let runnerPicture = false;
function renderRunner() {
  if (!state.runner || runnerPicture) return;
  runnerPicture = true;
  const picture = document.createElement('img');
  picture.src = '/runner';
  picture.alt = '';
  // If it will not load, the drawn one stays rather than leaving a gap.
  picture.addEventListener('error', () => { picture.remove(); runnerPicture = false; });
  picture.addEventListener('load', () => { $('runner').querySelector('svg')?.remove(); });
  $('runner').append(picture);
}

function renderProgress(runs) {
  renderRunner();
  const busy = runs.filter(r => ['running', 'waiting'].includes(r.status));
  const settled = runs.filter(r => !['running', 'waiting'].includes(r.status));
  const total = busy.length + settled.length;
  $('progress').hidden = !busy.length;
  if (!busy.length) return;
  const done = settled.length;
  $('progress-fill').style.width = `${Math.round((done / total) * 100)}%`;
  const working = busy.filter(r => r.status === 'running');
  const queued = busy.filter(r => r.status === 'waiting');
  const parts = [`${done} of ${total} finished`];
  if (working.length) parts.push(`${working.map(r => r.label).join(', ')} working`);
  if (queued.length) parts.push(`${queued.length} queued`);
  $('progress-text').textContent = parts.join(' · ');
}

function render() {
  $('count').textContent = state.runs.filter(r => !r.supersededBy).length;
  const running = state.runs.filter(r => r.status === 'running').length;
  $('active').textContent = running ? `${running} running` : 'None running';
  renderProgress(state.runs.filter(r => !r.supersededBy));

  // Merging everything is offered only when there is more than one thing to
  // merge; a single run is merged from its own card.
  const waiting = state.runs.filter(r => r.commit && !r.merged && !r.supersededBy && !['running', 'waiting'].includes(r.status));
  $('keep-all').hidden = waiting.length < 2 || running > 0;
  $('keep-all').textContent = forceKeepAll ? `Keep all ${waiting.length} anyway` : `Keep all ${waiting.length}`;
  $('keep-all').disabled = busy;

  // Worktrees are the bulk on disk, so offer to clear the finished ones.
  const finished = state.runs.filter(r => !['running', 'waiting'].includes(r.status));
  const held = finished.reduce((total, r) => total + (r.size || 0), 0);
  const heldText = readableSize(held);
  $('tidy').hidden = !finished.length;
  $('tidy').textContent = `Remove ${finished.length} finished${heldText ? ` · ${heldText}` : ''}`;
  $('tidy').disabled = busy;

  // An attempt that has been picked up again is the same piece of work, so it
  // is folded away rather than shown beside its replacement.
  const earlier = state.runs.filter(r => r.supersededBy);
  const visible = showEarlier ? state.runs : state.runs.filter(r => !r.supersededBy);
  $('earlier').hidden = !earlier.length;
  $('earlier').textContent = showEarlier
    ? `Hide ${earlier.length} earlier attempt${earlier.length === 1 ? '' : 's'}`
    : `Show ${earlier.length} earlier attempt${earlier.length === 1 ? '' : 's'}`;

  for (const id of cards.keys()) {
    if (visible.some(r => r.id === id)) continue;
    cards.get(id).article.remove();
    cards.delete(id);
  }
  if (!visible.length) {
    groups.clear();
    const empty = document.createElement('div');
    empty.className = 'empty';
    const title = document.createElement('h3'); title.textContent = 'No agents yet.';
    const detail = document.createElement('p'); detail.textContent = 'Pick a project folder, describe the task, and start one.';
    empty.append(title, detail);
    if (!$('runs').querySelector('.empty')) $('runs').replaceChildren(empty);
  } else {
    $('runs').querySelector('.empty')?.remove();
  }

  // Grouped by project, because several can be running at once and a single
  // list of cards says nothing about which is which.
  const byProject = new Map();
  for (const run of visible) {
    if (!byProject.has(run.repo)) byProject.set(run.repo, []);
    byProject.get(run.repo).push(run);
  }
  const here = $('repo').value.trim();
  const order = [...byProject.keys()].sort((a, b) => {
    // The folder being worked on comes first; the rest by their newest run.
    if ((a === here) !== (b === here)) return a === here ? -1 : 1;
    return byProject.get(b)[0].startedAt - byProject.get(a)[0].startedAt;
  });

  for (const repo of groups.keys()) {
    if (byProject.has(repo)) continue;
    groups.get(repo).section.remove();
    groups.delete(repo);
  }

  order.forEach((repo, position) => {
    let group = groups.get(repo);
    if (!group) {
      const section = document.createElement('section');
      section.className = 'project-group';
      const head = document.createElement('div');
      head.className = 'group-head';
      const name = document.createElement('h3');
      const count = document.createElement('span');
      count.className = 'tag';
      head.append(name, count);
      const grid = document.createElement('div');
      grid.className = 'grid';
      section.append(head, grid);
      group = { section, name, count, grid };
      groups.set(repo, group);
    }
    const runs = byProject.get(repo);
    group.name.textContent = repo.split('/').filter(Boolean).pop() || repo;
    group.name.title = repo;
    group.section.classList.toggle('current', repo === here);
    const working = runs.filter(r => ['running', 'waiting'].includes(r.status)).length;
    group.count.textContent = working ? `${runs.length} · ${working} working` : `${runs.length}`;
    if ($('runs').children[position] !== group.section) $('runs').insertBefore(group.section, $('runs').children[position] || null);

    runs.forEach((run, index) => {
      let entry = cards.get(run.id);
      if (!entry) {
        entry = card(run.id);
        cards.set(run.id, entry);
      }
      entry.update(run);
      // Newest first; only move a card when it is not already in place.
      if (group.grid.children[index] !== entry.article) group.grid.insertBefore(entry.article, group.grid.children[index] || null);
    });
  });

  renderKeyButtons();
  renderPush();
  const current = state.runs.find(r => r.id === selected);
  if (!current && selected) closeDetail();
  else if (current) {
    $('detail-title').textContent = `${current.label} · ${current.merged ? `merged into ${current.merged.onto}` : current.status}`;
    // Keeping or throwing away only makes sense once there is a commit to act on.
    const decidable = !!current.commit && !current.merged && current.status !== 'running' && current.status !== 'waiting';
    $('merge').hidden = !decidable;
    $('merge').textContent = forceMerge === current.id ? 'Keep it anyway' : 'Keep it';
    $('discard-branch').hidden = !current.branch || current.status === 'running' || current.status === 'waiting';
    $('merge').disabled = busy;
    $('discard-branch').disabled = busy;
  }
}

function appendLog(events) {
  for (const event of events) {
    const line = document.createElement('div');
    line.className = `line ${event.kind}`;
    const time = document.createElement('span');
    time.textContent = new Date(event.ts).toLocaleTimeString([], { hour12: false });
    const body = document.createElement('p');
    body.textContent = event.text;
    line.append(time, body);
    $('log').append(line);
  }
  if (events.length) $('log').scrollTop = $('log').scrollHeight;
}

// ---- reviewing --------------------------------------------------------------
let view = 'log';

function diffLine(text) {
  const line = document.createElement('code');
  line.className = text.startsWith('+') ? 'add' : text.startsWith('-') ? 'del' : text.startsWith('@@') ? 'hunk' : '';
  // A blank context line still needs height, hence the space.
  line.textContent = text || ' ';
  return line;
}

function renderDiff(result) {
  const panel = $('diff');
  panel.replaceChildren();
  if (!result.files.length) {
    const empty = document.createElement('p');
    empty.className = 'none';
    empty.textContent = 'This run did not change any files.';
    panel.append(empty);
    return;
  }
  for (const file of result.files) {
    const block = document.createElement('div');
    block.className = 'diff-file';
    const name = document.createElement('div');
    name.className = 'diff-name';
    const path = document.createElement('span');
    path.textContent = file.path;
    const counts = document.createElement('span');
    counts.className = 'counts';
    const plus = document.createElement('span');
    plus.className = 'plus';
    plus.textContent = `+${file.added}`;
    const minus = document.createElement('span');
    minus.className = 'minus';
    minus.textContent = `−${file.removed}`;
    counts.append(plus, minus);
    name.append(path, counts);

    const body = document.createElement('pre');
    body.append(...file.lines.map(diffLine));
    block.append(name, body);
    if (file.truncated) {
      const cut = document.createElement('p');
      cut.className = 'cut';
      cut.textContent = 'Too long to show in full — open the branch to read the rest.';
      block.append(cut);
    }
    panel.append(block);
  }
}

async function loadDiff() {
  if (!selected) return;
  const id = selected;
  $('diff').replaceChildren(Object.assign(document.createElement('p'), { className: 'none', textContent: 'Reading the changes…' }));
  try {
    const response = await fetch(`/api/runs/changes?id=${encodeURIComponent(id)}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    if (selected === id) renderDiff(result);
  } catch (e) {
    if (selected === id) $('diff').replaceChildren(Object.assign(document.createElement('p'), { className: 'none', textContent: e.message }));
  }
}

function setView(next) {
  view = next;
  $('tab-log').classList.toggle('on', view === 'log');
  $('tab-diff').classList.toggle('on', view === 'diff');
  $('log').hidden = view !== 'log';
  $('diff').hidden = view !== 'diff';
  if (view === 'diff') void loadDiff();
}

function select(id) {
  selected = id;
  seq = 0;
  $('detail').hidden = false;
  setView('log');
  $('log').replaceChildren();
  const waiting = document.createElement('p');
  waiting.className = 'empty-log';
  waiting.textContent = 'Loading output…';
  $('log').append(waiting);
  render();
  void pollLog();
}

function closeDetail() {
  selected = null;
  forceMerge = null;
  confirmingDiscard = null;
  $('discard-branch').textContent = 'Throw away';
  $('detail').hidden = true;
  $('log').replaceChildren();
}

async function pollLog() {
  if (!selected) return;
  const id = selected;
  try {
    const response = await fetch(`/api/runs/log?id=${encodeURIComponent(id)}&from=${seq}`);
    if (!response.ok) throw new Error('Output unavailable.');
    const result = await response.json();
    if (selected !== id) return;
    if (!seq) {
      $('log').replaceChildren();
      if (!result.events.length) {
        const waiting = document.createElement('p');
        waiting.className = 'empty-log';
        waiting.textContent = 'No output yet.';
        $('log').append(waiting);
      }
    }
    seq = result.seq;
    appendLog(result.events);
  } catch { /* the next tick retries */ }
}

async function refresh() {
  const response = await fetch('/api/runs');
  if (!response.ok) throw new Error('Could not load agents.');
  const next = await response.json();
  state = next;
  announceFinished(state.runs.filter(r => !r.supersededBy));
  void loadSummary();
  if ($('agent').options.length !== state.agents.length) {
    $('agent').replaceChildren(...state.agents.map(agent => new Option(agent.label, agent.id)));
  }
  const accounts = ['', ...state.accounts.map(a => a.id)].join(',');
  if ($('account').dataset.accounts !== accounts) {
    $('account').dataset.accounts = accounts;
    $('account').replaceChildren(
      new Option('Terminal default', ''),
      ...state.accounts.map(a => new Option(a.email, a.id))
    );
  }
  renderRoster();
  syncAccount();
  void loadProject();
  render();
}

// Only Codex runs take an account here; Claude Code uses its own login.
function syncAccount() {
  const chosen = state.agents.find(a => a.id === $('agent').value);
  $('agent-role').textContent = [chosen?.strength, chosen?.model].filter(Boolean).join(' · ');
  const codex = $('agent').value === 'codex';
  $('account').disabled = !codex;
  $('account').title = codex ? '' : 'Claude Code uses its own login.';
}

$('plan').addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  $('plan').disabled = true;
  $('plan').textContent = 'Reading the project…';
  notify('Claude is planning. This takes about a minute.');
  try {
    const result = await post('plan', { goal: $('goal').value, repo: $('repo').value });
    // Remember it here too: a page reload between planning and starting used to
    // leave the field empty while the tasks were still on screen.
    try { localStorage.setItem('repo', $('repo').value.trim()); } catch { /* private window */ }
    tasks = result.tasks;
    renderTasks();
    notify(`${tasks.length} tasks proposed. Edit anything you like, then start them.`);
  } catch (e) { notify(e.message, true); }
  finally { busy = false; $('plan').disabled = false; $('plan').textContent = 'Plan the work'; render(); }
});
$('discard').addEventListener('click', () => { tasks = []; renderTasks(); });
$('dispatch').addEventListener('click', dispatch);
$('agent').addEventListener('change', syncAccount);
$('push').addEventListener('click', async () => {
  if (busy) return notify('Something else is still finishing. Try again in a moment.', true);
  if (!armedPush) {
    armedPush = true;
    renderPush();
    notify(`This sends ${project.ahead} commit${project.ahead === 1 ? '' : 's'} to ${project.upstream}. If that branch deploys, it goes live. Click again to confirm.`, true);
    setTimeout(() => { if (armedPush) { armedPush = false; renderPush(); } }, 8000);
    return;
  }
  armedPush = false;
  busy = true;
  renderPush();
  try {
    const result = await post('push', { repo: $('repo').value });
    notify(`Pushed ${result.commits} commit${result.commits === 1 ? '' : 's'} to ${result.upstream}.`);
    await loadProject(true);
  } catch (e) { notify(e.message, true); }
  finally { busy = false; render(); }
});
$('keep-all').addEventListener('click', async () => {
  if (busy) return notify('Something else is still finishing. Try again in a moment.', true);
  busy = true;
  $('keep-all').disabled = true;
  $('keep-all').textContent = 'Checking the code…';
  try {
    const result = await post('merge-all', { force: forceKeepAll });
    if (result.stoppedAt) {
      forceKeepAll = /^Not merged:/.test(result.stoppedAt.reason);
      notify(result.merged.length
        ? `Kept ${result.merged.length}, then stopped at ${result.stoppedAt.agent}: ${result.stoppedAt.reason}`
        : `Could not merge: ${result.stoppedAt.reason}`, true);
    } else {
      forceKeepAll = false;
      notify(`Kept all ${result.merged.length}. Merged into ${result.merged[0].onto} — not pushed yet.`);
    }
    await loadProject(true);
    await refresh();
  } catch (e) { notify(e.message, true); }
  finally { busy = false; render(); }
});
$('hide-summary').addEventListener('click', () => { summaryHidden = true; $('summary').hidden = true; });
$('detail-summary').addEventListener('click', () => {
  summaryDetails = !summaryDetails;
  $('summary-body').hidden = !summaryDetails;
  $('detail-summary').textContent = summaryDetails ? 'Hide the details' : 'Show the details';
});
$('copy-summary').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('summary').dataset.text || '');
    notify('Summary copied.');
  } catch { notify('Could not copy — select the text instead.', true); }
});
$('tidy').addEventListener('click', async () => {
  if (busy) return notify('Something else is still finishing. Try again in a moment.', true);
  busy = true;
  $('tidy').disabled = true;
  try {
    const result = await post('remove-finished', {});
    const freed = readableSize(result.freed);
    notify(`Removed ${result.removed} finished run${result.removed === 1 ? '' : 's'}${freed ? `, freeing ${freed}` : ''}. Their branches are still in the project.`);
    closeDetail();
    await refresh();
  } catch (e) { notify(e.message, true); }
  finally { busy = false; render(); }
});
$('earlier').addEventListener('click', () => { showEarlier = !showEarlier; render(); });
$('tab-log').addEventListener('click', () => setView('log'));
$('tab-diff').addEventListener('click', () => setView('diff'));
let forceMerge = null;   // the run whose failed checks have been overridden

async function keepIt(force) {
  const id = selected;
  if (!id || busy) return;
  busy = true;
  $('merge').disabled = true;
  $('merge').textContent = force ? 'Merging…' : 'Checking the code…';
  try {
    await post('merge', { id, force });
    forceMerge = null;
    await loadProject(true);
    await refresh();
    const after = state.runs.find(r => r.id === id);
    notify(after?.merged ? `Kept. Merged into ${after.merged.onto}.` : 'Kept.');
  } catch (e) {
    notify(e.message, true);
    // A build can be broken for reasons that predate the run, so overriding
    // stays possible — but only as a second, deliberate click.
    if (/^Not merged:/.test(e.message)) forceMerge = id;
  } finally { busy = false; render(); }
}

$('merge').addEventListener('click', () => keepIt(forceMerge === selected));
$('discard-branch').addEventListener('click', async () => {
  const id = selected;
  if (!id || busy) return;
  const run = state.runs.find(r => r.id === id);
  if (!confirmDiscard(run)) return;
  closeDetail();
  await act('remove', { id, branch: 'delete' }, 'Thrown away. The branch and its work are gone.');
});
$('close').addEventListener('click', closeDetail);
$('start').addEventListener('click', async () => {
  if (busy) return notify('Something else is still finishing. Try again in a moment.', true);
  busy = true;
  $('start').disabled = true;
  try {
    const { id } = await post('start', {
      agent: $('agent').value,
      prompt: $('prompt').value,
      repo: $('repo').value,
      account: $('agent').value === 'codex' ? $('account').value || null : null,
      worktree: $('worktree').checked,
      sandbox: $('readonly').checked ? 'read-only' : 'workspace-write'
    });
    $('prompt').value = '';
    notify('Agent started.');
    localStorage.setItem('repo', $('repo').value);
    await refresh();
    select(id);
  } catch (e) { notify(e.message, true); }
  finally { busy = false; $('start').disabled = false; render(); }
});

// Running inside the Mac app: offer a real folder picker. In a browser there
// is no bridge to ask, so the text field stays as the only way in.
if (window.dashboardNative) {
  $('browse').hidden = false;
  $('browse').addEventListener('click', () => window.webkit.messageHandlers.chooseFolder.postMessage(''));
  window.dashboardFolderChosen = path => {
    $('repo').value = path;
    localStorage.setItem('repo', path);
    notify(`Project folder set to ${path}`);
    void loadKeys();
void loadProject();
void loadModelChoices().then(() => { if (state.agents) { $('roster').dataset.built = ''; render(); } });
  };
}

$('key-save').addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  $('key-save').disabled = true;
  try {
    await postTo('/api/secrets/set', { repo: $('repo').value, name: $('key-name').value, value: $('key-value').value });
    $('key-name').value = '';
    $('key-value').value = '';
    notify('Key saved for this project. It is not shown again.');
    await loadKeys(true);
  } catch (e) { notify(e.message, true); }
  finally { busy = false; $('key-save').disabled = false; render(); }
});
$('repo').addEventListener('change', () => { projectAt = 0; loadKeys(); loadProject(true); renderTasks(); });
$('repo').addEventListener('blur', () => loadKeys());
$('repo').addEventListener('input', () => { renderTasks(); if (state.runs) render(); });

$('repo').value = localStorage.getItem('repo') || '';
void loadKeys();
void loadProject();
void loadModelChoices().then(() => { if (state.agents) { $('roster').dataset.built = ''; render(); } });
refresh().catch(e => notify(e.message, true));
setInterval(() => { if (!busy) refresh().catch(() => notify('Dashboard disconnected. Restart it with npm start.', true)); }, 2000);
// The open run's output polls unconditionally: a background tab that skipped
// ticks would otherwise show a log frozen at whatever it last managed to fetch.
setInterval(() => { void pollLog(); }, 1000);
