// What should happen on its own when a project's batch finishes. Off by
// default: merging and pushing change the project, so they are opted into.
import { mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { readOptional, privateWrite } from './vault.mjs';

const MODES = ['off', 'merge', 'push'];

export function checkMode(mode) {
  const value = String(mode || 'off').trim();
  if (!MODES.includes(value)) throw new Error(`Choose one of ${MODES.join(', ')}.`);
  return value;
}

export class Auto {
  constructor(root) { this.root = root; this.file = join(root, 'auto.json'); }
  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
  }
  async mode() {
    const raw = await readOptional(this.file);
    if (!raw) return 'off';
    try { return checkMode(JSON.parse(raw).mode); } catch { return 'off'; }
  }
  async set(mode) {
    const chosen = checkMode(mode);
    await privateWrite(this.file, JSON.stringify({ mode: chosen }, null, 2));
    return { mode: chosen };
  }
}
export { MODES };
