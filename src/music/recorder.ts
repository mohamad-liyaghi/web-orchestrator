/**
 * Records the master output with MediaRecorder in a format the browser supports, then converts
 * the take to a 16-bit WAV (plays and imports everywhere). Falls back to the compressed take
 * when the browser cannot decode its own recording.
 */
import type { Recording } from '../types';

const FORMATS: ReadonlyArray<[mime: string, ext: string]> = [
  ['audio/webm;codecs=opus', 'webm'],
  ['audio/mp4;codecs=mp4a.40.2', 'm4a'],
  ['audio/mp4', 'm4a'],
  ['audio/ogg;codecs=opus', 'ogg'],
  ['audio/webm', 'webm'],
];

function pickFormat(): [string, string] | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const f of FORMATS) {
    try {
      if (MediaRecorder.isTypeSupported(f[0])) return [f[0], f[1]];
    } catch {
      /* some browsers throw on unknown types */
    }
  }
  return ['', ''];
}

function extensionFor(mime: string): string {
  if (mime.includes('mp4') || mime.includes('aac')) return 'm4a';
  if (mime.includes('ogg')) return 'ogg';
  return 'webm';
}

/** 16-bit PCM WAV (interleaved, little endian) from an AudioBuffer. */
export function encodeWav(buffer: AudioBuffer): Blob {
  const channels = Math.min(2, buffer.numberOfChannels);
  const frames = buffer.length;
  const rate = buffer.sampleRate;
  const bytes = frames * channels * 2;
  const out = new DataView(new ArrayBuffer(44 + bytes));
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  out.setUint32(4, 36 + bytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, channels, true);
  out.setUint32(24, rate, true);
  out.setUint32(28, rate * channels * 2, true);
  out.setUint16(32, channels * 2, true);
  out.setUint16(34, 16, true);
  str(36, 'data');
  out.setUint32(40, bytes, true);
  const data = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const v = Math.max(-1, Math.min(1, data[c]![i]!));
      out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([out.buffer], { type: 'audio/wav' });
}

export class MasterRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;

  constructor(
    private readonly stream: MediaStream,
    private readonly decode: (data: ArrayBuffer) => Promise<AudioBuffer>,
  ) {}

  get isRecording(): boolean {
    return this.recorder !== null;
  }

  start(): void {
    if (this.recorder) return;
    const format = pickFormat();
    if (!format) throw new Error('this browser cannot record audio');
    const [mime] = format;
    const rec = new MediaRecorder(this.stream, mime ? { mimeType: mime, audioBitsPerSecond: 160_000 } : undefined);
    this.chunks = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    rec.start(1000);
    this.startedAt = performance.now();
    this.recorder = rec;
  }

  async stop(): Promise<Recording> {
    const take = await this.stopCompressed();
    if (take.blob.size === 0) return take;
    try {
      const audio = await this.decode(await take.blob.arrayBuffer());
      if (!audio.length) return take;
      return { blob: encodeWav(audio), mimeType: 'audio/wav', extension: 'wav', durationMs: take.durationMs };
    } catch {
      return take;
    }
  }

  private stopCompressed(): Promise<Recording> {
    const rec = this.recorder;
    if (!rec) return Promise.reject(new Error('not recording'));
    this.recorder = null;
    const durationMs = performance.now() - this.startedAt;
    return new Promise<Recording>((resolve, reject) => {
      rec.onstop = () => {
        const mimeType = (rec.mimeType || this.chunks[0]?.type || 'audio/webm').split(';')[0]!;
        const blob = new Blob(this.chunks, { type: mimeType });
        this.chunks = [];
        resolve({ blob, mimeType, extension: extensionFor(mimeType), durationMs });
      };
      rec.onerror = () => reject(new Error('recording failed'));
      if (rec.state === 'inactive') rec.onstop(new Event('stop'));
      else rec.stop();
    });
  }

  dispose(): void {
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    this.recorder = null;
    this.chunks = [];
  }
}
