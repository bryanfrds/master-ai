// Each adapter turns one agent CLI into a command plus a line parser.
// Parsers return an array of normalized events: { kind, text, file? }.
// Unrecognized lines never disappear; they fall through to a 'log' event so a
// change in an agent's output format degrades to raw text instead of silence.

const first = (...values) => values.find(v => typeof v === 'string' && v.trim()) || null;
const clip = (value, max = 2000) => value.length > max ? `${value.slice(0, max)}…` : value;

// Devin and Hermes print prose, not events. Strip terminal colouring and keep
// the text; there is no tool trace to show for these two.
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;
function plainText(line) {
  const text = line.replace(ANSI, '').replace(/\r/g, '').trim();
  if (!text) return [];
  return [{ kind: 'message', text: clip(text) }];
}

// Codex reports edited files as an object keyed by path in one version and as
// an array of entries in another. Object.keys on the array form yields "0",
// "1", which is how a file called 0 ended up in the log.
export function changedPaths(item) {
  const changes = item?.changes ?? item?.files;
  const from = value => typeof value === 'string' ? value : value?.path || value?.file || value?.name || null;
  if (Array.isArray(changes)) return changes.map(from).filter(Boolean);
  if (changes && typeof changes === 'object') return Object.keys(changes);
  const single = from(item?.path ?? item?.file ?? null);
  return single ? [single] : [];
}

function fallback(line) {
  const trimmed = line.trim();
  return trimmed ? [{ kind: 'log', text: clip(trimmed) }] : [];
}

function claudeContent(content) {
  const events = [];
  for (const part of Array.isArray(content) ? content : []) {
    if (part.type === 'text' && part.text?.trim()) events.push({ kind: 'message', text: clip(part.text.trim()) });
    if (part.type === 'thinking' && part.thinking?.trim()) events.push({ kind: 'thinking', text: clip(part.thinking.trim(), 400) });
    if (part.type === 'tool_use') {
      const input = part.input || {};
      const file = first(input.file_path, input.notebook_path, input.path);
      const detail = file || first(input.command, input.pattern, input.description, input.prompt) || '';
      events.push({ kind: file ? 'file' : 'tool', text: clip(`${part.name}${detail ? ` · ${detail}` : ''}`, 300), file });
    }
  }
  return events;
}

export const agents = {
  claude: {
    label: 'Claude Code',
    strength: 'frontend, general coding, and any writing — docs, READMEs, release notes',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    binary: () => process.env.DASHBOARD_CLAUDE_BIN || 'claude',
    // acceptEdits lets the agent edit files in its worktree but still refuses
    // the destructive actions that a full bypass would wave through.
    args: ({ prompt, sandbox, model, effort }) => [
      '--print', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', sandbox === 'read-only' ? 'plan' : 'acceptEdits',
      ...(model ? ['--model', model] : []),
      ...(effort ? ['--effort', effort] : [])
    ],
    parse(line) {
      let message;
      try { message = JSON.parse(line); } catch { return fallback(line); }
      if (message.type === 'system' && message.subtype === 'init')
        return [{ kind: 'status', text: `Session started${message.model ? ` · ${message.model}` : ''}` }];
      if (message.type === 'assistant') return claudeContent(message.message?.content);
      if (message.type === 'result') {
        const cost = Number.isFinite(message.total_cost_usd) ? ` · $${message.total_cost_usd.toFixed(3)}` : '';
        const turns = Number.isFinite(message.num_turns) ? ` · ${message.num_turns} turns` : '';
        if (message.is_error || message.subtype !== 'success')
          return [{ kind: 'error', text: clip(first(message.result, message.subtype) || 'The run failed.') }];
        // message.result repeats the final assistant message, so only the summary is new.
        return [{ kind: 'status', text: `Finished${turns}${cost}` }];
      }
      return [];
    }
  },
  devin: {
    label: 'Devin',
    strength: 'strongest at testing and UI design',
    // Devin has no effort flag: the level is part of the model name, so it can
    // only be applied to a model that has been chosen.
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    effortInModel: true,
    binary: () => process.env.DASHBOARD_DEVIN_BIN || 'devin',
    // Non-interactive mode cannot show the workspace trust prompt and fails in
    // a directory it has not seen, which every fresh worktree is.
    args: ({ prompt, sandbox, model, effort }) => {
      const named = model && effort ? `${model}-${effort}` : model;
      return [
        '--print', prompt,
        '--permission-mode', sandbox === 'read-only' ? 'auto' : 'accept-edits',
        '--respect-workspace-trust', 'false',
        ...(named ? ['--model', named] : [])
      ];
    },
    parse: plainText
  },
  hermes: {
    label: 'Hermes',
    strength: 'a personal assistant — messages, reminders and errands',
    efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    // Left out of the planner's roster: its work is not repo work, so it is
    // chosen deliberately rather than assigned a slice of a coding job.
    planner: false,
    binary: () => process.env.DASHBOARD_HERMES_BIN || 'hermes',
    // Hermes has no middle setting: without --yolo it stops for approval that
    // nobody can answer without a terminal. Its worktree is the boundary.
    args: ({ prompt, sandbox, model, effort }) => [
      ...(sandbox === 'read-only' ? ['--safe-mode'] : ['--yolo', '--accept-hooks']),
      ...(model ? ['-m', model] : []),
      ...(effort ? ['--reasoning', effort] : []),
      '--oneshot', prompt
    ],
    parse: plainText
  },
  codex: {
    label: 'Codex',
    strength: 'strongest on backend and API work',
    efforts: ['minimal', 'low', 'medium', 'high'],
    binary: () => process.env.DASHBOARD_CODEX_BIN || 'codex',
    // Nothing passed means Codex reads its own config, which is where the
    // model lives when it has not been set in the dashboard.
    args: ({ prompt, sandbox, model, effort }) => [
      'exec', '--json',
      '--skip-git-repo-check',
      '--sandbox', sandbox === 'read-only' ? 'read-only' : 'workspace-write',
      ...(model ? ['--model', model] : []),
      ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
      prompt
    ],
    // Codex has shipped more than one event shape. Read both the current
    // thread/item events and the older msg envelope, and keep raw text for
    // anything neither branch recognizes.
    parse(line) {
      let message;
      try { message = JSON.parse(line); } catch { return fallback(line); }
      const item = message.item || message.msg || message;
      // An event carries its kind in different places across Codex versions, and
      // item.completed pairs an envelope type with the real item type. Match
      // against all of them at once.
      const type = [message.type, item.type, item.item_type].filter(v => typeof v === 'string').join(' ');
      const body = first(item.text, item.message, item.content, item.last_agent_message);
      const command = first(item.command, item.aggregated_command, Array.isArray(item.parsed_cmd) ? item.parsed_cmd.join(' ') : null);
      const changed = changedPaths(item);
      // item.started duplicates item.completed; drop it rather than double-report.
      if (/item\.started|item\.updated|token_count|turn\.started/.test(type)) return [];
      if (/thread\.started|session_configured/.test(type)) return [{ kind: 'status', text: 'Session started' }];
      if (/agent_message|assistant/.test(type) && body) return [{ kind: 'message', text: clip(body) }];
      if (/reasoning/.test(type) && body) return [{ kind: 'thinking', text: clip(body, 400) }];
      if (/command_execution|exec_command_begin/.test(type) && command) return [{ kind: 'tool', text: clip(`Shell · ${command}`, 300) }];
      if (/file_change|patch_apply|apply_patch/.test(type) && changed.length)
        return changed.map(file => ({ kind: 'file', text: clip(`Edit · ${file}`, 300), file }));
      if (/error|stream_error/.test(type)) return [{ kind: 'error', text: clip(first(item.message, item.error) || 'Codex reported an error.') }];
      if (/turn\.completed|task_complete/.test(type)) return [{ kind: 'status', text: 'Finished' }];
      return body ? [{ kind: 'log', text: clip(body) }] : [];
    }
  }
};

export function splitLines(buffer, chunk) {
  const combined = buffer + chunk;
  const parts = combined.split('\n');
  // A trailing fragment without a newline stays buffered until the rest arrives.
  return { lines: parts.slice(0, -1), buffer: parts.at(-1).length > 1_000_000 ? '' : parts.at(-1) };
}
