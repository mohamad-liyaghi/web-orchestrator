/**
 * standardized-audio-context (under Tone.js) records every automation call per AudioParam in an
 * `automation-events` AutomationEventList and calls `flush(currentTime)` before each new call to
 * drop history that no longer matters. automation-events 7.1.19 only trims when at least one event
 * lies after `currentTime`. The engine re-targets each voice's filter, vibrato and gain at
 * "now" on every tracking frame, so by the next frame every event is in the past, nothing is ever
 * trimmed, and each call scans an ever-longer list: per-frame update time grew from ~0.25 ms to
 * ~0.6 ms in 3.5 minutes and kept growing.
 *
 * The patch runs the original flush and, when every event is already in the past, flushes again
 * just before the last event. That is the original algorithm's own trim (it keeps the event before
 * it and turns a leading setTarget into the exact value it had reached), so what is heard does not
 * change; only the dead history goes.
 */
import { AutomationEventList } from 'automation-events';

interface AutomationEventLike {
  type: string;
  startTime?: number;
  endTime?: number;
  cancelTime?: number;
}

interface ListInternals {
  _automationEvents?: AutomationEventLike[];
  flush(time: number): void;
}

/** Same rule as automation-events' getEventTime(). */
const eventTime = (e: AutomationEventLike): number =>
  e.type === 'cancelAndHold' || e.type === 'cancelScheduledValues'
    ? (e.cancelTime ?? 0)
    : e.type === 'exponentialRampToValue' || e.type === 'linearRampToValue'
      ? (e.endTime ?? 0)
      : (e.startTime ?? 0);

/** Events kept before trimming kicks in (cheap to scan, plenty for value continuity). */
const KEEP = 4;

const proto = AutomationEventList.prototype as unknown as ListInternals;
const originalFlush = proto.flush;
if (typeof originalFlush === 'function' && !(originalFlush as { patched?: boolean }).patched) {
  const flush = function (this: ListInternals, time: number): void {
    originalFlush.call(this, time);
    const events = this._automationEvents;
    if (!Array.isArray(events) || events.length <= KEEP) return;
    const last = events[events.length - 1]!;
    const lastTime = eventTime(last);
    // An event still lies ahead: the original flush has already trimmed everything it safely can.
    if (!(lastTime <= time)) return;
    originalFlush.call(this, lastTime - 1e-6);
  };
  (flush as { patched?: boolean }).patched = true;
  proto.flush = flush;
}

export {};
