/* চিঠি · Chitthi — service worker (Phase 5 packaging, White & Blue round)
 *
 * Scope: app-shell offline support ONLY.
 *  - Precache: app-shell entry, manifest and icons (versioned cache).
 *  - Runtime cache-first: hashed build assets (assets/) and the bundled
 *    sticker SVGs (stickers/) — immutable, content-addressed or static
 *    files, so cache-first is safe.
 *  - Navigations: network-first, falling back to the cached shell when
 *    offline so the app can boot and show its own offline states.
 *  - NEVER intercepted (the fetch handler simply does not call
 *    respondWith, so the browser handles them exactly as if no SW
 *    existed): non-GET requests, api/, ws, uploads/, and every
 *    cross-origin request — which covers Firebase / googleapis hosts.
 *  - HONEST OFFLINE RULE: this worker never queues, replays or fakes a
 *    message send. Sends are non-GET api + WebSocket traffic, which is
 *    bypassed above; offline sends surface as failed/retry through the
 *    app's own send path.
 *
 * SUBPATH SAFETY (White & Blue round): every path below is resolved
 * RELATIVE to this worker's registration scope. The previous version
 * used origin-absolute paths ('/index.html', '/assets/'), which under a
 * subpath deployment (GitHub Pages /chitthi/) pointed at a DIFFERENT
 * site on the same origin — the precache then cached the wrong shell
 * (or failed outright) and installed apps got stuck on stale content.
 *
 * Bump CACHE_VERSION whenever the precache list or these rules change;
 * activation deletes every older cache and clients.claim() takes over
 * open tabs immediately, so installed apps pick up a new build on the
 * next open.
 */
'use strict';

var CACHE_VERSION = 'chitthi-shell-v2';

/* This worker's scope path, e.g. '/' at a root deploy or '/chitthi/'
 * on GitHub Pages. All matching below is done on the scope-relative
 * remainder of the request path. */
var SCOPE_PATH = new URL(self.registration.scope).pathname;

function scopeRelative(pathname) {
  if (pathname.indexOf(SCOPE_PATH) === 0) return pathname.slice(SCOPE_PATH.length);
  // Same-origin path outside this scope (should not happen for our own
  // fetches): strip the leading slash so the prefix checks still apply.
  return pathname.replace(/^\//, '');
}

/* Precache URLs are scope-relative on purpose (see header): they are
 * resolved against the worker's scope, never the origin root. */
var PRECACHE_URLS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-16.png',
  'icons/favicon-32.png',
  'icons/favicon.ico'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(function (cache) { return cache.addAll(PRECACHE_URLS); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (key) {
          return key === CACHE_VERSION ? Promise.resolve() : caches.delete(key);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

/** Paths (scope-relative) that must always go straight to the network. */
function isBypassed(rel) {
  return rel.indexOf('api/') === 0 ||
    rel === 'api' ||
    rel.indexOf('ws') === 0 ||
    rel.indexOf('uploads/') === 0 ||
    rel === 'uploads';
}

/** Same-origin GETs that are safe to serve cache-first at runtime. */
function isRuntimeCacheable(rel) {
  return rel.indexOf('assets/') === 0 ||
    rel.indexOf('stickers/') === 0 ||
    rel.indexOf('icons/') === 0 ||
    rel === 'manifest.webmanifest';
}

self.addEventListener('fetch', function (event) {
  var request = event.request;

  // Non-GET (sends, uploads, API mutations): never intercept.
  if (request.method !== 'GET') return;

  var url;
  try { url = new URL(request.url); } catch (e) { return; }

  // Cross-origin (Firebase, googleapis, fonts, GIF providers, …): never
  // intercept. WebSocket upgrades are not fetch events at all, and the
  // same-origin ws path is bypassed below as well.
  if (url.origin !== self.location.origin) return;
  var rel = scopeRelative(url.pathname);
  if (isBypassed(rel)) return;

  // Navigations: network-first, cached shell as the offline fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(function () {
        return caches.match('index.html', { ignoreSearch: true })
          .then(function (cached) { return cached || caches.match('./', { ignoreSearch: true }); })
          .then(function (cached) {
            // No cached shell (e.g. SW just installed): let the
            // navigation fail honestly rather than invent a response.
            return cached || Response.error();
          });
      })
    );
    return;
  }

  // Static runtime assets + precached shell files: cache-first, then
  // network (populating the cache for hashed assets seen for the
  // first time), so repeat visits and offline boots work.
  if (isRuntimeCacheable(rel)) {
    event.respondWith(
      caches.match(request, { ignoreSearch: true }).then(function (cached) {
        if (cached) return cached;
        return fetch(request).then(function (response) {
          if (response && response.ok && response.type === 'basic') {
            var copy = response.clone();
            caches.open(CACHE_VERSION).then(function (cache) { cache.put(request, copy); });
          }
          return response;
        });
      })
    );
    return;
  }

  // Everything else same-origin: leave it to the network untouched.
});
