#!/usr/bin/env node
// Builds "Master AI.app": a real Mac app with its own window that starts the
// dashboard, shows it, and stops the server when you quit.
//
// The window is a compiled Swift binary (app.swift) rather than a browser tab
// or a script, because macOS will not launch an app whose executable is a
// script, and only a native window can offer things like the folder picker.
// Building needs the Xcode Command Line Tools; running the built app does not.
// Node still has to be installed: this bundles the dashboard, not a runtime.
import { mkdir, rm, writeFile, copyFile, readFile, readdir, stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { iconSet } from './icon.mjs';

const base = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(await readFile(join(base, 'package.json'), 'utf8'));
const NAME = 'Master AI';
// Derived, not listed: a hand-kept list silently ships a bundle missing a
// module the moment the dashboard grows one.
const BUILD_ONLY = new Set(['app.mjs', 'icon.mjs', 'cli.mjs']);
const isDashboardModule = name => name.endsWith('.mjs') && !name.endsWith('.test.mjs') && !BUILD_ONLY.has(name);

const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', c => { err += c; });
  child.on('error', reject);
  child.on('close', code => code === 0 ? resolve() : reject(new Error(`${command} failed: ${err.trim()}`)));
});

async function copyTree(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from)) {
    const source = join(from, entry);
    if ((await stat(source)).isDirectory()) await copyTree(source, join(to, entry));
    else await copyFile(source, join(to, entry));
  }
}

const plistXML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${NAME}</string>
  <key>CFBundleDisplayName</key><string>${NAME}</string>
  <key>CFBundleIdentifier</key><string>local.master-ai</string>
  <key>CFBundleExecutable</key><string>MasterAI</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <!-- The dashboard is plain HTTP on loopback, which App Transport Security
       blocks unless local networking is allowed. -->
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
`;

// /Applications by default: it is where apps are looked for, and it avoids a
// stale Launch Services record if an older build sat in the home folder.
const target = process.argv[2]
  || await access('/Applications', constants.W_OK).then(() => '/Applications', () => join(homedir(), 'Applications'));
const app = join(target, `${NAME}.app`);
const work = join(tmpdir(), `codex-agents-build-${process.pid}`);
await mkdir(work, { recursive: true });
await mkdir(target, { recursive: true });
await rm(app, { recursive: true, force: true });
await mkdir(join(app, 'Contents', 'MacOS'), { recursive: true });
await mkdir(join(app, 'Contents', 'Resources'), { recursive: true });

await writeFile(join(app, 'Contents', 'Info.plist'), plistXML);
await writeFile(join(app, 'Contents', 'PkgInfo'), 'APPL????');
await run('swiftc', ['-O', '-o', join(app, 'Contents', 'MacOS', 'MasterAI'), join(base, 'app.swift')])
  .catch(e => {
    throw new Error(`${e.message}\n\nBuilding the app needs the Xcode Command Line Tools: xcode-select --install`);
  });

const resources = join(app, 'Contents', 'Resources');
// The dashboard is copied in, so the app keeps working if this folder moves.
const inside = join(resources, 'app');
await mkdir(inside, { recursive: true });
const sources = (await readdir(base)).filter(isDashboardModule);
for (const file of sources) await copyFile(join(base, file), join(inside, file));
await copyTree(join(base, 'public'), join(inside, 'public'));

const iconset = join(work, 'icon.iconset');
await mkdir(iconset, { recursive: true });
for (const [size, png] of iconSet()) {
  if (size <= 512) await writeFile(join(iconset, `icon_${size}x${size}.png`), png);
  if (size >= 32) await writeFile(join(iconset, `icon_${size / 2}x${size / 2}@2x.png`), png);
}
await run('iconutil', ['-c', 'icns', iconset, '-o', join(resources, 'icon.icns')]);
await rm(work, { recursive: true, force: true });

// A signature is what lets the app keep permissions it is granted, rather than
// looking like a new app to macOS after every rebuild.
await run('codesign', ['--force', '--sign', '-', app]).catch(() => {});
await run('touch', [app]).catch(() => {});

console.log(`Built ${app}`);
console.log('Open it from Finder, or drag it to your Dock.');
