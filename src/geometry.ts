import type { Box, PlayZone, Vec2 } from './types';

/**
 * Maps normalized camera-frame coordinates to viewport pixels for a <video> shown with
 * `object-fit: cover`. The view is center-cropped, so mirroring does not change the math:
 * points from the tracker are already mirrored.
 */
export interface CoverMap {
  /** Video pixels -> CSS pixels. */
  scale: number;
  /** CSS pixel offset of the video's left/top edge (<= 0 when cropped). */
  offsetX: number;
  offsetY: number;
  videoW: number;
  videoH: number;
  viewW: number;
  viewH: number;
}

export function coverMap(videoW: number, videoH: number, viewW: number, viewH: number): CoverMap {
  const vw = Math.max(1, videoW);
  const vh = Math.max(1, videoH);
  const scale = Math.max(viewW / vw, viewH / vh);
  return {
    scale,
    offsetX: (viewW - vw * scale) / 2,
    offsetY: (viewH - vh * scale) / 2,
    videoW: vw,
    videoH: vh,
    viewW,
    viewH,
  };
}

export function toScreen(m: CoverMap, p: Vec2): Vec2 {
  return { x: p.x * m.videoW * m.scale + m.offsetX, y: p.y * m.videoH * m.scale + m.offsetY };
}

export function boxToScreen(m: CoverMap, b: Box): Box {
  const s = m.videoW * m.scale;
  const t = m.videoH * m.scale;
  return { x: b.x * s + m.offsetX, y: b.y * t + m.offsetY, w: b.w * s, h: b.h * t };
}

/** Viewport y (CSS px) -> normalized camera-frame y. */
export function screenYToFrame(m: CoverMap, y: number): number {
  return (y - m.offsetY) / (m.videoH * m.scale);
}

/** The part of the camera frame that is visible in the viewport, normalized. */
export function visibleRegion(m: CoverMap): Box {
  const x0 = Math.max(0, -m.offsetX / (m.videoW * m.scale));
  const y0 = Math.max(0, -m.offsetY / (m.videoH * m.scale));
  return { x: x0, y: y0, w: 1 - 2 * x0, h: 1 - 2 * y0 };
}

/**
 * Play zone = visible vertical range of the frame, inset so the top and bottom notes are
 * reachable without the hand leaving the picture (topInset/bottomInset are fractions of the
 * visible height).
 */
export function playZoneFor(m: CoverMap, topInset = 0.1, bottomInset = 0.14): PlayZone {
  const v = visibleRegion(m);
  return { y0: v.y + v.h * topInset, y1: v.y + v.h * (1 - bottomInset) };
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
