import { homedir } from 'node:os';
import { join } from 'node:path';
import { Vault } from './vault.mjs';
import { fetchUsage } from './usage.mjs';
const vault = new Vault(join(homedir(), '.local/share/codex-account-dashboard'), process.env.CODEX_HOME || join(homedir(), '.codex'));
await vault.init();
try {
  const result = await fetchUsage(await vault.currentRaw(), vault.root);
  console.log(JSON.stringify(result));
} catch (e) { console.error(e.message); process.exitCode = 1; }
