import type { AppError, AppErrorCode } from '../types';
import { h } from './dom';
import { icon } from './icons';

type Platform = 'chrome' | 'safari' | 'ios' | 'android' | 'firefox' | 'other';

function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Edg\/|Chrome\//.test(ua)) return 'chrome';
  if (/Safari\//.test(ua)) return 'safari';
  return 'other';
}

interface ErrorCopy {
  title: string;
  body: string;
  steps?: ReadonlyArray<{ platform: Platform; label: string; text: string }>;
  hints?: readonly string[];
  /** Shown as a link button (insecure context). */
  link?: { href: string; label: string };
}

function secureUrl(): string | null {
  if (location.protocol !== 'http:') return null;
  return `https://${location.host}${location.pathname}${location.search}${location.hash}`;
}

export function errorCopy(code: AppErrorCode): ErrorCopy {
  switch (code) {
    case 'camera-denied':
      return {
        title: 'Camera access is blocked',
        body: 'Orchestrator needs your camera to see your hands. The picture is processed on this device and never uploaded.',
        steps: [
          { platform: 'chrome', label: 'Chrome / Edge', text: 'Click the camera or tune icon at the left of the address bar, set Camera to Allow, then press Try again.' },
          { platform: 'safari', label: 'Safari (Mac)', text: 'Safari › Settings for this website › Camera › Allow, then press Try again.' },
          { platform: 'ios', label: 'iPhone / iPad', text: 'Tap “aA” in the address bar › Website Settings › Camera › Allow. Also check Settings › Safari › Camera.' },
          { platform: 'android', label: 'Android Chrome', text: 'Tap the tune icon next to the address › Permissions › Camera › Allow. Also check Android Settings › Apps › Chrome › Permissions.' },
          { platform: 'firefox', label: 'Firefox', text: 'Click the crossed-out camera icon in the address bar, remove the block, then press Try again.' },
        ],
      };
    case 'insecure-context': {
      const href = secureUrl();
      return {
        title: 'This page needs a secure link',
        body: 'Browsers only allow the camera on pages served over https. Open the secure address and start again.',
        link: href ? { href, label: 'Open the https link' } : undefined,
      };
    }
    case 'no-camera-api':
      return {
        title: 'This browser can’t use the camera',
        body: 'Open Orchestrator in an up-to-date Chrome, Safari, Edge or Firefox.',
        hints: ['In-app browsers (social apps, mail apps) often block the camera: use “Open in browser”.'],
      };
    case 'camera-not-found':
      return {
        title: 'No camera found',
        body: 'Connect a webcam or enable the built-in one, then try again.',
        hints: ['Some laptops have a privacy switch or a function key that turns the camera off.'],
      };
    case 'camera-in-use':
      return {
        title: 'Your camera is busy',
        body: 'Another app or tab is using the camera right now.',
        hints: ['Close video calls, other camera apps and other Orchestrator tabs, then press Try again.'],
      };
    case 'model-load-failed':
      return {
        title: 'The hand tracker couldn’t load',
        body: 'The tracking models failed to download or start. Check your connection and try again.',
        hints: ['If it keeps failing, reload the page. Very old devices may not support on-device tracking.'],
      };
    case 'audio-failed':
      return {
        title: 'Audio couldn’t start',
        body: 'The browser refused to start sound. Press Try again (a tap or click is needed to start audio).',
        hints: ['On iPhone, also check the silent switch and the volume.'],
      };
    default:
      return {
        title: 'Something went wrong',
        body: 'Orchestrator hit an unexpected problem while starting. Try again, or reload the page.',
      };
  }
}

/** Glass error card used on the landing page and on the stage. */
export function buildErrorCard(err: AppError): HTMLElement {
  const copy = errorCopy(err.code);
  const platform = detectPlatform();
  const card = h('div', { class: 'error-card glass', role: 'alert', 'data-code': err.code });
  const head = h('div', { class: 'error-head' });
  const badge = h('span', { class: 'error-badge' });
  badge.append(icon(err.code === 'insecure-context' ? 'lock' : err.code.startsWith('camera') ? 'camera' : 'alert'));
  head.append(badge, h('div', null, h('h2', { class: 'error-title', text: copy.title }), h('p', { class: 'error-body', text: copy.body })));
  card.append(head);

  if (copy.steps) {
    // The visitor's own browser first, highlighted.
    const steps = [...copy.steps].sort((a, b) => Number(b.platform === platform) - Number(a.platform === platform));
    const list = h('ul', { class: 'error-steps' });
    for (const s of steps) {
      const li = h('li', { class: s.platform === platform ? 'is-you' : null });
      li.append(h('span', { class: 'error-step-label', text: s.label }), h('span', { text: s.text }));
      list.append(li);
    }
    card.append(list);
  }
  if (copy.hints) {
    const list = h('ul', { class: 'error-hints' });
    for (const t of copy.hints) list.append(h('li', { text: t }));
    card.append(list);
  }
  if (copy.link) {
    const a = h('a', { class: 'btn error-link', href: copy.link.href });
    a.append(icon('lock'), copy.link.label);
    card.append(a);
  }
  if (err.message) card.append(h('p', { class: 'error-detail mono', text: `${err.code} · ${err.message}` }));
  return card;
}
