/**
 * Mobile audio unlock helpers.
 *
 * iOS routes Web Audio through the "ambient" session, which the hardware mute switch silences.
 * Asking for the 'playback' session (Safari 16.4+) or, on older versions, playing a silent
 * looping <audio> element from the user gesture moves the page to the playback category.
 */

interface AudioSessionLike {
  type: string;
}

/** A 0.5 s silent mono 8 kHz WAV as a blob URL. */
function silentWavUrl(): string {
  const samples = 4000;
  const buf = new ArrayBuffer(44 + samples);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, 8000, true);
  v.setUint32(28, 8000, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true); // 8-bit
  str(36, 'data');
  v.setUint32(40, samples, true);
  for (let i = 0; i < samples; i++) v.setUint8(44 + i, 128); // 8-bit silence is 128
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

const isIOS = (): boolean =>
  /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export class MobileAudioUnlock {
  private el: HTMLAudioElement | null = null;
  private url = '';

  /** Must run synchronously inside a user gesture. */
  engage(): void {
    const session = (navigator as Navigator & { audioSession?: AudioSessionLike }).audioSession;
    if (session) {
      try {
        session.type = 'playback';
      } catch {
        /* read-only in some versions */
      }
    }
    if (!isIOS() || session) return;
    if (!this.el) {
      this.url = silentWavUrl();
      const el = document.createElement('audio');
      el.src = this.url;
      el.loop = true;
      el.preload = 'auto';
      el.setAttribute('playsinline', '');
      el.setAttribute('x-webkit-airplay', 'deny');
      this.el = el;
    }
    this.el.play().catch(() => undefined);
  }

  dispose(): void {
    if (this.el) {
      this.el.pause();
      this.el.removeAttribute('src');
      this.el.load();
      this.el = null;
    }
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = '';
  }
}
