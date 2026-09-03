/**
 * Lo justo para que se instale como app y abra sin conexión.
 *
 * NO se cachea nada de ANI: ni el informe, ni lo que se dijo, ni el secreto.
 * Solo el armazón. Todo lo demás necesita internet igualmente —la voz va
 * contra Gemini y los datos contra el Apps Script—, así que guardarlo sería
 * dejar copias de la agenda de Juan en el teléfono para nada.
 */
const CAJA = 'ani-armazon-v22';

/* Los fotogramas de ANI van en SU PROPIA CAJA, y NO en el armazon.
 *
 * Son 407 kB: metidos en `ARMAZON` habria que bajarlos ENTEROS antes de que
 * la app abriera la primera vez, y esta app tiene que abrir si o si a las
 * siete de la manana, a veces con media raya de senal.
 *
 * Asi abre igual de rapido que hoy, y cada cara se guarda sola la primera
 * vez que se ve. A partir del segundo arranque esta completa sin conexion,
 * que es lo que hace falta en campo.
 *
 * Van aparte tambien para poder cambiarlas sin obligar a rebajar el
 * armazon entero, y al reves. */
const CAJA_CARAS = 'ani-caras-v1';
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
    .then((ns) => Promise.all(ns.filter((n) => n !== CAJA && n !== CAJA_CARAS)
                                .map((n) => caches.delete(n))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  // Solo el armazón, y solo lo propio. Cualquier petición al Apps Script o a
  // Gemini pasa de largo: cachearlas daría respuestas viejas, y en el caso
  // del informe eso es decirle a Juan el clima de ayer.
  if (e.request.method !== 'GET') return;
  if (new URL(e.request.url).origin !== self.location.origin) return;
  // `ignoreSearch` porque el despertador abre la app como `…/?despertar`, y
  // sin eso la caché busca esa dirección EXACTA —con el «?» incluido—, no la
  // encuentra, y la app solo abriría habiendo señal. Justo a las siete de la
  // mañana, que es cuando tiene que abrir sí o sí.
  // Las caras: se sirven de la caja si estan, y si no se bajan Y SE GUARDAN.
  // Es la unica peticion que se cachea al vuelo, y se puede porque son
  // archivos fijos: no son datos de Juan, no caducan, y no dicen nada de el.
  if (/\/ani\/\d+\.webp$/.test(new URL(e.request.url).pathname)) {
    e.respondWith(
      caches.open(CAJA_CARAS).then((c) =>
        c.match(e.request).then((r) => r || fetch(e.request).then((res) => {
          if (res.ok) c.put(e.request, res.clone());
          return res;
        }).catch(() => r))));
    return;
  }

  e.respondWith(
    caches.match(e.request, { ignoreSearch: true })
          .then((r) => r || fetch(e.request)));
});
