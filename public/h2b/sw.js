/* H2 Dream — service worker: casca offline + rede primeiro para a API. */
const VERSION = 'h2dream-v2';
const SHELL = ['/h2b/', '/h2b/index.html', '/h2b/css/base.css', '/h2b/css/layout.css', '/h2b/css/views.css',
  '/h2b/js/app.js', '/h2b/js/jobs.js', '/h2b/js/send.js', '/h2b/js/profile.js', '/h2b/js/views.js', '/js/api.js', '/h2b/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL).catch(() => null)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // API: sempre rede. Sem cache de dados — o que o usuário vê é o que o servidor tem.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/health')) return;
  // Casca: rede primeiro, cache como reserva (funciona sem conexão).
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok && url.origin === self.location.origin) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request).then(m => m || (e.request.mode === 'navigate' ? caches.match('/h2b/index.html') : Response.error())))
  );
});
