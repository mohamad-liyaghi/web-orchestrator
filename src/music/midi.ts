/**
 * Web MIDI output: mirrors the live voices as MIDI notes (lead on the chosen channel, bass on the
 * next one), with note-on velocity from the expression and CC 11 (expression) following the
 * loudness while notes hold. Access is only requested when the user turns MIDI out on; browsers
 * without Web MIDI (Safari) report `supported: false` and the UI hides the option.
 */
import type { MidiPortInfo, MidiStatus } from '../types';

const NOTE_ON = 0x90;
const NOTE_OFF = 0x80;
const CC = 0xb0;
const CC_EXPRESSION = 11;
const CC_ALL_NOTES_OFF = 123;
/** Notes we hold at most (they are released or forgotten beyond this, never left stuck). */
const MAX_HELD = 64;

interface Held {
  /** 0 = lead, 1 = bass (channel offset). */
  voice: 0 | 1;
  channel: number;
  note: number;
  velocity: number;
}

export function midiSupported(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function';
}

export class MidiOut {
  private readonly st: MidiStatus = {
    supported: midiSupported(),
    enabled: false,
    pending: false,
    error: '',
    outputs: [],
    connected: false,
  };
  private access: MIDIAccess | null = null;
  private request: Promise<MidiStatus> | null = null;
  private port: MIDIOutput | null = null;
  private wanted = '';
  /** 0-based channel of the lead voice. */
  private channel = 0;
  private readonly held = new Map<number, Held>();
  private readonly expr = [-1, -1];
  private readonly listeners = new Set<(s: MidiStatus) => void>();
  private disposed = false;

  get status(): MidiStatus {
    return this.st;
  }

  /** Sending is possible right now. */
  get active(): boolean {
    return !!this.port;
  }

  onChange(cb: (s: MidiStatus) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Requests access (permission prompt) once; later calls rescan the outputs. */
  enable(): Promise<MidiStatus> {
    if (!this.st.supported || this.disposed) return Promise.resolve(this.snapshot());
    if (this.access) {
      this.refresh();
      return Promise.resolve(this.snapshot());
    }
    if (this.request) return this.request;
    this.st.pending = true;
    this.st.error = '';
    this.emit();
    this.request = navigator
      .requestMIDIAccess({ sysex: false })
      .then((access) => {
        this.request = null;
        if (this.disposed) return this.snapshot();
        this.access = access;
        access.onstatechange = () => this.refresh();
        this.st.pending = false;
        this.st.enabled = true;
        this.refresh();
        return this.snapshot();
      })
      .catch((e: unknown) => {
        this.request = null;
        this.st.pending = false;
        this.st.enabled = false;
        const name = e instanceof DOMException ? e.name : '';
        this.st.error =
          name === 'SecurityError' || name === 'NotAllowedError'
            ? 'MIDI access was blocked. Allow MIDI devices for this site in the browser settings.'
            : 'MIDI is not available in this browser.';
        this.emit();
        return this.snapshot();
      });
    return this.request;
  }

  /** Selects the output ('' = off) and the lead channel (1..16). Notes held right now move along:
   *  released where they were, sounded again on the new port / channel. */
  configure(outputId: string, channel: number): void {
    const ch = Math.max(0, Math.min(15, Math.round(channel) - 1));
    if (outputId === this.wanted && ch === this.channel) return;
    const oldPort = this.port;
    if (oldPort) {
      for (const h of this.held.values()) this.send(oldPort, [NOTE_OFF | h.channel, h.note, 0]);
      for (const c of [this.channel, (this.channel + 1) % 16]) this.send(oldPort, [CC | c, CC_ALL_NOTES_OFF, 0]);
    }
    this.wanted = outputId;
    this.channel = ch;
    this.bindPort();
    const port = this.port;
    for (const [key, h] of this.held) {
      if (!port) {
        this.held.delete(key);
        continue;
      }
      h.channel = (ch + h.voice) % 16;
      this.send(port, [NOTE_ON | h.channel, h.note, h.velocity]);
    }
  }

  /** voice 0 = lead, 1 = bass. `at` is a performance.now() timestamp (undefined = now). */
  noteOn(key: number, voice: 0 | 1, midi: number, velocity: number, at?: number): void {
    const port = this.port;
    if (!port) return;
    const note = Math.max(0, Math.min(127, Math.round(midi)));
    const channel = (this.channel + voice) % 16;
    const vel = Math.max(1, Math.min(127, Math.round(velocity * 127)));
    this.send(port, [NOTE_ON | channel, note, vel], at);
    this.held.set(key, { voice, channel, note, velocity: vel });
    if (this.held.size > MAX_HELD) {
      const [oldKey, old] = this.held.entries().next().value!;
      this.held.delete(oldKey);
      this.send(port, [NOTE_OFF | old.channel, old.note, 0], at);
    }
  }

  /** A held note moved to another pitch without a new attack: re-sound it there. */
  glide(key: number, midi: number, at?: number): void {
    const h = this.held.get(key);
    const port = this.port;
    if (!h || !port) return;
    const note = Math.max(0, Math.min(127, Math.round(midi)));
    if (note === h.note) return;
    this.send(port, [NOTE_ON | h.channel, note, h.velocity], at);
    this.send(port, [NOTE_OFF | h.channel, h.note, 0], at);
    h.note = note;
  }

  noteOff(key: number, at?: number): void {
    const h = this.held.get(key);
    if (!h) return;
    this.held.delete(key);
    if (this.port) this.send(this.port, [NOTE_OFF | h.channel, h.note, 0], at);
  }

  /** Continuous loudness 0..1 of a voice as CC 11; sent only when it moves. */
  expression(voice: 0 | 1, value: number): void {
    const port = this.port;
    if (!port) return;
    const v = Math.max(0, Math.min(127, Math.round(value * 127)));
    const last = this.expr[voice]!;
    if (last >= 0 && Math.abs(v - last) < 2 && !(v === 0 && last !== 0) && !(v === 127 && last !== 127)) return;
    this.expr[voice] = v;
    this.send(port, [CC | ((this.channel + voice) % 16), CC_EXPRESSION, v]);
  }

  /** Note-offs for everything we hold plus "all notes off" on both channels (one voice: just it). */
  allNotesOff(voice?: 0 | 1): void {
    const port = this.port;
    const channels = voice === undefined ? [this.channel, (this.channel + 1) % 16] : [(this.channel + voice) % 16];
    for (const [key, h] of this.held) {
      if (!channels.includes(h.channel)) continue;
      this.held.delete(key);
      if (port) this.send(port, [NOTE_OFF | h.channel, h.note, 0]);
    }
    if (port) for (const c of channels) this.send(port, [CC | c, CC_ALL_NOTES_OFF, 0]);
  }

  dispose(): void {
    if (this.disposed) return;
    this.allNotesOff();
    this.disposed = true;
    if (this.access) this.access.onstatechange = null;
    this.access = null;
    this.port = null;
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------------------------

  private send(port: MIDIOutput, data: number[], at?: number): void {
    try {
      if (at !== undefined && at > performance.now() + 1) port.send(data, at);
      else port.send(data);
    } catch {
      // The device went away between the state change and this call: drop it.
      this.port = null;
      this.held.clear();
      this.st.connected = false;
      this.emit();
    }
  }

  private refresh(): void {
    const access = this.access;
    if (!access || this.disposed) return;
    const list: MidiPortInfo[] = [];
    access.outputs.forEach((o) => {
      if (o.state !== 'disconnected') list.push({ id: o.id, name: o.name || o.manufacturer || 'MIDI output' });
    });
    this.st.outputs = list;
    this.bindPort();
  }

  private bindPort(): void {
    const access = this.access;
    let next: MIDIOutput | null = null;
    if (access && this.wanted) {
      const o = access.outputs.get(this.wanted);
      if (o && o.state !== 'disconnected') next = o;
    }
    if (next !== this.port) {
      // Unplugged: nothing is left ringing on our account (configure() moves notes on a switch).
      if (this.port && !next) this.held.clear();
      this.port = next;
      this.expr[0] = this.expr[1] = -1;
      if (next) void next.open().catch(() => undefined);
    }
    this.st.connected = !!this.port;
    this.emit();
  }

  private snapshot(): MidiStatus {
    return { ...this.st, outputs: this.st.outputs.slice() };
  }

  private emit(): void {
    if (!this.listeners.size) return;
    const s = this.snapshot();
    for (const cb of this.listeners) cb(s);
  }
}
