#!/usr/bin/env node
if (process.argv.includes('--help')) {
  console.log('codex-accounts [--no-open]\nStarts your local account dashboard. Requires Node 22+ and Codex CLI.\nUse DASHBOARD_PORT to select a different port. Press Ctrl+C to stop.');
} else {
  if (process.platform === 'win32') {
    console.error('On Windows, install and run this dashboard inside WSL, alongside Codex.');
    process.exitCode = 1;
  } else {
    process.env.DASHBOARD_OPEN = process.argv.includes('--no-open') ? '0' : '1';
    await import('./server.mjs');
  }
}
