/**
 * Lo justo para que se instale como app y abra sin conexión.
 *
 * NO se cachea nada de ANI: ni el informe, ni lo que se dijo, ni el secreto.
 * Solo el armazón. Todo lo demás necesita internet igualmente —la voz va
 * contra Gemini y los datos contra el Apps Script—, así que guardarlo sería
 * dejar copias de la agenda de Juan en el teléfono para nada.
 */
const CAJA = 'ani-armazon-v14';
const ARMAZON = ['./', './index.html', './principal.js', './ani.js',
                 './microfono.js', './servidor.js', './particulas.js',
                 './aqui_mismo.js', './bitacora_local.js',
                 './manifest.json',
                 './icono.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CAJA).then((c) => c.addAll(ARMAZON))
                    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ns) => Promise.all(ns.filter((n) => n !== CAJA)
                                .map((n) => caches.delete(n))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  // Solo el armazón, y solo lo propio. Cualquier petición al Apps Script o a
  // Gemini pasa de largo: cachearlas daría respuestas viejas, y en el caso
  // del informe eso es decirle a Juan el clima de ayer.
  if (e.request.method !== 'GET') return;
  if (new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
