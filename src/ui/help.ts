import type { ActionGesture, Settings } from '../types';
import { ACTION_GESTURES } from '../settings';
import { ACTION_LABEL, GESTURE_GLYPH } from '../gestures';
import { h, setClass, uid } from './dom';
import { icon } from './icons';
import { DEGREE_FINGERS, DEGREE_PATTERNS, STYLES, fingerIcon, romanFor } from './chords';

const GESTURE_NAME: Record<ActionGesture, string> = {
  fist: 'Fist',
  peace: 'Peace sign',
  'thumbs-up': 'Thumbs up',
  rock: 'Rock on',
};

/** Help overlay: gesture guide, bound gestures, tips and keyboard shortcuts. */
export function buildHelp(onClose: () => void): { el: HTMLElement; refresh: (s: Settings) => void } {
  const titleId = uid('help-title');
  const el = h('div', { class: 'help', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, hidden: true });
  const scrim = h('div', { class: 'help-scrim' });
  scrim.addEventListener('click', onClose);
  const close = h('button', { type: 'button', class: 'icon-btn help-close', 'aria-label': 'Close help' });
  close.append(icon('close'));
  close.addEventListener('click', onClose);

  const guide = h('ul', { class: 'help-guide' });
  const items: ReadonlyArray<[Parameters<typeof icon>[0], string, string]> = [
    ['hand', 'Right hand height = note', 'Point with your index finger. Higher is a higher note, always snapped to the scale. The lanes on the right show the notes.'],
    ['face', 'Open your mouth to play', 'Mouth trigger: open to sound, wider is louder, like a breath controller. Adjust Mouth sensitivity in Play.'],
    ['sliders', 'Left hand', 'Volume: height sets the loudness (theremin style). Bass: its height plays a bass line. Chords: raise 1–5 fingers for the chords I–V. Off: ignored.'],
    ['wave', 'Pinch or Hands mode', 'Pinch: touch thumb and index to sound a note. Hands: plays whenever a hand is up.'],
    ['loop', 'Loop yourself', 'Open the looper (top bar) or press 1–4: after a one-bar count-in, play one loop and it repeats. Layer up to four tracks, each with its own instrument; mute, solo, clear or undo any take.'],
  ];
  for (const [ic, t, d] of items) {
    const b = h('span', { class: 'help-ic' });
    b.append(icon(ic));
    guide.append(h('li', null, b, h('div', null, h('h3', { text: t }), h('p', { text: d }))));
  }

  const gestureList = h('ul', { class: 'help-gestures' });
  const gestureNote = h('p', { class: 'ctl-hint' });

  const tips = h('ul', { class: 'help-tips' });
  for (const [ic, t] of [
    ['sun', 'Light your face and hands from the front; avoid a bright window behind you.'],
    ['ruler', 'Sit about an arm’s length from the camera so both hands fit in the picture.'],
    ['frame', 'Watch the FRAME badge at the top: green means the picture is ideal.'],
  ] as const) {
    const b = h('span', { class: 'help-ic sm' });
    b.append(icon(ic));
    tips.append(h('li', null, b, h('span', { text: t })));
  }

  // Chords mode finger chart.
  const chart = h('ol', { class: 'help-chart' });
  DEGREE_PATTERNS.forEach((p, i) => {
    const li = h('li', null, h('span', { class: 'hc-roman', text: romanFor(i, undefined) }), h('span', { class: 'hc-text', text: DEGREE_FINGERS[i] }));
    li.prepend(fingerIcon(p));
    chart.append(li);
  });
  const styleList = h('ul', { class: 'help-styles' });
  for (const st of STYLES) styleList.append(h('li', null, h('kbd', { text: String(st.n) }), h('span', { text: st.label })));
  const chordsSec = h(
    'section',
    { class: 'help-chords' },
    h('h3', { class: 'sheet-sec-title', text: 'Chords mode' }),
    h('p', { class: 'help-p', text: 'Left hand: the finger pattern picks the chord of the key. Tilt the left wrist to swap major/minor.' }),
    chart,
    h('p', { class: 'help-p', text: 'Right hand: height sets the volume, raised fingers pick the style, tilt is the filter, thumb out drops an octave, a fist mutes.' }),
    styleList,
  );

  // For musicians: technique and studio features.
  const musician = h('ul', { class: 'help-musician' });
  for (const [t, d] of [
    ['Technique', 'Controls › Technique shows what matters for the instruments playing. Auto play style makes each one play like the real thing: guitars strum real chord shapes string by string, keys use the sustain pedal, strings, winds and voices glide.'],
    ['Guitars', 'Strum patterns (Single, Down-up, Folk, Pop, Reggae, Ballad), palm mute and voicings: guitar shapes, close, open, drop-2, spread.'],
    ['Arpeggiator', 'Chord play Arp: up, down, up-down, random, broken or Alberti, at 1/4 to 1/16-triplet, over one to three octaves.'],
    ['Bass and harmony', 'Bass lines under chords (root, root-fifth, octave, walking), a second voice on melodies (3rd above, 6th below, 5th above, octave) and humanize.'],
    ['Studio', 'Tuning (A4 = 415–466 Hz), transpose ±12, time signatures 4/4, 3/4, 6/8, 5/4, 7/8, swing, count-in, velocity curve, attack and release.'],
    ['Effects', 'Room, hall, plate or cathedral reverb, tempo-synced delay, chorus, 3-band EQ, compressor and stereo width. Double-click any studio slider to reset it.'],
  ] as const) {
    musician.append(h('li', null, h('span', { class: 'hm-name', text: t }), h('span', { class: 'hm-text', text: d })));
  }
  const musicianSec = h(
    'section',
    { class: 'help-musicians' },
    h('h3', { class: 'sheet-sec-title', text: 'For musicians' }),
    musician,
    h('p', { class: 'help-p', text: 'Try the presets in Controls › Lead: Folk Guitar, Reggae Skank, Jazz Keys, Waltz, Harp Rolls and Synthwave Arp.' }),
  );

  const keys = h('dl', { class: 'shortcuts' });
  for (const [k, d] of [
    ['R', 'Record / stop'],
    ['G', 'Beat on / off'],
    ['↑ ↓', 'Octave up / down'],
    ['T', 'Next trigger mode'],
    ['L', 'Next left-hand role'],
    ['H or ?', 'This help'],
    ['F', 'Fullscreen'],
    ['1 – 4', 'Record loop 1–4'],
    ['Backspace', 'Undo last loop take'],
    ['Esc', 'Close panels'],
  ] as const) {
    keys.append(h('div', null, h('dt', null, h('kbd', { text: k })), h('dd', { text: d })));
  }

  const panel = h(
    'div',
    { class: 'help-panel glass' },
    h('div', { class: 'help-head' }, h('h2', { id: titleId, text: 'How to play' }), close),
    h(
      'div',
      { class: 'help-body' },
      h('section', null, h('h3', { class: 'sheet-sec-title', text: 'Gesture guide' }), guide),
      h('section', null, h('h3', { class: 'sheet-sec-title', text: 'Hold a pose (½ s)' }), gestureList, gestureNote),
      chordsSec,
      musicianSec,
      h('section', null, h('h3', { class: 'sheet-sec-title', text: 'Tips' }), tips),
      h('section', { class: 'hide-touch' }, h('h3', { class: 'sheet-sec-title', text: 'Keyboard' }), keys),
    ),
  );
  el.append(scrim, panel);

  const refresh = (s: Settings): void => {
    gestureList.replaceChildren();
    for (const g of ACTION_GESTURES) {
      gestureList.append(
        h(
          'li',
          { class: s.gestures[g] === 'none' ? 'is-off' : null },
          h('span', { class: 'gesture-glyph', 'aria-hidden': 'true', text: GESTURE_GLYPH[g] }),
          h('span', { class: 'hg-name', text: GESTURE_NAME[g] }),
          h('span', { class: 'hg-action', text: ACTION_LABEL[s.gestures[g]] }),
        ),
      );
    }
    gestureNote.textContent =
      s.mode === 'chords'
        ? 'Paused in Chords mode: every finger pattern plays a chord.'
        : s.gesturesEnabled
          ? 'Change these in Controls › Gestures.'
          : 'Gesture actions are switched off. Turn them on in Controls › Gestures.';
    setClass(gestureList, 'is-dim', s.mode === 'chords' || !s.gesturesEnabled);
  };
  return { el, refresh };
}
