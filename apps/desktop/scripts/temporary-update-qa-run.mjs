import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { watch } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = join(root, 'release/update-qa');
const qa = JSON.parse(await readFile(join(artifacts, 'qa-build.json'), 'utf8'));
const runDir = await mkdtemp(join(root, '.update-qa-run-'));
const dataDir = join(runDir, 'data');
const userData = join(runDir, 'config', 'bb');
const installed = join(runDir, `bb-${qa.from}-x86_64.AppImage`);
const events = [];
const qaRequire = createRequire(join(process.env.QA_BROWSER_DIR, 'package.json'));
const puppeteer = qaRequire('puppeteer');
let browser;
let page;
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
const child = spawn(installed, ['--no-sandbox'], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
let installWatcher;
let stoppedAt;
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
  const browsers = createRequire(qaRequire.resolve('puppeteer'))('@puppeteer/browsers');
  const platform = browsers.detectBrowserPlatform();
  const buildId = await browsers.resolveBuildId(browsers.Browser.CHROME,platform,'stable');
  const chrome = await browsers.install({browser:browsers.Browser.CHROME,buildId,platform,cacheDir:join(runDir,'chrome')});
  browser = await puppeteer.launch({executablePath:chrome.executablePath,headless:true,args:['--no-sandbox']});
  page = await browser.newPage();
  await page.setViewport({width:1440,height:900,deviceScaleFactor:2});
  const applyRequests = [];
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error)));
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/v1/system/app-update/apply') applyRequests.push(JSON.parse(request.postData()));
  });
  await page.goto('http://127.0.0.1:24792/settings/updates', {waitUntil:'domcontentloaded',timeout:60000});
  events.push({systemVersion:await request('/api/v1/system/version'),initialUrl:page.url(),initialText:await page.evaluate(()=>document.body.innerText)});
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(button=>button.innerText==='Skip setup'),{timeout:30000});
  const onboardingSaved = page.waitForResponse(response=>new URL(response.url()).pathname === '/api/v1/settings/general' && response.request().method() === 'PUT');
  await page.locator('button::-p-text(Skip setup)').click();
  assert.equal((await onboardingSaved).status(),200);
  await page.waitForFunction(()=>![...document.querySelectorAll('button')].some(button=>button.innerText==='Skip setup'),{timeout:30000});
  const updateSelector = '[aria-label$="Download the update and restart bb"]';
  await page.waitForSelector(updateSelector,{visible:true,timeout:60000});
  const beforeText = await page.$eval('[data-updates-domain="bb"]', element=>element.innerText);
  assert.ok(beforeText.includes('Server'), beforeText);
  assert.ok(beforeText.includes(qa.from), beforeText);
  assert.ok(beforeText.includes(qa.to), beforeText);
  const failUpdate = async (name, message) => {
    const response = page.waitForResponse(response=>new URL(response.url()).pathname === '/api/v1/system/app-update/apply');
    await page.click(updateSelector);
    assert.equal((await response).status(),200);
    const failed = await wait(name, async()=> {
      const result = await request('/api/v1/system/app-update');
      return result.activity.phase === 'idle' && result.lastResult?.message?.includes(message) ? result : false;
    });
    assert.equal(failed.lastResult.outcome,'failed');
    assert.equal(failed.lastResult.phase,'install');
    const persisted = JSON.parse(await readFile(join(dataDir,'bb-desktop-app-update.json'),'utf8'));
    assert.equal(persisted.pending,null);
    assert.equal(persisted.lastResult.id,failed.lastResult.id);
    assert.equal(JSON.parse(await readFile(join(userData,'owned-runtime.json'),'utf8')).pid,runtime.pid);
    await page.reload({waitUntil:'domcontentloaded'});
    await page.waitForSelector(updateSelector,{visible:true,timeout:30000});
    const failureText = await page.$eval('[data-updates-domain="bb"]',element=>element.innerText);
    assert.ok(failureText.includes('Last update failed'),failureText);
    await page.screenshot({path:join(artifacts,`native-${name}.png`),type:'png'});
    events.push({failure:name,status:failed,text:failureText});
  };
  const windowState = join(userData,'window-state.json');
  await rm(windowState,{force:true});
  await mkdir(windowState);
  await failUpdate('window-state-failure','EISDIR');
  await rm(windowState,{recursive:true});
  await rename(installed,`${installed}.saved`);
  await mkdir(installed);
  await failUpdate('native-installer-failure','EISDIR');
  await rm(installed,{recursive:true});
  await rename(`${installed}.saved`,installed);
  installWatcher = watch(runDir,(event,filename)=> {
    if (filename !== basename(installed) || stoppedAt !== undefined) return;
    process.kill(runtime.pid,'SIGSTOP');
    stoppedAt = Date.now();
    events.push({slowShutdownPid:runtime.pid,stoppedAt});
    installWatcher.close();
  });
  const applyResponse = page.waitForResponse(response=>new URL(response.url()).pathname === '/api/v1/system/app-update/apply',{timeout:30000});
  await page.click(updateSelector);
  const response = await applyResponse;
  assert.equal(response.status(),200);
  const started = await response.json();
  assert.notEqual(started.activity.phase,'idle');
  assert.deepEqual(applyRequests,Array.from({length:3},()=>({confirmInterruptingThreads:false})));
  events.push({browser:await browser.version(),beforeText,applyRequests,started,pageErrors});
  const result = await wait('updated server and persisted result after native install', async () => {
    const status = await request('/api/v1/system/app-update');
    return status.current.version === qa.to && status.lastResult?.outcome === 'updated' ? status : false;
  });
  const newRuntime = JSON.parse(await readFile(join(userData, 'owned-runtime.json'), 'utf8'));
  assert.notEqual(newRuntime.pid, runtime.pid);
  assert.ok(stoppedAt !== undefined);
  assert.ok(Date.now()-stoppedAt >= 4000, "The owned runtime shutdown was not delayed");
  assert.equal(result.lastResult.from.version, qa.from);
  assert.equal(result.lastResult.to.version, qa.to);
  assert.equal(result.desktopUpdateSupported, true);
  await request('/api/v1/system/app-update/acknowledge', { id: result.lastResult.id });
  assert.equal((await request('/api/v1/system/app-update')).lastResult.acknowledged, true);
  await page.reload({waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForFunction(version=>document.querySelector('[data-updates-domain="bb"]')?.innerText.includes(version),{timeout:60000},qa.to);
  const afterText = await page.$eval('[data-updates-domain="bb"]', element=>element.innerText);
  assert.ok(!afterText.includes(qa.from),afterText);
  assert.ok(afterText.includes('Server'),afterText);
  events.push({ after: result, newRuntimePid: newRuntime.pid, afterText, pageErrors });
  console.log(`PASS: window-state failure, native installer failure, persisted errors and UI retry through AppImage update ${qa.from} -> ${qa.to}; native replacement, server restart, persisted result, acknowledgment.`);
} finally {
  installWatcher?.close();
  if (page) {
    try {
      events.push({finalUrl:page.url(),finalText:await page.evaluate(()=>document.body.innerText),buttons:await page.$$eval('button',buttons=>buttons.map(button=>({label:button.getAttribute('aria-label'),text:button.innerText})))});
      await page.screenshot({path:join(artifacts,'native-ui-final.png'),type:'png'});
    } catch (error) { events.push({captureError:String(error)}); }
  }

  await writeFile(join(artifacts, 'qa-result.json'), JSON.stringify({ head: qa.head, events }, null, 2));
  await writeFile(join(artifacts, 'qa-desktop.log'), logs);
  if (browser) await browser.close();
  try { process.kill(-child.pid,'SIGTERM'); } catch {}
  try { const owned=JSON.parse(await readFile(join(userData,'owned-runtime.json'),'utf8'));process.kill(owned.pid,'SIGTERM'); } catch {}
  await new Promise(resolve => feed.close(resolve));
}

process.exit(0);
