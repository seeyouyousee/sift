import './styles.css';
import { createApp } from './app.js';

createApp();

// Offline shell is a bonus, not a requirement: production builds register a
// service worker, dev keeps using the Vite server's fresh files.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* ignored: the app works without it */
    });
  });
}
