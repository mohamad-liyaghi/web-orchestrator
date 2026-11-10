import { App } from './app';

const root = document.getElementById('app');
if (!root) throw new Error('#app root element is missing');
new App(root).mount();
