/** Inline SVG icons (24px grid, stroke = currentColor). Static markup shipped with the app. */
import { frag } from './dom';

const svg = (body: string, extra = ''): string =>
  `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"${extra}>${body}</svg>`;

let uid = 0;
/** Logo mark with its own gradient id (ids must be unique per document). */
export function logoMark(): DocumentFragment {
  const id = `lg-logo-${++uid}`;
  return frag(
    `<svg class="logo-mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3cf2ff"/><stop offset=".55" stop-color="#8b5cf6"/><stop offset="1" stop-color="#ff3dcb"/></linearGradient></defs><rect x="1" y="1" width="30" height="30" rx="9" fill="rgba(255,255,255,.04)" stroke="url(#${id})" stroke-opacity=".6"/><path d="M7 20c3-7 5-7 7 0s4 7 6 0 3-6 5-3" fill="none" stroke="url(#${id})" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  );
}

export const ICONS = {
  play: svg('<path d="M7 5.5v13a.8.8 0 0 0 1.2.7l10.4-6.5a.8.8 0 0 0 0-1.4L8.2 4.8A.8.8 0 0 0 7 5.5Z" fill="currentColor" stroke="none"/>'),
  settings: svg('<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>'),
  exit: svg('<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="M10 8l-4 4 4 4M6 12h10"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  minus: svg('<path d="M6 12h12"/>'),
  plus: svg('<path d="M12 6v12M6 12h12"/>'),
  chevronUp: svg('<path d="m6 15 6-6 6 6"/>'),
  hand: svg('<path d="M8 13V6.5a1.5 1.5 0 0 1 3 0V12M11 11.5V4.5a1.5 1.5 0 0 1 3 0V12M14 11.5V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-.6a6 6 0 0 1-4.6-2.2L3.6 15a1.5 1.5 0 0 1 2.3-1.9L8 15"/>'),
  face: svg('<circle cx="12" cy="12" r="8.5"/><path d="M9 10h.01M15 10h.01"/><path d="M9.5 15a3.5 2 0 0 0 5 0"/>'),
  camera: svg('<path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><circle cx="12" cy="12.5" r="3.5"/>'),
  shield: svg('<path d="M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6Z"/><path d="m9 12 2 2 4-4"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>'),
  ruler: svg('<path d="M4 12h16M4 9v6M20 9v6"/><path d="M8 12V10.5M12 12v-2.5M16 12v-1.5"/>'),
  frame: svg('<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M9 14.5V10M12 14.5V9M15 14.5V10.5"/>'),
  alert: svg('<path d="M12 3.5 2.8 19.5h18.4Z"/><path d="M12 10v4M12 17h.01"/>'),
  refresh: svg('<path d="M20 11a8 8 0 0 0-14.3-4.5L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.5L20 16"/><path d="M20 20v-4h-4"/>'),
  lock: svg('<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>'),
  music: svg('<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>'),
  wave: svg('<path d="M3 12h2l2-6 3 12 3-9 2 5 2-2h4"/>'),
  sliders: svg('<path d="M6 4v16M12 4v16M18 4v16"/><rect x="4" y="13" width="4" height="3" rx="1"/><rect x="10" y="7" width="4" height="3" rx="1"/><rect x="16" y="15" width="4" height="3" rx="1"/>'),
  eye: svg('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>'),
  keyboard: svg('<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M9 10h.01M12 10h.01M15 10h.01M18 10h.01M7 14h10"/>'),
  record: svg('<circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"/>'),
  stop: svg('<rect x="7.5" y="7.5" width="9" height="9" rx="1.5" fill="currentColor" stroke="none"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  share: svg('<path d="M12 15V4M8 8l4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7a1 1 0 0 0-1-1h-1"/>'),
  expand: svg('<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>'),
  shrink: svg('<path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5"/>'),
  help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.8M12 17h.01"/>'),
  gesture: svg('<path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V10M12 9.5V4.5a1.5 1.5 0 0 1 3 0V11"/><path d="M15 10.5a1.5 1.5 0 0 1 3 0v3.5a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-2.7L4 14.6a1.5 1.5 0 0 1 2.5-1.6L9 15"/>'),
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName): DocumentFragment {
  return frag(ICONS[name]);
}
