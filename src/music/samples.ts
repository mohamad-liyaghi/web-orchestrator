/**
 * Sample library: fetches an instrument's per-note MP3s with real byte progress, decodes them,
 * finds each note's true onset (decoders differ in how much encoder padding they keep) and caches
 * the result in a small LRU so switching back and forth is instant without growing memory.
 */
import type { BaseContext } from 'tone/build/esm/core/context/BaseContext.js';

/** public/samples/manifest.json, written by scripts/build-samples.mjs. */
interface ManifestEntry {
  notes: string[];
  bytes: number;
  /** Sustained instruments: loop [start, end] in seconds from the trimmed note start. */
  loops?: Record<string, [number, number]>;
}
type Manifest = Record<string, ManifestEntry>;

export interface SampleZone {
  midi: number;
  buffer: AudioBuffer;
  /** Playback start in seconds: skips any decoder padding before the attack. */
  offset: number;
  loopStart: number;
  loopEnd: number;
  loop: boolean;
}

export interface SampleSet {
  id: string;
  zones: SampleZone[];
  /** MIDI note -> nearest zone. */
  nearest: (SampleZone | undefined)[];
}

/** Onset threshold relative to the peak, the same one the build script trimmed with. */
const ONSET_REL = 0.01;
/** The builder starts every file 2 ms before the threshold crossing. */
const BUILT_PREROLL = 0.002;

function noteToMidi(name: string): number {
  const m = /^([A-G])(b?)(-?\d+)$/.exec(name);
  if (!m) throw new Error(`bad note name ${name}`);
  const pcs: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  return pcs[m[1]!]! - (m[2] ? 1 : 0) + 12 * (Number(m[3]) + 1);
}

function findOnset(buffer: AudioBuffer): number {
  const x = buffer.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]!);
    if (a > peak) peak = a;
  }
  const th = peak * ONSET_REL;
  let i = 0;
  while (i < x.length && Math.abs(x[i]!) < th) i++;
  return i / buffer.sampleRate;
}

export class SampleLibrary {
  private manifest: Promise<Manifest> | null = null;
  private readonly cache = new Map<string, SampleSet>();
  private readonly pending = new Map<string, { promise: Promise<SampleSet>; abort: AbortController }>();

  constructor(
    private readonly ctx: BaseContext,
    private readonly baseUrl: string,
    private readonly capacity = 6,
  ) {}

  /** Cached set (marks it most recently used). */
  get(id: string): SampleSet | undefined {
    const set = this.cache.get(id);
    if (set) {
      this.cache.delete(id);
      this.cache.set(id, set);
    }
    return set;
  }

  isLoading(id: string): boolean {
    return this.pending.has(id);
  }

  load(id: string, onProgress: (p: number) => void): Promise<SampleSet> {
    const hit = this.get(id);
    if (hit) return Promise.resolve(hit);
    const running = this.pending.get(id);
    if (running) return running.promise;
    const abort = new AbortController();
    const promise = this.fetchSet(id, abort, onProgress).finally(() => this.pending.delete(id));
    this.pending.set(id, { promise, abort });
    return promise;
  }

  /** Stop downloads nobody wants any more. */
  cancelExcept(keep: ReadonlySet<string>): void {
    for (const [id, p] of this.pending) if (!keep.has(id)) p.abort.abort();
  }

  /** Evict least recently used sets beyond capacity, never the ones in use. */
  trim(inUse: ReadonlySet<string>): void {
    for (const id of this.cache.keys()) {
      if (this.cache.size <= this.capacity) break;
      if (!inUse.has(id)) this.cache.delete(id);
    }
  }

  dispose(): void {
    for (const p of this.pending.values()) p.abort.abort();
    this.pending.clear();
    this.cache.clear();
  }

  private getManifest(): Promise<Manifest> {
    if (!this.manifest) {
      this.manifest = fetch(`${this.baseUrl}/manifest.json`, { cache: 'force-cache' })
        .then((r) => {
          if (!r.ok) throw new Error(`sample manifest: HTTP ${r.status}`);
          return r.json() as Promise<Manifest>;
        })
        .catch((e: unknown) => {
          this.manifest = null; // retry next time
          throw e;
        });
    }
    return this.manifest;
  }

  private async fetchSet(id: string, abort: AbortController, onProgress: (p: number) => void): Promise<SampleSet> {
    const manifest = await this.getManifest();
    const entry = manifest[id];
    if (!entry || !entry.notes.length) throw new Error(`no samples for "${id}"`);
    const total = Math.max(1, entry.bytes);
    let loaded = 0;
    onProgress(0);
    const zones = await Promise.all(
      entry.notes.map(async (note): Promise<SampleZone> => {
        try {
          const res = await fetch(`${this.baseUrl}/${id}/${note}.mp3`, { signal: abort.signal });
          if (!res.ok) throw new Error(`${id}/${note}.mp3: HTTP ${res.status}`);
          const data = await res.arrayBuffer();
          loaded += data.byteLength;
          onProgress(Math.min(0.99, loaded / total));
          const buffer = await this.ctx.decodeAudioData(data);
          if (abort.signal.aborted) throw new DOMException('aborted', 'AbortError');
          return makeZone(note, buffer, entry.loops?.[note]);
        } catch (e) {
          abort.abort(); // one bad file fails the instrument: stop the other downloads
          throw e;
        }
      }),
    );
    zones.sort((a, b) => a.midi - b.midi);
    const nearest: (SampleZone | undefined)[] = new Array(128);
    for (let m = 0; m < 128; m++) {
      let best: SampleZone | undefined;
      for (const z of zones) if (!best || Math.abs(z.midi - m) < Math.abs(best.midi - m)) best = z;
      nearest[m] = best;
    }
    const set: SampleSet = { id, zones, nearest };
    this.cache.set(id, set);
    onProgress(1);
    return set;
  }
}

function makeZone(note: string, buffer: AudioBuffer, loop: [number, number] | undefined): SampleZone {
  const shift = findOnset(buffer) - BUILT_PREROLL;
  return {
    midi: noteToMidi(note),
    buffer,
    offset: Math.max(0, shift),
    loop: !!loop,
    loopStart: loop ? Math.max(0, loop[0] + shift) : 0,
    loopEnd: loop ? Math.min(buffer.duration, loop[1] + shift) : 0,
  };
}
