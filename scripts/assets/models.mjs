/**
 * MediaPipe wasm runtime + landmarker models. Owned by the tracking module.
 *
 *   node_modules/@mediapipe/tasks-vision/wasm/*  ->  public/mediapipe/wasm/
 *   hand_landmarker.task, face_landmarker.task   ->  public/models/
 *
 * Writes are atomic (temp file + rename) so an interrupted run never leaves a truncated model
 * behind. Existing files are kept unless `force` is set.
 */
import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WASM_SRC = join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const WASM_DEST = join(ROOT, 'public', 'mediapipe', 'wasm');
const MODELS_DEST = join(ROOT, 'public', 'models');

const MODELS = [
  {
    file: 'hand_landmarker.task',
    url: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  },
  {
    file: 'face_landmarker.task',
    url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  },
];

const MIN_MODEL_BYTES = 1024 * 1024;
const ATTEMPTS = 3;
const TIMEOUT_MS = 60_000;

const log = (msg) => console.log(`[assets:models] ${msg}`);
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function sizeOf(path) {
  try {
    const s = await stat(path);
    return s.isFile() ? s.size : -1;
  } catch {
    return -1;
  }
}

/** Writes `data` (Buffer or path to copy) to `dest` through a temp file in the same directory. */
async function atomicWrite(dest, data) {
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  try {
    if (typeof data === 'string') await copyFile(data, tmp);
    else await writeFile(tmp, data);
    await rename(tmp, dest);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

async function copyWasm(force) {
  let names;
  try {
    names = (await readdir(WASM_SRC)).filter((n) => n.endsWith('.js') || n.endsWith('.wasm'));
  } catch {
    throw new Error(`MediaPipe wasm not found at ${WASM_SRC}. Run "npm install" first.`);
  }
  if (names.length === 0) throw new Error(`No wasm files in ${WASM_SRC}.`);
  await mkdir(WASM_DEST, { recursive: true });

  let copied = 0;
  for (const name of names) {
    const src = join(WASM_SRC, name);
    const dest = join(WASM_DEST, name);
    const srcSize = await sizeOf(src);
    // Same size = same file for our purposes; a package upgrade changes the sizes.
    if (!force && (await sizeOf(dest)) === srcSize) continue;
    await atomicWrite(dest, src);
    copied++;
  }
  log(copied ? `wasm runtime: copied ${copied}/${names.length} files` : `wasm runtime: up to date (${names.length} files)`);
}

async function download(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const expected = Number(res.headers.get('content-length') || 0);
    if (expected && buf.length !== expected) throw new Error(`truncated: got ${buf.length} of ${expected} bytes`);
    if (buf.length < MIN_MODEL_BYTES) throw new Error(`file too small (${buf.length} bytes)`);
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchModel({ file, url }, force) {
  const dest = join(MODELS_DEST, file);
  const existing = await sizeOf(dest);
  if (!force && existing >= MIN_MODEL_BYTES) {
    log(`${file}: present (${mb(existing)})`);
    return;
  }
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    try {
      log(`${file}: downloading${attempt > 1 ? ` (attempt ${attempt}/${ATTEMPTS})` : ''}…`);
      const buf = await download(url);
      await atomicWrite(dest, buf);
      log(`${file}: ${mb(buf.length)} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      return;
    } catch (err) {
      const reason = err instanceof Error ? (err.name === 'AbortError' ? 'timed out' : err.message) : String(err);
      if (attempt >= ATTEMPTS) throw new Error(`${file}: download failed after ${ATTEMPTS} attempts: ${reason}`);
      const wait = 1000 * 2 ** (attempt - 1);
      log(`${file}: ${reason}; retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

export async function fetchModels({ force = false } = {}) {
  await copyWasm(force);
  await mkdir(MODELS_DEST, { recursive: true });
  for (const model of MODELS) await fetchModel(model, force);
}
