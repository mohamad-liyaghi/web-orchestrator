/**
 * Learn mode public API: guided public-domain songs played on the lead voice.
 *
 * app.ts owns one LearnSession: `start()` returns the settings patch for the song (applied like a
 * control change), `update()` runs on every tracking frame, `state` goes to the stage each
 * animation frame, `songs()` feeds StageView.setSongs.
 */
import type { Lane, LearnMode, LearnState, Settings, SongInfo, VoiceState } from '../types';
import { LearnController } from './coach';
import { learnPatch } from './setup';
import { SONGS, findSong } from './songs';
import { loadBests, recordBest, saveLearnMode } from './scores';

export { loadLearnMode, saveLearnMode } from './scores';

export class LearnSession {
  private readonly ctl = new LearnController();

  constructor(private readonly instrumentIds: readonly string[]) {}

  get state(): LearnState | null {
    return this.ctl.state;
  }

  songs(): SongInfo[] {
    const bests = loadBests();
    return SONGS.map((s) => ({
      id: s.id,
      title: s.title,
      credit: s.credit,
      difficulty: s.difficulty,
      length: s.notes.length,
      bpm: s.bpm,
      keyName: s.keyName,
      best: bests[s.id] ?? null,
    }));
  }

  /**
   * Starts (or restarts) a song. Returns the settings patch to apply (lanes, tempo and the song's
   * time signature), null for an unknown id. `countIn` false starts tempo mode without the bar of
   * count-in (Settings.countIn).
   */
  start(songId: string, mode: LearnMode = 'wait', countIn = true): Partial<Settings> | null {
    const song = findSong(songId);
    if (!song) return null;
    saveLearnMode(mode);
    this.ctl.start(song, mode, performance.now(), countIn);
    return learnPatch(song, this.instrumentIds);
  }

  stop(): void {
    this.ctl.stop();
  }

  /**
   * One tracking frame. Pass the lead voice (null to skip judging, e.g. in chords mode) and the
   * lead lanes. Returns true when a finished run set a new best (refresh the song list).
   */
  update(lead: VoiceState | null, lanes: readonly Lane[], t: number): boolean {
    if (!this.ctl.update(lead, lanes, t)) return false;
    const st = this.ctl.state!;
    if (st.stars < 1) return false;
    st.newBest = recordBest(st.songId, { stars: st.stars, accuracy: st.accuracy, bestStreak: st.bestStreak, mode: st.mode });
    return st.newBest;
  }
}
