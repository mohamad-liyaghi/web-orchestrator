import type { ActionGesture, Settings } from '../types';
import { ACTION_GESTURES } from '../settings';
import { ACTION_LABEL, GESTURE_GLYPH } from '../gestures';
import { h, uid } from './dom';
import { icon } from './icons';

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

  const keys = h('dl', { class: 'shortcuts' });
  for (const [k, d] of [
    ['R', 'Record / stop'],
    ['G', 'Beat on / off'],
    ['↑ ↓', 'Octave up / down'],
    ['T', 'Next trigger mode'],
    ['L', 'Next left-hand role'],
    ['H or ?', 'This help'],
    ['F', 'Fullscreen'],
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
    gestureNote.textContent = s.gesturesEnabled
      ? 'Change these in Controls › Gestures.'
      : 'Gesture actions are switched off. Turn them on in Controls › Gestures.';
  };
  return { el, refresh };
}
