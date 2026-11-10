#!/usr/bin/env node
/**
 * Learn mode check: validates every song and drives the LearnController with synthetic lead
 * VoiceStates. No browser needed (Node 22.18+ strips the TypeScript types):
 *
 *   node dev/learn-check.mjs
 *
 * Per song: every note is in the song's scale and on a lane of its lane setup; a perfect run in
 * wait mode (tongued and legato) and in tempo mode scores 100 % and finishes; one held wrong note
 * is exactly one miss (and one in the first moments is forgiven); a silent tempo run misses every note; the song still lands when the
 * engine moves the lanes by an octave. Also checks the best-score store. Exits 1 on failure.
 */
import { SONGS } from '../src/learn/songs.ts';
import { laneNotes, laneSetup, scaleContains } from '../src/learn/setup.ts';
import { LearnController } from '../src/learn/coach.ts';

const FRAME = 1000 / 30;
let failures = 0;
const fail = (msg) => {
  failures++;
  console.log(`  FAIL ${msg}`);
};
const expect = (cond, msg) => (cond ? undefined : fail(msg));

/** Lanes top to bottom, as the engine returns them. */
function makeLanes(midis) {
  const asc = [...midis].sort((a, b) => a - b);
  const n = asc.length;
  return asc.reverse().map((midi, i) => ({ midi, note: `m${midi}`, y: 0.1 + ((i + 0.5) * 0.8) / n, h: 0.8 / n, isRoot: false }));
}

function voice(midi, gate, onset) {
  return { voice: 'lead', handId: 0, instrument: 'grand-piano', active: true, gate, midi, note: '', laneIndex: -1, velocity: gate ? 0.8 : 0, brightness: 0.5, onset };
}

/** Simple engine model: onset when the gate opens or the pitch changes with the gate open. */
class Player {
  constructor(ctl, lanes, t0 = 1000) {
    this.ctl = ctl;
    this.lanes = lanes;
    this.t = t0;
    this.prevGate = false;
    this.prevMidi = null;
    this.finished = false;
  }
  frame(midi, gate, n = 1) {
    for (let i = 0; i < n; i++) {
      const onset = gate && (!this.prevGate || this.prevMidi !== midi);
      this.prevGate = gate;
      this.prevMidi = midi;
      if (this.ctl.update(voice(midi, gate, onset), this.lanes, this.t)) this.finished = true;
      this.t += FRAME;
    }
  }
  idle(n = 1) {
    for (let i = 0; i < n; i++) {
      if (this.ctl.update(null, this.lanes, this.t)) this.finished = true;
      this.t += FRAME;
    }
  }
}

function waitPerfect(song, lanes, shift = 0) {
  const ctl = new LearnController();
  ctl.start(song, 'wait', 1000);
  const p = new Player(ctl, lanes, 1000);
  for (const n of song.notes) {
    p.frame(n.midi + shift, false, 3); // move there with the mouth closed
    p.frame(n.midi + shift, true, 6); // open: play it
  }
  return { st: ctl.state, finished: p.finished };
}

function waitLegato(song, lanes) {
  const ctl = new LearnController();
  ctl.start(song, 'wait', 1000);
  const p = new Player(ctl, lanes, 1000);
  const asc = lanes.map((l) => l.midi).sort((a, b) => a - b);
  let cur = song.notes[0].midi;
  p.frame(cur, false, 2);
  for (const n of song.notes) {
    if (n.midi === cur) {
      p.frame(cur, false, 1); // re-articulate a repeated note
    } else {
      // Slide through every lane in between with the gate open, one frame each.
      const a = asc.indexOf(cur);
      const b = asc.indexOf(n.midi);
      const step = b > a ? 1 : -1;
      for (let k = a + step; k !== b; k += step) p.frame(asc[k], true, 1);
    }
    cur = n.midi;
    p.frame(cur, true, 6);
  }
  return { st: ctl.state, finished: p.finished };
}

function waitOneWrong(song, lanes, at) {
  const ctl = new LearnController();
  ctl.start(song, 'wait', 1000);
  const p = new Player(ctl, lanes, 1000);
  song.notes.forEach((n, i) => {
    if (i === at) {
      const wrong = lanes.find((l) => l.midi !== n.midi).midi;
      p.frame(wrong, false, 2);
      p.frame(wrong, true, 10); // held ~330 ms: a real wrong note
      p.frame(wrong, false, 2);
    }
    p.frame(n.midi, false, 3);
    p.frame(n.midi, true, 6);
  });
  return { st: ctl.state, finished: p.finished };
}

function tempoRun(song, lanes, play, legato = false) {
  const ctl = new LearnController();
  const t0 = 1000;
  ctl.start(song, 'tempo', t0);
  const p = new Player(ctl, lanes, t0);
  const msPerBeat = 60000 / song.bpm;
  const firstAt = t0 + song.beatsPerBar * msPerBeat;
  let at = firstAt;
  const times = song.notes.map((n) => {
    const s = at;
    at += n.beats * msPerBeat;
    return [s, at];
  });
  const end = at + 500;
  while (p.t < end && !p.finished) {
    if (!play) {
      p.idle();
      continue;
    }
    // Index of the note sounding at time t (the mouth closes for the last frame of each note).
    const k = times.findIndex(([s, e]) => p.t >= s && p.t < e);
    if (k < 0) p.frame(song.notes[0].midi, false);
    else if (legato) {
      // Glide to the next pitch up to 250 ms early (in the second half of the note) with the gate
      // open; only repeated notes re-articulate.
      const next = song.notes[k + 1];
      const [s0, e0] = times[k];
      const early = next && p.t >= Math.max(e0 - 250, (s0 + e0) / 2) && next.midi !== song.notes[k].midi;
      const rearticulate = next && next.midi === song.notes[k].midi && p.t >= times[k][1] - FRAME * 1.5;
      p.frame(early ? next.midi : song.notes[k].midi, !rearticulate);
    } else p.frame(song.notes[k].midi, p.t < times[k][1] - FRAME * 1.5);
  }
  return { st: ctl.state, finished: p.finished };
}

for (const song of SONGS) {
  console.log(`${song.title} (${song.notes.length} notes, ${song.keyName}, ${song.scale})`);
  for (const n of song.notes) expect(scaleContains(song.key, song.scale, n.midi), `note ${n.midi} is not in ${song.scale} on ${song.key}`);
  const setup = laneSetup(song);
  const laneMidis = laneNotes(setup.key, setup.scale, setup.octave, setup.span);
  const lanes = makeLanes(laneMidis);
  for (const n of song.notes) expect(laneMidis.includes(n.midi), `note ${n.midi} is on no lane`);
  console.log(`  lanes: key ${setup.key} ${setup.scale} octave ${setup.octave} span ${setup.span} (${laneMidis[0]}..${laneMidis.at(-1)})`);

  const n = song.notes.length;
  let r = waitPerfect(song, lanes);
  expect(r.finished && r.st.done, 'wait perfect: not done');
  expect(r.st.hits === n && r.st.misses === 0 && r.st.accuracy === 1 && r.st.stars === 3, `wait perfect: hits ${r.st.hits} misses ${r.st.misses} acc ${r.st.accuracy}`);
  expect(r.st.bestStreak === n, `wait perfect: best streak ${r.st.bestStreak}`);
  console.log(`  wait perfect   hits ${r.st.hits}/${n} misses ${r.st.misses} accuracy ${(r.st.accuracy * 100).toFixed(0)}% stars ${r.st.stars}`);

  r = waitLegato(song, lanes);
  expect(r.finished && r.st.hits === n && r.st.misses === 0, `wait legato: hits ${r.st.hits} misses ${r.st.misses}`);
  console.log(`  wait legato    hits ${r.st.hits}/${n} misses ${r.st.misses} accuracy ${(r.st.accuracy * 100).toFixed(0)}%`);

  r = waitOneWrong(song, lanes, Math.min(5, n - 1)); // past the start grace
  expect(r.finished && r.st.hits === n && r.st.misses === 1, `one wrong: hits ${r.st.hits} misses ${r.st.misses}`);
  expect(Math.abs(r.st.accuracy - (n - 1) / n) < 1e-9, `one wrong: accuracy ${r.st.accuracy}`);
  console.log(`  one wrong note hits ${r.st.hits}/${n} misses ${r.st.misses} accuracy ${(r.st.accuracy * 100).toFixed(1)}%`);

  r = waitOneWrong(song, lanes, 0);
  expect(r.st.misses === 0, `wrong note during the start grace counted: misses ${r.st.misses}`);

  r = tempoRun(song, lanes, true);
  expect(r.finished && r.st.hits === n && r.st.misses === 0 && r.st.accuracy === 1, `tempo perfect: hits ${r.st.hits} misses ${r.st.misses}`);
  console.log(`  tempo perfect  hits ${r.st.hits}/${n} misses ${r.st.misses} accuracy ${(r.st.accuracy * 100).toFixed(0)}%`);

  r = tempoRun(song, lanes, true, true);
  expect(r.finished && r.st.hits === n && r.st.misses === 0, `tempo legato: hits ${r.st.hits} misses ${r.st.misses}`);
  console.log(`  tempo legato   hits ${r.st.hits}/${n} misses ${r.st.misses} accuracy ${(r.st.accuracy * 100).toFixed(0)}%`);

  r = tempoRun(song, lanes, false);
  expect(r.finished && r.st.hits === 0 && r.st.misses === n && r.st.stars === 0, `tempo silent: hits ${r.st.hits} misses ${r.st.misses}`);
  console.log(`  tempo silent   hits ${r.st.hits}/${n} misses ${r.st.misses}`);

  // The engine fitted the lanes an octave up (instrument range): the song follows.
  const up = makeLanes(laneMidis.map((m) => m + 12));
  r = waitPerfect(song, up, 12);
  expect(r.st.onLanes && r.finished && r.st.accuracy === 1, `octave-shifted lanes: onLanes ${r.st.onLanes} acc ${r.st.accuracy}`);
}

// Best-score store with an in-memory localStorage.
{
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  const { recordBest, loadBests, loadLearnMode, saveLearnMode } = await import('../src/learn/scores.ts');
  expect(recordBest('twinkle', { stars: 2, accuracy: 0.85, bestStreak: 10, mode: 'wait' }) === true, 'first best not stored');
  expect(recordBest('twinkle', { stars: 2, accuracy: 0.8, bestStreak: 20, mode: 'wait' }) === false, 'worse run replaced the best');
  expect(recordBest('twinkle', { stars: 3, accuracy: 0.97, bestStreak: 30, mode: 'tempo' }) === true, 'better run not stored');
  expect(loadBests().twinkle?.stars === 3, 'best not read back');
  saveLearnMode('tempo');
  expect(loadLearnMode() === 'tempo', 'mode not stored');
  mem.set('orchestrator.learn.v1', '{not json');
  expect(Object.keys(loadBests()).length === 0 && loadLearnMode() === 'wait', 'corrupt storage not tolerated');
  globalThis.localStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  expect(recordBest('x', { stars: 1, accuracy: 0.5, bestStreak: 1, mode: 'wait' }) === true && loadLearnMode() === 'wait', 'blocked storage threw');
  console.log('scores store ok');
}

console.log(failures ? `\n${failures} check(s) FAILED` : `\nall ${SONGS.length} songs pass`);
process.exit(failures ? 1 : 0);
