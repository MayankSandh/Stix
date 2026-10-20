// Service worker: offline support + receiving images from Android's Share menu.
const CACHE = 'sticker-maker-v1';
const SHELL = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/db.js',
  'js/crop.js',
  'js/brush.js',
  'js/image.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== 'share-inbox').map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(receiveShare(request));
    return;
  }
  if (request.method !== 'GET') return;

  // Network first so updates show up immediately; cache when offline.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request, { ignoreSearch: true })),
  );
});

async function receiveShare(request) {
  const scope = self.registration.scope;
  try {
    const form = await request.formData();
    const file = form.getAll('image').find((f) => f && typeof f !== 'string' && f.type.startsWith('image/'));
    if (!file) return Response.redirect(`${scope}?share-target=none`, 303);
    const inbox = await caches.open('share-inbox');
    await inbox.put(new URL('shared-file', scope).href, new Response(file, { headers: { 'Content-Type': file.type } }));
    return Response.redirect(`${scope}?share-target=ok`, 303);
  } catch {
    return Response.redirect(`${scope}?share-target=none`, 303);
  }
}
