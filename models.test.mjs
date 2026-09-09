import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Models, checkModel, checkEffort, parseDevinModels } from './models.mjs';
import { agents } from './adapters.mjs';

async function store(t) {
  const root = await mkdtemp(join(tmpdir(), 'models-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexDir = join(root, 'codex');
  await mkdtemp(join(tmpdir(), 'unused-'));
  const models = new Models(root, codexDir);
  await models.init();
  return { root, codexDir, models };
}

test('a model name is checked before it reaches a command line', () => {
  assert.equal(checkModel(' claude-opus-5 '), 'claude-opus-5');
  assert.equal(checkModel(''), null, 'empty means let the agent decide');
  assert.equal(checkModel('gpt-5.6-luna'), 'gpt-5.6-luna');
  assert.throws(() => checkModel('rm -rf /'), /letters, numbers/);
  assert.throws(() => checkModel('a; echo hi'), /letters, numbers/);
  assert.throws(() => checkModel('x'.repeat(200)), /too long/);
  // Each agent names its own levels, and they do not agree.
  assert.equal(checkEffort('codex', 'medium'), 'medium');
  assert.equal(checkEffort('claude', 'xhigh'), 'xhigh');
  assert.equal(checkEffort('hermes', 'ultra'), 'ultra');
  assert.throws(() => checkEffort('codex', 'xhigh'), /Codex takes one of/);
  assert.throws(() => checkEffort('claude', 'ultra'), /Claude Code takes one of/);
  assert.equal(checkEffort('claude', ''), null);
});

test('devin model families and aliases are read from its listing', () => {
  const listing = [
    'Available models (2 families)',
    '',
    'Claude Opus 5 (claude-opus-5)',
    '  aliases: opus, big',
    '  claude-opus-5-medium   Claude Opus 5 Medium  [$5 / 1M Input]',
    '',
    'Gemini 3.7 Flash (gemini-3.7-flash)',
    '  aliases: gemini'
  ].join('\n');
  // Families and aliases, not the dozen effort variants under each.
  assert.deepEqual(parseDevinModels(listing), ['claude-opus-5', 'opus', 'big', 'gemini-3.7-flash', 'gemini']);
  assert.deepEqual(parseDevinModels('nothing useful'), []);
});

test('a chosen model is remembered per agent and can be cleared', async t => {
  const { models } = await store(t);
  await models.set('claude', 'sonnet');
  await models.set('codex', 'gpt-5.6-luna', 'high');
  assert.deepEqual(await models.for('claude'), { model: 'sonnet', effort: null });
  assert.deepEqual(await models.for('codex'), { model: 'gpt-5.6-luna', effort: 'high' });
  await models.set('claude', 'opus', 'high');
  assert.equal((await models.for('claude')).effort, 'high');
  // A level the agent does not offer is refused rather than passed on.
  await assert.rejects(models.set('claude', 'opus', 'minimal'), /takes one of/);

  await models.set('claude', '');
  assert.deepEqual(await models.for('claude'), { model: null, effort: null });
  await assert.rejects(models.set('nonesuch', 'x'), /supported agent/);
});

test('Codex falls back to its own config, and the summary says which it is', async t => {
  const { codexDir, models } = await store(t);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(codexDir, { recursive: true });
  await writeFile(join(codexDir, 'config.toml'), 'model = "gpt-5.6-luna"\nmodel_reasoning_effort = "medium"\n');

  let summary = await models.summary();
  assert.deepEqual(summary.codex, { model: 'gpt-5.6-luna', effort: 'medium', source: 'its own settings' });

  // Setting it here takes over from the config file.
  await models.set('codex', 'o3', 'high');
  summary = await models.summary();
  assert.deepEqual(summary.codex, { model: 'o3', effort: 'high', source: 'set here' });
});

test('the chosen model is passed to each agent in its own way', () => {
  const claude = agents.claude.args({ prompt: 'x', sandbox: 'workspace-write', model: 'sonnet' });
  assert.deepEqual(claude.slice(-2), ['--model', 'sonnet']);
  const devin = agents.devin.args({ prompt: 'x', sandbox: 'workspace-write', model: 'opus' });
  assert.deepEqual(devin.slice(-2), ['--model', 'opus']);
  const hermes = agents.hermes.args({ prompt: 'x', sandbox: 'workspace-write', model: 'nous/hermes' });
  assert.ok(hermes.includes('-m') && hermes.includes('nous/hermes'));
  assert.equal(hermes.at(-1), 'x', 'the prompt stays last');

  const codex = agents.codex.args({ prompt: 'x', sandbox: 'workspace-write', model: 'o3', effort: 'high' });
  assert.ok(codex.includes('--model') && codex.includes('o3'));
  assert.ok(codex.includes('model_reasoning_effort="high"'));

  // Three CLIs, three ways of saying the same thing.
  assert.ok(agents.claude.args({ prompt: 'x', sandbox: 'workspace-write', effort: 'max' }).includes('--effort'));
  assert.ok(agents.hermes.args({ prompt: 'x', sandbox: 'workspace-write', effort: 'ultra' }).includes('--reasoning'));
  // Devin has no flag: the level goes into the model name.
  const devinBoth = agents.devin.args({ prompt: 'x', sandbox: 'workspace-write', model: 'claude-opus-5', effort: 'high' });
  assert.ok(devinBoth.includes('claude-opus-5-high'));
  assert.equal(devinBoth.includes('--effort'), false);
  // And with no model there is no name to put it in, so nothing is passed.
  assert.equal(agents.devin.args({ prompt: 'x', sandbox: 'workspace-write', effort: 'high' }).includes('--model'), false);
  // Nothing chosen means nothing passed, so each CLI keeps its own default.
  for (const [id, agent] of Object.entries(agents)) {
    const bare = agent.args({ prompt: 'x', sandbox: 'workspace-write' });
    assert.equal(bare.includes('--model'), false, `${id} must not pass an empty model`);
  }
});

test('each CLI\'s own configuration is read rather than guessed at', async t => {
  const home = await mkdtemp(join(tmpdir(), 'homes-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const { mkdir } = await import('node:fs/promises');
  const { configuredModel } = await import('./models.mjs');

  for (const dir of ['.codex', '.hermes', '.claude']) await mkdir(join(home, dir), { recursive: true });
  await writeFile(join(home, '.codex/config.toml'), 'model = "gpt-5.6-luna"\nmodel_reasoning_effort = "medium"\n');
  await writeFile(join(home, '.hermes/config.yaml'),
    'model:\n  default: upstage/solar-pro4:free\n  provider: nous\nagent:\n  reasoning_effort: medium\n');
  await writeFile(join(home, '.claude/settings.json'),
    JSON.stringify({ modelSettings: { 'claude-opus-5': { effortLevel: 'medium' } } }));

  assert.deepEqual(await configuredModel('codex', { home }), { model: 'gpt-5.6-luna', effort: 'medium' });
  assert.deepEqual(await configuredModel('hermes', { home }), { model: 'upstage/solar-pro4:free', effort: 'medium' });
  assert.deepEqual(await configuredModel('claude', { home }), { model: 'claude-opus-5', effort: 'medium' });
  // Devin keeps no model in its config, so nothing is claimed for it.
  assert.deepEqual(await configuredModel('devin', { home }), { model: null, effort: null });

  // More than one model in Claude's settings says nothing about which is in use.
  await writeFile(join(home, '.claude/settings.json'),
    JSON.stringify({ modelSettings: { 'claude-opus-5': {}, 'claude-sonnet-5': {} } }));
  assert.deepEqual(await configuredModel('claude', { home }), { model: null, effort: null });
});

test('a model set here wins over the one in the agent\'s config', async t => {
  const { codexDir, models } = await store(t);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(codexDir, { recursive: true });
  await writeFile(join(codexDir, 'config.toml'), 'model = "gpt-5.6-luna"\n');

  let summary = await models.summary();
  assert.equal(summary.codex.source, 'its own settings');
  await models.set('codex', 'o3', 'high');
  summary = await models.summary();
  assert.deepEqual(summary.codex, { model: 'o3', effort: 'high', source: 'set here' });

  // With nothing set and nothing configured, what the last run reported stands.
  summary = await models.summary({ devin: 'claude-opus-5-high' });
  assert.deepEqual(summary.devin, { model: 'claude-opus-5-high', effort: null, source: 'the last run' });
});
