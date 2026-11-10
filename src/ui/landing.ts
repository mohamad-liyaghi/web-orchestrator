import type { AppError, LandingView } from '../types';
import { APP_NAME, FIRST_START_BYTES, formatMB } from '../config';
import { FAMILIES, SHOWCASE, familyMeta } from './catalog';
import { frag, h, prefersReducedMotion } from './dom';
import { buildErrorCard } from './errors';
import { icon, logoMark } from './icons';
import { heroPreviewSvg, stepHandSvg, stepLeftSvg, stepMouthSvg } from './illustrations';
import { LandingBackground } from './landingBg';

interface Cta {
  btn: HTMLButtonElement;
  label: HTMLSpanElement;
  glyph: HTMLSpanElement;
}

function makeCta(onStart: () => void, extraClass = ''): Cta {
  const glyph = h('span', { class: 'cta-icon' });
  glyph.append(icon('play'));
  const label = h('span', { class: 'cta-label', text: 'Start playing' });
  const btn = h('button', { class: `cta ${extraClass}`.trim(), type: 'button' }, glyph, label);
  btn.addEventListener('click', () => {
    if (!btn.disabled) onStart();
  });
  return { btn, label, glyph };
}

export function mountLanding(root: HTMLElement, opts: { onStart: () => void }): LandingView {
  const el = h('section', { class: 'landing', 'aria-label': `${APP_NAME}: start page` });
  const bgCanvas = h('canvas', { class: 'landing-bg', 'aria-hidden': 'true' });
  const glow = h('div', { class: 'landing-glow', 'aria-hidden': 'true' });
  const scroller = h('div', { class: 'landing-scroll' });
  el.append(glow, bgCanvas, scroller);

  // ---- Nav --------------------------------------------------------------------------------
  const brand = h('div', { class: 'brand' });
  brand.append(logoMark(), h('span', { class: 'brand-name', text: APP_NAME }));
  const navChip = h('span', { class: 'nav-chip' });
  navChip.append(icon('shield'), h('span', { text: 'On-device · nothing uploaded' }));
  scroller.append(h('header', { class: 'landing-nav' }, brand, navChip));

  // ---- Hero -------------------------------------------------------------------------------
  const hero = h('div', { class: 'hero' });
  const copy = h('div', { class: 'hero-copy' });
  const eyebrow = h('p', { class: 'hero-eyebrow' });
  eyebrow.append(h('span', { class: 'live-dot', 'aria-hidden': 'true' }), h('span', { text: 'Air instrument · 50+ voices · live in your browser' }));
  const title = h('h1', { class: 'hero-title' });
  title.append('Play music', h('br'), h('span', { class: 'grad-text', text: 'out of thin air.' }));
  const sub = h('p', {
    class: 'hero-sub',
    text: 'Raise your hands and play. Fingers pick the chord, height sets the volume, and a full orchestra follows, tracked live by your camera.',
  });
  const primary = makeCta(opts.onStart, 'cta-hero');
  const ctaNote = h('p', { class: 'cta-note' });
  ctaNote.append(icon('lock'), h('span', { text: `Camera stays on this device. Free, no sign-up. First start downloads about ${formatMB(FIRST_START_BYTES)}, then it opens from cache.` }));
  const ctaRow = h('div', { class: 'cta-row' }, primary.btn, ctaNote);
  const errorSlot = h('div', { class: 'error-slot', 'aria-live': 'assertive' });
  const stats = h('ul', { class: 'hero-stats', 'aria-label': 'Highlights' });
  for (const [k, v] of [
    ['50+', 'instruments'],
    ['11', 'families'],
    ['0', 'uploads'],
  ] as const) {
    stats.append(h('li', null, h('strong', { class: 'mono', text: k }), h('span', { text: v })));
  }
  copy.append(eyebrow, title, sub, ctaRow, errorSlot, stats);

  const visual = h('div', { class: 'hero-visual' });
  const card = h('div', { class: 'pv-card glass' });
  card.append(frag(heroPreviewSvg()));
  const pvTop = h('div', { class: 'pv-top' });
  pvTop.append(
    h('span', { class: 'pv-rec' }, h('span', { class: 'live-dot' }), h('span', { text: 'LIVE' })),
    h('span', { class: 'mono', text: '60 FPS · GPU' }),
  );
  card.prepend(pvTop);
  visual.append(card);
  hero.append(copy, visual);
  scroller.append(hero);

  // ---- How it works -----------------------------------------------------------------------
  const how = h('section', { class: 'section how', 'aria-labelledby': 'how-title' });
  how.append(
    h('p', { class: 'eyebrow', text: 'How it works' }),
    h('h2', { class: 'section-title', id: 'how-title', text: 'Three moves. No instrument to hold.' }),
  );
  const steps = h('ol', { class: 'steps' });
  const stepData: ReadonlyArray<[string, string, string]> = [
    [stepLeftSvg(), 'Left hand picks the chord', '1 to 5 fingers play chords I to V of the key; index + pinky is vi, add the thumb for vii°.'],
    [stepHandSvg(), 'Right hand shapes it', 'Raise it for louder, show fingers for 7th, add9, sus4 or an open voicing, tilt for a darker tone.'],
    [stepMouthSvg(), 'Switch to Melody', 'Fingertip height picks single notes on 50+ instruments; open your mouth to play, like a breath controller.'],
  ];
  stepData.forEach(([art, t, d], i) => {
    const li = h('li', { class: 'step glass' });
    const artBox = h('div', { class: 'step-art' });
    artBox.append(frag(art));
    li.append(artBox, h('span', { class: 'step-num mono', text: `0${i + 1}` }), h('h3', { text: t }), h('p', { text: d }));
    steps.append(li);
  });
  how.append(steps);
  scroller.append(how);

  // ---- Instruments ------------------------------------------------------------------------
  const inst = h('section', { class: 'section instruments', 'aria-labelledby': 'inst-title' });
  inst.append(
    h('p', { class: 'eyebrow', text: 'The orchestra' }),
    h('h2', { class: 'section-title', id: 'inst-title', text: 'Piano to opera choir, theremin to sitar.' }),
  );
  const famRow = h('ul', { class: 'family-row', 'aria-label': 'Instrument families' });
  for (const f of FAMILIES) {
    const li = h('li', { class: 'family-chip', style: `--c:${f.color}` });
    li.append(h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { text: f.label }));
    famRow.append(li);
  }
  inst.append(famRow);
  const half = Math.ceil(SHOWCASE.length / 2);
  const rows = [SHOWCASE.slice(0, half), SHOWCASE.slice(half)];
  const marquee = h('div', { class: 'marquee', 'aria-hidden': 'true' });
  rows.forEach((items, r) => {
    const track = h('div', { class: `marquee-track${r ? ' is-reverse' : ''}` });
    // Two copies so the loop is seamless (translate -50%).
    for (let copyIx = 0; copyIx < 2; copyIx++) {
      for (const it of items) {
        const m = familyMeta(it.family);
        const chip = h('span', { class: 'inst-chip', style: `--c:${m.color}` });
        chip.append(h('span', { class: 'dot' }), h('span', { class: 'inst-name', text: it.name }), h('span', { class: 'inst-fam mono', text: m.label }));
        track.append(chip);
      }
    }
    marquee.append(track);
  });
  inst.append(marquee);
  const srList = h('p', { class: 'sr-only', text: `Instruments include ${SHOWCASE.map((s) => s.name).join(', ')}.` });
  inst.append(srList);
  scroller.append(inst);

  // ---- Privacy + tips ---------------------------------------------------------------------
  const tips = h('section', { class: 'section tips', 'aria-labelledby': 'tips-title' });
  const privacy = h('div', { class: 'privacy glass' });
  const shield = h('span', { class: 'privacy-icon' });
  shield.append(icon('shield'));
  privacy.append(
    shield,
    h(
      'div',
      null,
      h('h2', { class: 'privacy-title', id: 'tips-title', text: 'Your camera never leaves this device.' }),
      h('p', { text: 'Hands and face are tracked inside your browser. No video, audio or images are uploaded, and nothing is stored unless you press record.' }),
      h(
        'ul',
        { class: 'privacy-facts' },
        h('li', { text: 'On-device tracking' }),
        h('li', { text: 'No account' }),
        h('li', { text: 'No cookies' }),
        h('li', { text: 'Free' }),
      ),
    ),
  );
  const tipList = h('ul', { class: 'tip-list' });
  for (const [ic, t, d] of [
    ['sun', 'Light from the front', 'Face a window or a lamp; avoid a bright window behind you.'],
    ['ruler', 'About an arm’s length away', 'Sit back so your hands have room to move up and down.'],
    ['frame', 'Both hands in frame', 'Keep your face and both hands visible to the camera.'],
  ] as const) {
    const li = h('li', { class: 'tip' });
    const b = h('span', { class: 'tip-icon' });
    b.append(icon(ic));
    li.append(b, h('div', null, h('h3', { text: t }), h('p', { text: d })));
    tipList.append(li);
  }
  tips.append(privacy, tipList);
  scroller.append(tips);

  // ---- Footer CTA -------------------------------------------------------------------------
  const secondary = makeCta(opts.onStart, 'cta-footer');
  const footer = h('footer', { class: 'landing-footer' });
  footer.append(
    h('h2', { class: 'footer-title', text: 'Ready when you are.' }),
    secondary.btn,
    h('p', { class: 'footer-note', text: 'Works best in Chrome, Edge or Safari on a laptop or a recent phone. Headphones avoid feedback.' }),
  );
  scroller.append(footer);

  root.append(el);

  // ---- Behaviour --------------------------------------------------------------------------
  const bg = new LandingBackground(bgCanvas);
  bg.start();
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) bg.setVisible(e.isIntersecting);
  });
  io.observe(hero);

  let hasError = false;
  let busy = false;
  let destroyed = false;
  const ctas = [primary, secondary];

  const applyCta = (label?: string): void => {
    for (const c of ctas) {
      c.btn.disabled = busy;
      c.btn.setAttribute('aria-busy', String(busy));
      c.glyph.replaceChildren(busy ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : icon(hasError ? 'refresh' : 'play'));
      c.label.textContent = busy ? label || 'Starting…' : hasError ? 'Try again' : 'Start playing';
    }
  };

  return {
    el,
    setBusy(b: boolean, label?: string) {
      busy = b;
      if (b) {
        hasError = false;
        errorSlot.replaceChildren();
      }
      applyCta(label);
    },
    showError(err: AppError) {
      hasError = true;
      busy = false;
      errorSlot.replaceChildren(buildErrorCard(err));
      applyCta();
      // Bring the explanation and the retry button into view.
      scroller.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      if (document.activeElement !== primary.btn) primary.btn.focus({ preventScroll: true });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      io.disconnect();
      el.classList.add('is-leaving');
      el.setAttribute('aria-hidden', 'true');
      el.inert = true;
      const finish = (): void => {
        bg.destroy();
        el.remove();
      };
      if (prefersReducedMotion()) finish();
      else window.setTimeout(finish, 620);
    },
  };
}
