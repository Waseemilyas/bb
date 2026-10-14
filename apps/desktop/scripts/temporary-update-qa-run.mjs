import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = join(root, 'release/update-qa');
const qa = JSON.parse(await readFile(join(artifacts, 'qa-build.json'), 'utf8'));
const runDir = await mkdtemp(join(root, '.update-qa-run-'));
const dataDir = join(runDir, 'data');
const userData = join(runDir, 'config', 'bb');
const installed = join(runDir, 'bb.AppImage');
const events = [];
const feed = createServer(async (req, res) => {
  const path = basename(new URL(req.url, qa.feed).pathname);
  events.push({ request: path });
  try {
    if (path.endsWith('.json')) {
      res.writeHead(404).end();
      return;
    }
    const buffer = await readFile(join(artifacts, path));
    res.writeHead(200, { 'Content-Length': buffer.length, 'Content-Type': path.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream' });
    res.end(buffer);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => feed.listen(24791, '127.0.0.1', resolve));
await mkdir(dataDir);
await copyFile(join(artifacts, `bb-${qa.from}-x86_64.AppImage`), installed);
await chmod(installed, 0o755);
const env = { ...process.env, BB_DATA_DIR: dataDir, XDG_CONFIG_HOME: join(runDir, 'config'), BB_SERVER_PORT: '24792', BB_HOST_DAEMON_PORT: '24793', BB_TELEMETRY: 'false', BB_DESKTOP_OPEN_DEVTOOLS: '0', XDG_CACHE_HOME: join(runDir, 'cache') };
delete env.APPIMAGE_EXTRACT_AND_RUN;
delete env.BB_DESKTOP_APP_URL;
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(installed, ['--no-sandbox'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs += chunk; });
const request = async (path, body) => {
  const response = await fetch(`http://127.0.0.1:24792${path}`, { ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  return await response.json();
};
const wait = async (description, fn) => {
  const end = Date.now() + 120000;
  let last;
  while (Date.now() < end) {
    try { const result = await fn(); if (result) return result; } catch (error) { last = String(error); }
    await delay(500);
  }
  throw new Error(`Timed out: ${description}; ${last ?? ''}\n${logs.slice(-20000)}`);
};
let runtime;
try {
  await wait('server startup', () => request('/health'));
  runtime = JSON.parse(await readFile(join(userData, 'owned-runtime.json'), 'utf8'));
  const status = await wait('desktop update availability', async () => {
    const result = await request('/api/v1/system/app-update?force=true');
    return result.available?.version === qa.to ? result : false;
  });
  assert.equal(status.current.version, qa.from);
  assert.equal(status.desktopUpdateSupported, true);
  events.push({ before: status, oldRuntimePid: runtime.pid });
  const started = await request('/api/v1/system/app-update/apply', { confirmInterruptingThreads: true });
  assert.notEqual(started.activity.phase, 'idle');
  events.push({ started });
  const result = await wait('updated server and persisted result after native install', async () => {
    const status = await request('/api/v1/system/app-update');
    return status.current.version === qa.to && status.lastResult?.outcome === 'updated' ? status : false;
  });
  const newRuntime = JSON.parse(await readFile(join(userData, 'owned-runtime.json'), 'utf8'));
  assert.notEqual(newRuntime.pid, runtime.pid);
  assert.equal(result.lastResult.from.version, qa.from);
  assert.equal(result.lastResult.to.version, qa.to);
  assert.equal(result.desktopUpdateSupported, true);
  await request('/api/v1/system/app-update/acknowledge', { id: result.lastResult.id });
  assert.equal((await request('/api/v1/system/app-update')).lastResult.acknowledged, true);
  events.push({ after: result, newRuntimePid: newRuntime.pid });
  console.log(`PASS: real AppImage update ${qa.from} -> ${qa.to}; native replacement, server restart, persisted result, acknowledgment.`);
} finally {
  await writeFile(join(artifacts, 'qa-result.json'), JSON.stringify({ head: qa.head, events }, null, 2));
  await writeFile(join(artifacts, 'qa-desktop.log'), logs);
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      const environment = await readFile(`/proc/${entry}/environ`, 'utf8');
      if (environment.split('\0').includes(`BB_DATA_DIR=${dataDir}`)) process.kill(Number(entry), 'SIGKILL');
    } catch {}
  }
  await new Promise(resolve => feed.close(resolve));
}
