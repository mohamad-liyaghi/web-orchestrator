/**
 * Tone.js 15 leaks one native oscillator per note: Oscillator._start() builds a fresh native
 * oscillator for every start after a stop and connects the long-lived `frequency` and `detune`
 * signals into its AudioParams, but never disconnects them. The live signal keeps every finished
 * oscillator (and its gain) alive, so short beat hits and synth notes pile up for the whole
 * session (about one audio node per beat with the groove on).
 *
 * The patch disconnects both signals from a native oscillator once it has ended. Tone calls
 * `onended` after the stop time, when the oscillator is already silent, right before it disposes
 * the node, so nothing audible changes.
 */
import { Oscillator } from 'tone/build/esm/classes.js';

interface ParamLike {
  readonly input?: unknown;
}

interface NativeOscLike {
  frequency: ParamLike;
  detune: ParamLike;
  onended: (source: unknown) => void;
}

interface OscillatorInternals {
  _oscillator: NativeOscLike | null;
  _start(time?: unknown): void;
  frequency: { disconnect(dest: ParamLike): unknown };
  detune: { disconnect(dest: ParamLike): unknown };
}

const PATCHED = Symbol.for('orchestrator.toneOscillatorLeakFix');

export function patchToneOscillatorLeak(): void {
  const proto = Oscillator.prototype as unknown as OscillatorInternals & { [PATCHED]?: true };
  if (proto[PATCHED]) return;
  proto[PATCHED] = true;
  const start = proto._start;
  proto._start = function (this: OscillatorInternals, time?: unknown): void {
    start.call(this, time);
    const node = this._oscillator;
    if (!node) return;
    const frequency = this.frequency;
    const detune = this.detune;
    const ended = node.onended;
    node.onended = (source: unknown): void => {
      try {
        frequency.disconnect(node.frequency);
        detune.disconnect(node.detune);
      } catch {
        // already disconnected (the oscillator itself was disposed first)
      }
      ended(source);
    };
  };
}

patchToneOscillatorLeak();
