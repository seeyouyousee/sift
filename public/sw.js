/* eslint-env serviceworker */
/**
 * Offline shell for Sift.
 *
 * Deliberately narrow:
 *  - only same-origin GET requests are touched, so api.deepseek.com is never cached
 *    (search results are per-user and must never be served from a shared cache);
 *  - navigations are network-first so a redeploy is visible immediately, with the
 *    cached shell as the offline fallback;
 *  - hashed assets are cache-first (their name changes when the content does).
 */
const VERSION = 'sift-v1';
const SHELL = ['./', './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put('./', copy)).catch(() => {});
          return response;
        })
        .catch(() => caches.match('./').then((hit) => hit ?? Response.error())),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ??
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        }),
    ),
  );
});
