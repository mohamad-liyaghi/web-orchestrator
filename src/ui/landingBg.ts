import { prefersReducedMotion } from './dom';

/**
 * Landing background: slow "aurora strings" (a handful of undulating waveforms) over a sparse
 * star field. ~30 fps, devicePixelRatio capped at 1.5, paused while the tab is hidden or the
 * hero is scrolled out of view. Static single frame with prefers-reduced-motion.
 */
export class LandingBackground {
  private readonly ctx: CanvasRenderingContext2D | null;
  private raf = 0;
  private last = 0;
  private t = 0;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private running = false;
  private visible = true;
  private grad: CanvasGradient | null = null;
  private readonly stars = new Float32Array(90 * 3);
  private readonly ro: ResizeObserver;
  private readonly reduced = prefersReducedMotion();

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d', { alpha: true });
    for (let i = 0; i < this.stars.length; i += 3) {
      this.stars[i] = Math.random();
      this.stars[i + 1] = Math.random();
      this.stars[i + 2] = Math.random();
    }
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  /** Pause when the animated area is off screen. */
  setVisible(v: boolean): void {
    this.visible = v;
    this.sync();
  }

  start(): void {
    this.running = true;
    this.resize();
    this.sync();
  }

  destroy(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.ro.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  private readonly onVisibility = (): void => this.sync();

  private sync(): void {
    const go = this.running && this.visible && !document.hidden && !this.reduced;
    if (go && !this.raf) {
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.tick);
    } else if (!go && this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  private resize(): void {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(1.5, window.devicePixelRatio || 1);
    this.w = Math.max(1, Math.round(r.width));
    this.h = Math.max(1, Math.round(r.height));
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    if (this.ctx) {
      const g = this.ctx.createLinearGradient(0, 0, this.w, 0);
      g.addColorStop(0, 'rgba(60, 242, 255, 0.0)');
      g.addColorStop(0.18, 'rgba(60, 242, 255, 0.55)');
      g.addColorStop(0.55, 'rgba(139, 92, 246, 0.55)');
      g.addColorStop(0.85, 'rgba(255, 61, 203, 0.5)');
      g.addColorStop(1, 'rgba(255, 61, 203, 0.0)');
      this.grad = g;
    }
    this.draw();
  }

  private readonly tick = (now: number): void => {
    this.raf = requestAnimationFrame(this.tick);
    const dt = now - this.last;
    if (dt < 30) return; // ~30 fps is plenty for slow motion
    this.last = now;
    this.t += Math.min(dt, 100) / 1000;
    this.draw();
  };

  private draw(): void {
    const ctx = this.ctx;
    if (!ctx || !this.grad) return;
    const { w, h, t } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Stars: tiny, twinkling slowly.
    ctx.fillStyle = '#cfe0ff';
    for (let i = 0; i < this.stars.length; i += 3) {
      const tw = 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(t * (0.4 + this.stars[i + 2]!) + i));
      ctx.globalAlpha = tw * (0.3 + this.stars[i + 2]! * 0.7);
      const s = 0.6 + this.stars[i + 2]! * 0.9;
      ctx.fillRect(this.stars[i]! * w, this.stars[i + 1]! * h, s, s);
    }

    // Strings: a few phase-shifted waveforms, like a live spectrum seen from the side.
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = this.grad;
    const strands = w < 700 ? 5 : 7;
    const step = w < 700 ? 14 : 10;
    const baseY = h * 0.62;
    for (let s = 0; s < strands; s++) {
      const k = s / (strands - 1);
      ctx.globalAlpha = 0.16 + 0.22 * (1 - Math.abs(k - 0.5) * 2);
      ctx.lineWidth = s === Math.floor(strands / 2) ? 1.6 : 1;
      ctx.beginPath();
      for (let x = -step; x <= w + step; x += step) {
        const u = x / w;
        const env = Math.sin(Math.PI * Math.min(1, Math.max(0, u))) ** 1.4;
        const y =
          baseY +
          (k - 0.5) * h * 0.16 +
          env *
            (Math.sin(u * 7.5 + t * 0.55 + s * 0.6) * h * 0.06 +
              Math.sin(u * 15 - t * 0.9 + s * 1.3) * h * 0.022 +
              Math.sin(u * 3 + t * 0.25) * h * 0.04);
        if (x === -step) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }
}
