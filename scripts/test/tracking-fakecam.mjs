#!/usr/bin/env node
/**
 * Runs the tracking harness (dev/tracking.html) in headless Chrome against a fake webcam and
 * prints what the tracker saw. Needs a running dev server (npx vite --port <port>).
 *
 *   node scripts/test/tracking-fakecam.mjs --video pic.y4m [--url http://localhost:5181] [--seconds 10]
 *        [--lowpower] [--cpu | --gpu] [--deny] [--no-device] [--chrome-flag=--foo ...]
 *
 * Make a fake webcam from a picture:
 *   ffmpeg -loop 1 -i pic.jpg -t 1 -r 30 -pix_fmt yuv420p fake.y4m   (Chrome loops the file)
 *
 * --deny       camera permission prompt is answered "block"
 * --no-device  no fake device at all (expects camera-not-found on a machine without a camera)
 * Prints a JSON report on stdout; exit code 0 unless the page could not be driven.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);
const extraFlags = args.filter((a) => a.startsWith('--chrome-flag=')).map((a) => a.slice('--chrome-flag='.length));

const baseUrl = opt('url', 'http://localhost:5181');
const seconds = Number(opt('seconds', '10'));
const video = opt('video', '');
const chromeBin = opt('chrome', 'google-chrome');
const query = ['auto', flag('lowpower') ? 'lowpower' : '', flag('cpu') ? 'cpu' : '', flag('gpu') ? 'gpu' : ''].filter(Boolean).join('&');
const pageUrl = `${baseUrl}/dev/tracking.html?${query}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = await mkdtemp(join(tmpdir(), 'trk-chrome-'));
const chromeArgs = [
  '--headless=new',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--remote-debugging-port=0',
  `--user-data-dir=${profile}`,
  '--autoplay-policy=no-user-gesture-required',
  '--window-size=1280,720',
  ...extraFlags,
];
if (!flag('no-device')) {
  chromeArgs.push('--use-fake-device-for-media-stream');
  if (video) chromeArgs.push(`--use-file-for-fake-video-capture=${resolve(video)}`);
}
chromeArgs.push(flag('deny') ? '--deny-permission-prompts' : '--use-fake-ui-for-media-stream');

const chrome = spawn(chromeBin, [...chromeArgs, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeLog = '';
chrome.stderr.on('data', (d) => {
  chromeLog = (chromeLog + d).slice(-4000);
});

async function cleanup() {
  chrome.kill('SIGTERM');
  await sleep(300);
  if (chrome.exitCode === null) chrome.kill('SIGKILL');
  await rm(profile, { recursive: true, force: true }).catch(() => undefined);
}

try {
  let port = 0;
  for (let i = 0; i < 100 && !port; i++) {
    await sleep(100);
    port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n')[0] || 0);
  }
  if (!port) throw new Error(`Chrome did not start:\n${chromeLog}`);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const pending = new Map();
  const consoleLines = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      consoleLines.push(`${msg.params.type}: ${text}`.slice(0, 300));
    } else if (msg.method === 'Runtime.exceptionThrown') {
      consoleLines.push(`exception: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`.slice(0, 300));
    } else if (msg.method === 'Log.entryAdded') {
      consoleLines.push(`log.${msg.params.entry.level}: ${msg.params.entry.text}`.slice(0, 300));
    }
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      const mid = ++id;
      pending.set(mid, res);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r.result?.result?.value;
  };

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: pageUrl });

  const samples = [];
  const started = Date.now();
  let summary = null;
  while (Date.now() - started < seconds * 1000) {
    await sleep(500);
    const raw = await evaluate('JSON.stringify(window.__tracking ? window.__tracking.summary : null)');
    summary = raw ? JSON.parse(raw) : null;
    if (summary) {
      samples.push({
        t: ((Date.now() - started) / 1000).toFixed(1),
        state: summary.state,
        fps: Number(summary.fps.toFixed(1)),
        hands: summary.hands.map((h) => `${h.id}:${h.side}@${h.centerX.toFixed(2)} f${h.fingersUp} ${h.gesture} p${h.pinch.toFixed(2)}`).join(" "),
        quality: summary.quality ? `${summary.quality.verdict} ${summary.quality.score.toFixed(2)}` : null,
        mouth: summary.face ? Number(summary.face.mouthOpen.toFixed(2)) : null,
      });
      if (summary.state === 'error') break;
    }
  }
  const gl = await evaluate(`(() => { const c = document.createElement('canvas'); const g = c.getContext('webgl2'); if (!g) return 'no webgl2'; const d = g.getExtension('WEBGL_debug_renderer_info'); return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'webgl2'; })()`);
  const memory = await evaluate('performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null');
  console.log(JSON.stringify({ url: pageUrl, video: video || null, webgl: gl, jsHeapMB: memory, summary, samples, console: consoleLines }, null, 2));
  ws.close();
} catch (e) {
  console.error('[fakecam] failed:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await cleanup();
}
