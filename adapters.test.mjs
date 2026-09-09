import test from 'node:test';
import assert from 'node:assert/strict';
import { agents, splitLines } from './adapters.mjs';

const parse = (agent, object) => agents[agent].parse(JSON.stringify(object));

test('splitLines holds an incomplete line until its newline arrives', () => {
  const first = splitLines('', '{"a":1}\n{"b":');
  assert.deepEqual(first.lines, ['{"a":1}']);
  assert.equal(first.buffer, '{"b":');
  assert.deepEqual(splitLines(first.buffer, '2}\n').lines, ['{"b":2}']);
});

test('claude reports assistant text and file edits', () => {
  const events = parse('claude', {
    type: 'assistant',
    message: { content: [
      { type: 'text', text: 'Adding the route.' },
      { type: 'tool_use', name: 'Edit', input: { file_path: 'src/app.js' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }
    ] }
  });
  assert.deepEqual(events.map(e => e.kind), ['message', 'file', 'tool']);
  assert.equal(events[1].file, 'src/app.js');
  assert.match(events[2].text, /npm test/);
});

test('claude marks a failed result as an error', () => {
  const [event] = parse('claude', { type: 'result', subtype: 'error_max_turns', is_error: true, result: 'Ran out of turns.' });
  assert.equal(event.kind, 'error');
  assert.equal(event.text, 'Ran out of turns.');
});

test('claude summarizes a successful result without repeating its last message', () => {
  const events = parse('claude', { type: 'result', subtype: 'success', result: 'Done.', num_turns: 4, total_cost_usd: 0.1234 });
  assert.deepEqual(events.map(e => e.kind), ['status']);
  assert.match(events[0].text, /4 turns · \$0\.123/);
  assert.doesNotMatch(events[0].text, /Done\./);
});

test('codex reads the current thread item events', () => {
  assert.deepEqual(parse('codex', { type: 'item.completed', item: { item_type: 'agent_message', text: 'Ready.' } }),
    [{ kind: 'message', text: 'Ready.' }]);
  const changes = parse('codex', { type: 'item.completed', item: { item_type: 'file_change', changes: { 'a.js': {}, 'b.js': {} } } });
  assert.deepEqual(changes.map(e => e.file), ['a.js', 'b.js']);
});

test('codex still reads the older message envelope', () => {
  assert.deepEqual(parse('codex', { msg: { type: 'agent_message', message: 'Hello.' } }), [{ kind: 'message', text: 'Hello.' }]);
  const [shell] = parse('codex', { msg: { type: 'exec_command_begin', command: 'ls -a' } });
  assert.equal(shell.kind, 'tool');
  assert.match(shell.text, /ls -a/);
});

test('codex drops the noise that duplicates completed items', () => {
  assert.deepEqual(parse('codex', { type: 'item.started', item: { item_type: 'agent_message' } }), []);
  assert.deepEqual(parse('codex', { msg: { type: 'token_count', total: 12 } }), []);
});

test('unparseable output is kept as a log line rather than dropped', () => {
  for (const agent of ['claude', 'codex']) {
    assert.deepEqual(agents[agent].parse('not json at all'), [{ kind: 'log', text: 'not json at all' }]);
    assert.deepEqual(agents[agent].parse('   '), []);
  }
});

test('read only picks the non-writing mode for each agent', () => {
  assert.ok(agents.claude.args({ prompt: 'x', sandbox: 'read-only' }).includes('plan'));
  assert.ok(agents.claude.args({ prompt: 'x', sandbox: 'workspace-write' }).includes('acceptEdits'));
  assert.ok(agents.codex.args({ prompt: 'x', sandbox: 'read-only' }).includes('read-only'));
  assert.ok(agents.codex.args({ prompt: 'x', sandbox: 'workspace-write' }).includes('workspace-write'));
});

test('the prompt reaches the agent as a single argument', () => {
  const prompt = 'refactor; rm -rf /';
  assert.ok(agents.claude.args({ prompt }).includes(prompt));
  assert.ok(agents.codex.args({ prompt }).includes(prompt));
});

test('codex edited files are read from either shape it reports', () => {
  // Object keyed by path.
  assert.deepEqual(parse('codex', { type: 'item.completed', item: { item_type: 'file_change', changes: { 'a.js': {}, 'b.js': {} } } })
    .map(e => e.file), ['a.js', 'b.js']);
  // Array of entries — Object.keys here would have given "0" and "1".
  const fromArray = parse('codex', { type: 'item.completed', item: { item_type: 'file_change', changes: [{ path: 'src/x.ts', kind: 'edit' }, { path: 'src/y.ts' }] } });
  assert.deepEqual(fromArray.map(e => e.file), ['src/x.ts', 'src/y.ts']);
  assert.equal(fromArray[0].text, 'Edit · src/x.ts');
  // Array of bare strings.
  assert.deepEqual(parse('codex', { type: 'item.completed', item: { item_type: 'file_change', changes: ['only.js'] } })
    .map(e => e.file), ['only.js']);
  // A single path on the item itself.
  assert.deepEqual(parse('codex', { type: 'item.completed', item: { item_type: 'file_change', path: 'lone.js' } })
    .map(e => e.file), ['lone.js']);
});

test('the planner is offered the coding agents, and Hermes is not one', () => {
  const offered = Object.entries(agents).filter(([, a]) => a.planner !== false).map(([id]) => id);
  assert.deepEqual(offered.sort(), ['claude', 'codex', 'devin']);
  assert.equal(agents.hermes.planner, false, 'Hermes is chosen deliberately, not assigned');
  // Writing belongs to Claude now, so the planner has somewhere to send it.
  assert.match(agents.claude.strength, /writing/);
  assert.doesNotMatch(agents.hermes.strength, /docs/);
});
