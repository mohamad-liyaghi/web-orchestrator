#!/usr/bin/env node
/**
 * Headless check of the music engine: opens dev/music.html in headless Chrome (autoplay allowed),
 * runs window.__musicSelfTest() and prints the report. Needs a running dev server:
 *
 *   npx vite --port 5182 --strictPort &
 *   node dev/music-check.mjs http://localhost:5182/dev/music.html
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2] ?? 'http://localhost:5182/dev/music.html';
const expr = process.argv[3] ?? 'window.__musicSelfTest()';
const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), 'music-check-'));
const chrome = spawn('google-chrome', [
  '--headless=new',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  '--autoplay-policy=no-user-gesture-required',
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank',
], { stdio: 'ignore' });

const cleanup = () => {
  chrome.kill('SIGTERM');
  setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500);
};

async function target() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('chrome did not start');
}

try {
  const ws = new WebSocket(await target());
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  const logs = [];
  const failed = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      if (msg.params.type === 'error' || msg.params.type === 'warning') logs.push(`${msg.params.type}: ${text}`);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      logs.push(`exception: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
    } else if (msg.method === 'Network.responseReceived' && msg.params.response.status >= 400) {
      failed.push(`${msg.params.response.status} ${msg.params.response.url}`);
    } else if (msg.method === 'Log.entryAdded' && ['error', 'warning'].includes(msg.params.entry.level)) {
      logs.push(`${msg.params.entry.level}: ${msg.params.entry.text}`);
    }
  };
  const send = (method, params = {}) => new Promise((r) => {
    const n = ++id;
    pending.set(n, r);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Page.navigate', { url });
  await new Promise((r) => setTimeout(r, 2500));
  const t0 = Date.now();
  const res = await send('Runtime.evaluate', { expression: `Promise.resolve(${expr}).then((r) => JSON.stringify(r))`, awaitPromise: true, returnByValue: true, timeout: 600000 });
  const raw = res.result?.result?.value;
  const report = typeof raw === 'string' ? JSON.parse(raw) : res.result;
  console.log(JSON.stringify({ seconds: Math.round((Date.now() - t0) / 1000), report, console: logs, httpErrors: failed }, null, 1));
  ws.close();
} catch (e) {
  console.error('[music-check]', e);
  process.exitCode = 1;
} finally {
  cleanup();
}
