import { App } from './app';

// The camera only works on HTTPS. Some hosts (e.g. GitHub Pages on a custom domain without
// "Enforce HTTPS") also answer on plain http, so move visitors over before anything starts.
// Local development (localhost, LAN IPs) is left alone so its own error message can explain.
const host = location.hostname;
const isLocal = host === 'localhost' || host === '[::1]' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.endsWith('.local');
if (import.meta.env.PROD && location.protocol === 'http:' && !isLocal) {
  location.replace(`https:${location.href.slice('http:'.length)}`);
} else {
  const root = document.getElementById('app');
  if (!root) throw new Error('#app root element is missing');
  new App(root).mount();
}
