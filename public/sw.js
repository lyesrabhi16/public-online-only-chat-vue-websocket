// Keeps the files of the page (never what people say: the chat itself goes through a live connection, and nothing is stored).
// The page loads fast and can be installed. New versions are picked up when you are online.
const CACHE = 'chat-shell-v1'

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(['/', '/favicon.svg', '/manifest.webmanifest'])))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/socket.io') || url.pathname === '/health') return
  // the page itself: the network first (so a new version shows up), the kept copy when offline
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then((response) => (caches.open(CACHE).then((c) => c.put('/', response.clone())), response)).catch(() => caches.match('/')))
    return
  }
  // built files have a hash in their name: kept once, served from the cache
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ||
        fetch(request).then((response) => {
          if (response.ok) caches.open(CACHE).then((c) => c.put(request, response.clone()))
          return response
        }),
    ),
  )
})
