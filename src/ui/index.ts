/**
 * UI module public API: landing page, stage (video + HUD overlay + controls).
 * Implementation: see the UI brief / README.
 */
import type { LandingView, StageCallbacks, StageView } from '../types';

export function mountLanding(root: HTMLElement, opts: { onStart: () => void }): LandingView {
  void root;
  void opts;
  throw new Error('ui: not implemented yet');
}

export function mountStage(root: HTMLElement, callbacks: StageCallbacks): StageView {
  void root;
  void callbacks;
  throw new Error('ui: not implemented yet');
}
