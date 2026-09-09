import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, access } from 'node:fs/promises';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { iconSet, SIZES } from './icon.mjs';

const mac = platform() === 'darwin';

// osacompile and iconutil make a build slow enough to be worth doing once.
let built = null;
function bundle() {
  built ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'app-'));
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['app.mjs', dir], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', c => { err += c; });
      child.on('close', code => code === 0 ? resolve() : reject(new Error(err)));
    });
    return { dir, app: join(dir, 'Master AI.app') };
  })();
  return built;
}
test.after(async () => { if (built) await rm((await built).dir, { recursive: true, force: true }); });

const readPlist = async (path, key) => new Promise(resolve => {
  const child = spawn('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', c => { out += c; });
  child.on('close', () => resolve(out.trim()));
});

test('every icon size is a valid PNG of the right dimensions', () => {
  const icons = iconSet();
  assert.deepEqual([...icons.keys()], SIZES);
  for (const [size, png] of icons) {
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(png.subarray(12, 16).toString(), 'IHDR');
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
});

test('the PNG writer produces files macOS itself can read', { skip: !mac }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'icon-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'probe.png');
  await writeFile(path, iconSet().get(128));
  const read = await new Promise(resolve => {
    const child = spawn('sips', ['-g', 'pixelWidth', '-g', 'hasAlpha', path], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', c => { out += c; });
    child.on('close', () => resolve(out));
  });
  assert.match(read, /pixelWidth: 128/);
  // Transparent corners are what make it read as a rounded app icon.
  assert.match(read, /hasAlpha: yes/);
});

test('the bundle has what macOS needs to launch it', { skip: !mac }, async () => {
  const { app } = await bundle();
  const plist = join(app, 'Contents', 'Info.plist');

  // A compiled binary, not a script: macOS refuses to launch script executables.
  assert.equal(await readPlist(plist, 'CFBundleExecutable'), 'MasterAI');
  assert.equal(await readPlist(plist, 'CFBundleName'), 'Master AI');
  assert.equal(await readPlist(plist, 'CFBundleIdentifier'), 'local.master-ai');
  assert.match(await readPlist(plist, 'CFBundleShortVersionString'), /^\d+\.\d+\.\d+$/);
  // The dashboard is plain HTTP on loopback, which ATS blocks without this.
  assert.equal(await readPlist(plist, 'NSAppTransportSecurity:NSAllowsLocalNetworking'), 'true');

  const executable = join(app, 'Contents', 'MacOS', 'MasterAI');
  assert.ok((await stat(executable)).mode & 0o111, 'the app binary must be executable');
  const magic = (await readFile(executable)).subarray(0, 4);
  assert.equal(magic.readUInt32LE(0), 0xfeedfacf, 'must be a Mach-O binary');

  assert.ok((await stat(join(app, 'Contents', 'Resources', 'icon.icns'))).size > 10000, 'icon must be ours, not a stub');

  // The dashboard is copied in, so the app survives the source folder moving.
  for (const file of ['server.mjs', 'runs.mjs', 'adapters.mjs', 'vault.mjs', 'usage.mjs', 'public/runs.html', 'public/runs.js'])
    await access(join(app, 'Contents', 'Resources', 'app', file));
});

test('the window code covers the behaviour the app promises', { skip: !mac }, async () => {
  const swift = await readFile('app.swift', 'utf8');
  assert.match(swift, /command -v node/, 'must find node itself; Finder gives no PATH');
  assert.match(swift, /if serverIsAwake\(\)/, 'a dashboard already running must be reused, not fought over');
  assert.match(swift, /func applicationWillTerminate/, 'quitting must stop the server it started');
  assert.match(swift, /O_APPEND/, 'both writers share the log, so appends must be atomic');
  assert.match(swift, /NSWorkspace\.shared\.open/, 'sign-in links belong in the real browser');
  assert.match(swift, /chooseFolder/, 'the folder picker is the point of having a native window');
  assert.match(swift, /setFrameUsingName/, 'a stale saved frame must not park the window off-screen');
});

test('the folder picker degrades to the text field in a browser', async () => {
  const page = await readFile('public/runs.js', 'utf8');
  assert.match(page, /if \(window\.dashboardNative\)/, 'the Choose button must be native-only');
  assert.match(page, /window\.dashboardFolderChosen = path =>/);
  const html = await readFile('public/runs.html', 'utf8');
  assert.match(html, /id="browse"[^>]*hidden/, 'the button starts hidden so a browser never shows it');
});

test('the bundle contains every module the dashboard imports', { skip: !mac }, async () => {
  const { app } = await bundle();
  const inside = join(app, 'Contents', 'Resources', 'app');
  const { readdir } = await import('node:fs/promises');
  const shipped = (await readdir(inside)).filter(name => name.endsWith('.mjs'));
  assert.ok(shipped.includes('server.mjs'));

  // Follow the relative imports of everything shipped; a missing one only
  // shows up as a crash at launch otherwise.
  const missing = [];
  for (const file of shipped) {
    const source = await readFile(join(inside, file), 'utf8');
    for (const match of source.matchAll(/from\s+'(\.\/[^']+)'/g)) {
      const target = match[1].replace('./', '');
      if (!shipped.includes(target)) missing.push(`${file} imports ${target}`);
    }
  }
  assert.deepEqual(missing, [], 'every relative import must be inside the bundle');
  // Build scripts are not part of the app that ships.
  for (const excluded of ['app.mjs', 'icon.mjs']) assert.ok(!shipped.includes(excluded), `${excluded} should not ship`);
});

test('quitting asks first when agents are still working', { skip: !mac }, async () => {
  const swift = await readFile('app.swift', 'utf8');
  assert.match(swift, /func applicationShouldTerminate\(/, 'quitting must be intercepted');
  assert.match(swift, /terminateCancel/, 'and must be cancellable');
  assert.match(swift, /\["running", "waiting"\]\.contains/, 'queued runs count as still working');
  // The default button is the safe one: Return must not throw work away.
  const dialog = swift.slice(swift.indexOf('func applicationShouldTerminate('));
  assert.ok(dialog.indexOf('"Keep working"') < dialog.indexOf('"Quit anyway"'),
    'the first button is the default, so it must be the one that keeps working');
});

test('finished runs are announced, with a fallback that needs no permission', { skip: !mac }, async () => {
  const swift = await readFile('app.swift', 'utf8');
  assert.match(swift, /requestAuthorization/, 'permission is asked for once');
  assert.match(swift, /UNMutableNotificationContent/, 'and a banner is posted when granted');
  assert.match(swift, /requestUserAttention/, 'without permission the Dock icon bounces instead');
  assert.match(swift, /window\.dashboardNotifications = /, 'the page is told, so it can say notifications are off');
  // Clicking a notification should bring the window back, not just dismiss.
  assert.match(swift, /didReceive response: UNNotificationResponse/);
  assert.match(swift, /makeKeyAndOrderFront/);
});

test('pushing is a separate, deliberate step', async () => {
  const page = await readFile('public/runs.js', 'utf8');
  // Two clicks: the first arms, the second sends.
  assert.match(page, /if \(!armedPush\)/);
  assert.match(page, /Click again to confirm/);
  assert.match(page, /it goes live/, 'the warning must say what pushing can mean');
  const server = await readFile('runs.mjs', 'utf8');
  assert.match(server, /async push\(repo\)/);
  assert.match(server, /has no upstream branch set/, 'a branch with nowhere to push is refused');
  assert.match(server, /already pushed/, 'and so is a branch with nothing to send');
  // Merging must never push on its own.
  assert.doesNotMatch(server.slice(server.indexOf('async mergeAll()'), server.indexOf('async merge(')), /'push'/);
});

test('a refused permission can be recovered from inside the app', { skip: !mac }, async () => {
  const swift = await readFile('app.swift', 'utf8');
  // macOS never asks twice, so the app has to offer the way back itself.
  assert.match(swift, /Notification Settings…/);
  assert.match(swift, /x-apple\.systempreferences:com\.apple\.Notifications-Settings/);
  assert.match(swift, /Send a Test Notification/);
  // Permission can be granted while the app is running, so it is re-read.
  assert.match(swift, /getNotificationSettings/);
  const deliver = swift.slice(swift.indexOf('func deliver('));
  assert.ok(deliver.indexOf('requestUserAttention') > 0, 'the Dock bounce stays as the fallback');
});
