/**
 * Static SVG illustrations for the landing page (generated from constants, no runtime input).
 * Every call gets fresh gradient ids so two copies can coexist while one animates out.
 */
import { uid } from './dom';

/** MediaPipe hand topology. */
export const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];

/** Open right hand, palm to camera, units of hand height, wrist at the origin. */
const HAND: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [-0.12, -0.08], [-0.22, -0.18], [-0.3, -0.28], [-0.36, -0.38],
  [-0.08, -0.42], [-0.09, -0.58], [-0.1, -0.7], [-0.1, -0.8],
  [0.02, -0.44], [0.02, -0.62], [0.02, -0.75], [0.02, -0.86],
  [0.11, -0.41], [0.12, -0.57], [0.13, -0.68], [0.13, -0.77],
  [0.19, -0.35], [0.21, -0.47], [0.22, -0.56], [0.23, -0.64],
];

const f = (n: number): string => n.toFixed(1);

/** Hand skeleton with its index tip at (tx, ty). `mirror` draws a left hand. */
function handSkeleton(tx: number, ty: number, scale: number, stroke: string, mirror = false, joint = 2.4): string {
  const [ix, iy] = HAND[8]!;
  const s = mirror ? -1 : 1;
  const pts = HAND.map(([x, y]) => [tx + (x - ix) * scale * s, ty + (y - iy) * scale] as const);
  const lines = HAND_CONNECTIONS.map(([a, b]) => `M${f(pts[a]![0])} ${f(pts[a]![1])}L${f(pts[b]![0])} ${f(pts[b]![1])}`).join('');
  const dots = pts.map(([x, y], i) => `<circle cx="${f(x)}" cy="${f(y)}" r="${i % 4 === 0 && i ? joint * 1.15 : joint}"/>`).join('');
  return `<path d="${lines}" stroke="${stroke}" stroke-width="1.6" stroke-linecap="round" fill="none" opacity=".75"/><g fill="#eef1ff" opacity=".9">${dots}</g>`;
}

function brackets(x: number, y: number, w: number, h: number, len: number, stroke: string, sw = 2.2): string {
  const d = [
    `M${x} ${y + len}V${y}H${x + len}`,
    `M${x + w - len} ${y}H${x + w}V${y + len}`,
    `M${x + w} ${y + h - len}V${y + h}H${x + w - len}`,
    `M${x + len} ${y + h}H${x}V${y + h - len}`,
  ].join('');
  return `<path d="${d}" stroke="${stroke}" stroke-width="${sw}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
}

/** The hero "live HUD" preview card. */
export function heroPreviewSvg(): string {
  const g = uid('pv');
  const lanes = ['E5', 'D5', 'C5', 'A4', 'G4', 'E4', 'D4', 'C4', 'A3'];
  const top = 58;
  const gap = 38;
  const active = 5;
  const lanesSvg = lanes
    .map((n, i) => {
      const y = top + i * gap;
      const root = n.startsWith('C');
      return `<line x1="22" x2="392" y1="${y}" y2="${y}" stroke="rgba(200,215,255,${root ? 0.26 : 0.11})" stroke-dasharray="${root ? '0' : '2 6'}"/><text x="418" y="${y + 4}" text-anchor="end" class="pv-lane${root ? ' is-root' : ''}">${n}</text>`;
    })
    .join('');
  const tipX = 248;
  const tipY = top + active * gap;
  const S = 150;
  const bx = 196;
  const by = tipY - 14;
  const bw = 120;
  const bh = 150;
  return `<svg class="pv-svg" viewBox="0 0 440 470" role="img" aria-label="Preview of the live HUD: a bracket square tracks the hand, the fingertip picks the note E4 on the grand piano.">
<defs>
  <linearGradient id="${g}-a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3cf2ff"/><stop offset=".55" stop-color="#8b5cf6"/><stop offset="1" stop-color="#ff3dcb"/></linearGradient>
  <linearGradient id="${g}-band" x1="0" x2="1"><stop offset="0" stop-color="#3cf2ff" stop-opacity="0"/><stop offset=".55" stop-color="#3cf2ff" stop-opacity=".16"/><stop offset="1" stop-color="#3cf2ff" stop-opacity=".34"/></linearGradient>
  <radialGradient id="${g}-glow"><stop offset="0" stop-color="#3cf2ff" stop-opacity=".9"/><stop offset=".4" stop-color="#3cf2ff" stop-opacity=".25"/><stop offset="1" stop-color="#3cf2ff" stop-opacity="0"/></radialGradient>
  <radialGradient id="${g}-person" cx=".5" cy=".42" r=".6"><stop offset="0" stop-color="#1b2140"/><stop offset="1" stop-color="#05060a" stop-opacity="0"/></radialGradient>
</defs>
<rect x="0" y="0" width="440" height="470" rx="22" fill="url(#${g}-person)"/>
<g class="pv-lanes">${lanesSvg}</g>
<g class="pv-float">
  <rect x="22" y="${tipY - gap / 2}" width="370" height="${gap}" fill="url(#${g}-band)"/>
  <line x1="22" x2="392" y1="${tipY}" y2="${tipY}" stroke="#3cf2ff" stroke-opacity=".7"/>
  ${handSkeleton(tipX, tipY, S, 'url(#' + g + '-a)')}
  ${brackets(bx, by, bw, bh, 18, '#3cf2ff')}
  <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="none" stroke="#3cf2ff" stroke-opacity=".14"/>
  <g transform="translate(${bx} ${by - 30})"><rect width="176" height="22" rx="6" fill="rgba(5,6,10,.78)" stroke="#3cf2ff" stroke-opacity=".5"/><text x="9" y="15" class="pv-chip"><tspan class="pv-chip-role">LEAD</tspan> · Grand Piano · E4</text></g>
  <circle cx="${tipX}" cy="${tipY}" r="26" fill="url(#${g}-glow)"/>
  <circle class="pv-pulse" cx="${tipX}" cy="${tipY}" r="11" fill="none" stroke="#3cf2ff" stroke-width="1.5"/>
  <circle cx="${tipX}" cy="${tipY}" r="11" fill="none" stroke="#eef1ff" stroke-width="1.5"/>
  <path d="M${tipX - 19} ${tipY}h6M${tipX + 13} ${tipY}h6M${tipX} ${tipY - 19}v6M${tipX} ${tipY + 13}v6" stroke="#eef1ff" stroke-width="1.5" stroke-linecap="round"/>
</g>
<g transform="translate(22 404)">
  <rect width="396" height="48" rx="12" fill="rgba(5,6,10,.7)" stroke="rgba(190,205,255,.14)"/>
  <text x="14" y="19" class="pv-k">KEY</text><text x="14" y="38" class="pv-v">C <tspan class="pv-s">maj pent</tspan></text>
  <line x1="120" x2="120" y1="10" y2="38" stroke="rgba(190,205,255,.14)"/>
  <text x="134" y="19" class="pv-k">CHORD</text><text x="134" y="38" class="pv-v">Am <tspan class="pv-s">vi</tspan></text>
  <line x1="214" x2="214" y1="10" y2="38" stroke="rgba(190,205,255,.14)"/>
  <text x="228" y="19" class="pv-k">VOL</text>
  <g transform="translate(228 28)">${Array.from({ length: 12 }, (_, i) => `<rect x="${i * 6}" y="0" width="4" height="10" rx="1" fill="${i < 8 ? (i < 6 ? '#3cf2ff' : '#8b5cf6') : 'rgba(190,205,255,.16)'}"/>`).join('')}</g>
  <line x1="318" x2="318" y1="10" y2="38" stroke="rgba(190,205,255,.14)"/>
  <text x="332" y="19" class="pv-k">BPM</text><text x="332" y="38" class="pv-v">96 <tspan class="pv-s">3:2</tspan></text>
</g>
</svg>`;
}

/** Step 1: fingertip height picks the note. */
export function stepHandSvg(): string {
  const g = uid('s1');
  const notes = ['G4', 'E4', 'D4', 'C4'];
  const rows = notes
    .map((n, i) => {
      const y = 18 + i * 20;
      return `<line x1="14" x2="118" y1="${y}" y2="${y}" stroke="rgba(200,215,255,${i === 1 ? 0.0 : 0.16})" stroke-dasharray="2 5"/><text x="150" y="${y + 3.5}" text-anchor="end" class="st-note${i === 1 ? ' is-on' : ''}">${n}</text>`;
    })
    .join('');
  return `<svg viewBox="0 0 160 96" aria-hidden="true"><defs><linearGradient id="${g}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3cf2ff"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs>
${rows}<rect x="14" y="30" width="112" height="16" rx="3" fill="#3cf2ff" opacity=".12"/><line x1="14" x2="126" y1="38" y2="38" stroke="#3cf2ff" stroke-opacity=".8"/>
${handSkeleton(70, 38, 62, 'url(#' + g + ')', false, 1.6)}
<circle cx="70" cy="38" r="7" fill="none" stroke="#eef1ff" stroke-width="1.3"/>
<path d="M40 22v-10m-4 4 4-4 4 4M40 58v10m-4-4 4 4 4-4" stroke="#3cf2ff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity=".8"/></svg>`;
}

/** Step 2: open mouth = gate, wider = louder. */
export function stepMouthSvg(): string {
  const g = uid('s2');
  return `<svg viewBox="0 0 160 96" aria-hidden="true"><defs><linearGradient id="${g}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#8b5cf6"/><stop offset="1" stop-color="#ff3dcb"/></linearGradient></defs>
<path d="M22 48c10-16 22-22 36-22 6 0 9 3 12 3s6-3 12-3c14 0 26 6 36 22-10 18-26 26-48 26S32 66 22 48Z" fill="none" stroke="url(#${g})" stroke-width="2"/>
<path d="M34 48c10-8 22-11 36-11s26 3 36 11c-10 12-22 17-36 17s-26-5-36-17Z" fill="#ff3dcb" fill-opacity=".12" stroke="#ff3dcb" stroke-opacity=".55" stroke-width="1.2"/>
<path d="M128 36a16 16 0 0 1 0 24M136 30a26 26 0 0 1 0 36M144 24a36 36 0 0 1 0 48" fill="none" stroke="#ff3dcb" stroke-width="1.5" stroke-linecap="round" opacity=".7"/>
<g transform="translate(14 84)"><rect width="100" height="4" rx="2" fill="rgba(200,215,255,.14)"/><rect width="68" height="4" rx="2" fill="url(#${g})"/><rect x="22" y="-3" width="1.5" height="10" fill="#eef1ff" opacity=".7"/></g></svg>`;
}

/** Step 3: the left hand adds volume, bass or chords. */
export function stepLeftSvg(): string {
  const g = uid('s3');
  return `<svg viewBox="0 0 160 96" aria-hidden="true"><defs><linearGradient id="${g}" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#3cf2ff" stop-opacity=".2"/><stop offset="1" stop-color="#3cf2ff"/></linearGradient></defs>
<rect x="12" y="14" width="6" height="68" rx="3" fill="rgba(200,215,255,.12)"/><rect x="12" y="34" width="6" height="48" rx="3" fill="url(#${g})"/>
${handSkeleton(46, 30, 54, '#3cf2ff', true, 1.4)}
${handSkeleton(116, 40, 54, '#ff8a5c', false, 1.4)}
<g transform="translate(78 4)"><rect width="38" height="16" rx="5" fill="rgba(5,6,10,.7)" stroke="#ff8a5c" stroke-opacity=".6"/><text x="19" y="11.5" text-anchor="middle" class="st-chip">Am</text></g></svg>`;
}
