import type { LearnBest, LearnMode } from '../types';

/**
 * Learn mode persistence: best result per song and the last chosen mode. localStorage may be
 * missing or throw (private mode, blocked storage): everything still works, it just won't persist.
 */

const KEY = 'orchestrator.learn.v1';

interface Stored {
  mode: LearnMode;
  best: Record<string, LearnBest>;
}

function read(): Stored {
  const empty: Stored = { mode: 'wait', best: {} };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty;
    const v = JSON.parse(raw) as Partial<Stored> | null;
    const best: Record<string, LearnBest> = {};
    if (v && typeof v.best === 'object' && v.best) {
      for (const [id, b] of Object.entries(v.best)) {
        if (!b || typeof b !== 'object') continue;
        const { stars, accuracy, bestStreak, mode } = b as Partial<LearnBest>;
        if (typeof stars !== 'number' || typeof accuracy !== 'number') continue;
        best[id] = {
          stars: Math.max(0, Math.min(3, Math.round(stars))),
          accuracy: Math.max(0, Math.min(1, accuracy)),
          bestStreak: typeof bestStreak === 'number' ? Math.max(0, Math.round(bestStreak)) : 0,
          mode: mode === 'tempo' ? 'tempo' : 'wait',
        };
      }
    }
    return { mode: v?.mode === 'tempo' ? 'tempo' : 'wait', best };
  } catch {
    return empty;
  }
}

function write(s: Stored): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage blocked: scores just won't persist */
  }
}

export function loadBests(): Record<string, LearnBest> {
  return read().best;
}

export function loadLearnMode(): LearnMode {
  return read().mode;
}

export function saveLearnMode(mode: LearnMode): void {
  const s = read();
  if (s.mode === mode) return;
  s.mode = mode;
  write(s);
}

const better = (a: LearnBest, b: LearnBest | undefined): boolean =>
  !b || a.stars > b.stars || (a.stars === b.stars && (a.accuracy > b.accuracy || (a.accuracy === b.accuracy && a.bestStreak > b.bestStreak)));

/** Stores `result` when it beats the stored best for the song. Returns true when it did. */
export function recordBest(songId: string, result: LearnBest): boolean {
  const s = read();
  if (!better(result, s.best[songId])) return false;
  s.best[songId] = result;
  write(s);
  return true;
}
