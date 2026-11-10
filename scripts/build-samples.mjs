#!/usr/bin/env node
/**
 * Builds the self-hosted instrument samples in public/samples/ (dev tool, needs ffmpeg).
 *
 *   node scripts/build-samples.mjs [--only id,id] [--refetch]
 *
 * For every sampled instrument in src/music/instruments.ts it downloads every third semitone of
 * the FluidR3_GM soundfont renders (gleitz/midi-js-soundfonts, CC BY 3.0), then per note:
 *   - trims the leading silence so the attack starts at sample 0 (latency),
 *   - struck/plucked: keeps the natural decay up to a register-dependent length, fades it out,
 *   - sustained: bakes a crossfaded loop into the sustain so held notes never run out,
 *   - normalizes loudness per instrument (consistent level across the catalog),
 *   - re-encodes to 64 kbps mono MP3 (plays everywhere, including Safari).
 * Writes public/samples/<id>/<Note>.mp3 and public/samples/manifest.json. The output is
 * committed, so normal builds never touch the network.
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { INSTRUMENT_SPECS, sampleNotes } from '../src/music/instruments.ts';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'samples');
const CACHE = join(ROOT, 'node_modules', '.cache', 'orchestrator-samples');
const SOURCE = 'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM';
const SR = 44100;
const BITRATE = '64k';
/** Loudness target for the body of each note (RMS, dBFS) and the peak ceiling. */
const TARGET_DB = -17;
const PEAK = 0.89;

const args = process.argv.slice(2);
const onlyArg = args.find((a) => a.startsWith('--only'));
const only = onlyArg ? (onlyArg.split('=')[1] ?? args[args.indexOf(onlyArg) + 1] ?? '').split(',') : null;
const refetch = args.includes('--refetch');

const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const noteFile = (m) => `${FLATS[m % 12]}${Math.floor(m / 12) - 1}`;

async function download(gm, note) {
  const file = join(CACHE, gm, `${note}.mp3`);
  if (!refetch && existsSync(file)) return file;
  await mkdir(dirname(file), { recursive: true });
  const url = `${SOURCE}/${gm}-mp3/${note}.mp3`;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      await writeFile(file, Buffer.from(await res.arrayBuffer()));
      return file;
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

async function decode(file) {
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], {
    encoding: 'buffer',
    maxBuffer: 1 << 28,
  });
  return new Float32Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.length));
}

async function encode(pcm, file) {
  const child = execFile('ffmpeg', ['-v', 'error', '-y', '-f', 'f32le', '-ar', String(SR), '-ac', '1', '-i', 'pipe:0',
    '-c:a', 'libmp3lame', '-b:a', BITRATE, '-ar', String(SR), '-ac', '1', file]);
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code} for ${file}`))));
  });
  child.stdin.end(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  await done;
}

const rms = (x, a, b) => {
  let e = 0;
  const lo = Math.max(0, Math.floor(a));
  const hi = Math.min(x.length, Math.floor(b));
  for (let i = lo; i < hi; i++) e += x[i] * x[i];
  return hi > lo ? Math.sqrt(e / (hi - lo)) : 0;
};

/** Index of the first sample above -40 dB of the peak, minus 2 ms. */
function onsetOf(x) {
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  const th = peak * 0.01;
  let i = 0;
  while (i < x.length && Math.abs(x[i]) < th) i++;
  return Math.max(0, i - Math.round(0.002 * SR));
}

function fadeIn(x, n) {
  for (let i = 0; i < Math.min(n, x.length); i++) x[i] *= i / n;
}

/** Struck/plucked: cut where the decay is ~40 dB down (or at maxDur) and fade out the end. */
function cutDecay(x, maxDur) {
  const win = Math.round(0.05 * SR);
  const ref = rms(x, 0, 0.15 * SR);
  let end = Math.min(x.length, Math.round(maxDur * SR));
  for (let i = Math.round(0.3 * SR); i + win < end; i += win) {
    if (rms(x, i, i + win) < ref * 0.01) {
      end = i + win;
      break;
    }
  }
  const y = x.slice(0, end);
  const fade = Math.min(Math.round(0.35 * SR), Math.floor(end * 0.3));
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    y[end - fade + i] *= Math.pow(1 - t, 2);
  }
  return { pcm: y, body: rms(y, 0, Math.min(end, 0.3 * SR)) };
}

/**
 * Sustained: loop region [L0, L1) with the last `xf` samples crossfaded into the samples right
 * before L0, so jumping from L1 back to L0 is seamless. Some natural continuation is appended
 * after L1 so a decoder offset of a few ms never runs past the loop end into silence.
 */
function bakeLoop(x, loopStart, loopLen) {
  let L0 = Math.round(loopStart * SR);
  let len = Math.round(loopLen * SR);
  const avail = x.length - Math.round(0.25 * SR); // keep clear of any release at the end
  if (L0 + len > avail) {
    len = Math.max(Math.round(0.3 * SR), avail - L0);
    if (L0 + len > avail) L0 = Math.max(Math.round(0.1 * SR), avail - len);
  }
  const xf = Math.min(Math.round(0.3 * SR), Math.floor(len * 0.45), L0);
  const L1 = L0 + len;
  const pad = Math.round(0.08 * SR);
  const y = new Float32Array(L1 + pad);
  y.set(x.subarray(0, L1));
  for (let i = 0; i < xf; i++) {
    // equal-power crossfade of the loop tail into the audio leading up to L0
    const t = (i + 1) / xf;
    const a = Math.cos((t * Math.PI) / 2);
    const b = Math.sin((t * Math.PI) / 2);
    y[L1 - xf + i] = x[L1 - xf + i] * a + x[L0 - xf + i] * b;
  }
  y.set(x.subarray(L0, L0 + pad), L1);
  return { pcm: y, body: rms(x, L0, L1), loop: [L0 / SR, L1 / SR] };
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

async function buildInstrument(spec) {
  const src = spec.sample;
  const notes = sampleNotes(spec.range);
  const lo = notes[0];
  const hi = notes[notes.length - 1];
  const processed = await pool(notes, 8, async (m) => {
    const file = await download(src.gm, noteFile(m));
    const raw = await decode(file);
    const x = raw.slice(onsetOf(raw));
    fadeIn(x, Math.round(0.002 * SR));
    if (src.loop) return { m, ...bakeLoop(x, src.loop[0], src.loop[1]) };
    const t = hi > lo ? (m - lo) / (hi - lo) : 0;
    const maxDur = src.dur[0] + (src.dur[1] - src.dur[0]) * t;
    return { m, ...cutDecay(x, maxDur) };
  });

  // Per-instrument gain from the median note, plus half of each note's own correction.
  const target = Math.pow(10, TARGET_DB / 20);
  const gains = processed.map((p) => target / Math.max(1e-5, p.body)).sort((a, b) => a - b);
  const inst = gains[Math.floor(gains.length / 2)];
  const dir = join(OUT, spec.id);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const loops = {};
  let bytes = 0;
  await pool(processed, 6, async (p) => {
    const own = target / Math.max(1e-5, p.body);
    let g = inst * Math.sqrt(own / inst);
    let peak = 0;
    for (const v of p.pcm) peak = Math.max(peak, Math.abs(v));
    if (peak * g > PEAK) g = PEAK / peak;
    for (let i = 0; i < p.pcm.length; i++) p.pcm[i] *= g;
    const name = noteFile(p.m);
    const file = join(dir, `${name}.mp3`);
    await encode(p.pcm, file);
    const size = (await stat(file)).size;
    bytes += size;
    if (p.loop) loops[name] = [Number(p.loop[0].toFixed(4)), Number(p.loop[1].toFixed(4))];
  });
  const entry = { notes: notes.map(noteFile), bytes };
  if (src.loop) entry.loops = Object.fromEntries(entry.notes.map((n) => [n, loops[n]]));
  return entry;
}

const CREDITS = `Instrument samples
==================

The sampled instruments in this folder are rendered from the FluidR3_GM General MIDI SoundFont
by Frank Wen and contributors, licensed under the Creative Commons Attribution 3.0 license
(https://creativecommons.org/licenses/by/3.0/).

Per-note renders by Benjamin Gleitzman's midi-js-soundfonts project
(https://github.com/gleitz/midi-js-soundfonts).

Modifications: leading silence trimmed, notes shortened and faded or looped, loudness
normalized, re-encoded to 64 kbps mono MP3 (scripts/build-samples.mjs).
`;

async function main() {
  await run('ffmpeg', ['-version']).catch(() => {
    throw new Error('ffmpeg is required to build samples');
  });
  const manifestPath = join(OUT, 'manifest.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(await readFile(manifestPath, 'utf8')) : {};
  const specs = INSTRUMENT_SPECS.filter((s) => s.sample && (!only || only.includes(s.id)));
  // Drop instruments that left the catalog.
  for (const id of Object.keys(manifest)) {
    if (!INSTRUMENT_SPECS.some((s) => s.id === id && s.sample)) {
      delete manifest[id];
      await rm(join(OUT, id), { recursive: true, force: true });
    }
  }
  await mkdir(OUT, { recursive: true });
  let total = 0;
  for (const spec of specs) {
    const t0 = Date.now();
    const entry = await buildInstrument(spec);
    manifest[spec.id] = entry;
    console.log(`${spec.id.padEnd(20)} ${String(entry.notes.length).padStart(3)} notes ${(entry.bytes / 1024).toFixed(0).padStart(5)} KB  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  const ordered = {};
  for (const s of INSTRUMENT_SPECS) if (manifest[s.id]) ordered[s.id] = manifest[s.id];
  await writeFile(manifestPath, JSON.stringify(ordered, null, 0) + '\n');
  await writeFile(join(OUT, 'CREDITS.txt'), CREDITS);
  for (const e of Object.values(ordered)) total += e.bytes;
  console.log(`total ${(total / 1024 / 1024).toFixed(2)} MB in ${Object.keys(ordered).length} instruments`);
  console.log('sizeKB:', JSON.stringify(Object.fromEntries(Object.entries(ordered).map(([k, v]) => [k, Math.round(v.bytes / 1024)]))));
}

main().catch((e) => {
  console.error('[build-samples]', e instanceof Error ? e.message : e);
  process.exit(1);
});
