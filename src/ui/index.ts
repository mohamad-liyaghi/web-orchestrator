/**
 * UI module public API: landing page, stage (video + HUD overlay + metrics + controls).
 */
import '@fontsource-variable/space-grotesk/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/landing.css';
import './styles/stage.css';
import './styles/metrics.css';
import './styles/dock.css';
import './styles/overlays.css';
import './styles/chords.css';
import './styles/learn.css';
import './styles/looper.css';

export { mountLanding } from './landing';
export { mountStage } from './stage';
