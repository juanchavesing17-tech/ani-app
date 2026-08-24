/**
 * Lo que el teléfono puede hacer SIN preguntarle al servidor.
 *
 * ## El problema que resuelve
 *
 * Juan lo dijo usándola: «se demora al realizar consultas». Y se midió:
 *
 *     calcular (el área de una barra)   2,11 s
 *     el clima                          1,99 s
 *     la TRM                            2,99 s
 *     la hora                           2,08 s
 *
 * **Dos segundos para multiplicar dos números.** Ese dato es el que lo
 * explica todo: no es el cálculo, es el viaje. Apps Script arranca en frío
 * en cada petición y contesta con una redirección a `googleusercontent.com`,
 * así que son dos idas y vueltas antes de empezar a hacer nada. Desde los
 * datos del celular en obra, el doble.
 *
 * En una conversación hablada eso no es «un poco lento»: son dos segundos de
 * silencio en los que Juan no sabe si ANI lo oyó.
 *
 * ## La regla
 *
 * **Al servidor solo lo que necesita el servidor.** Es decir: la cuenta de
 * Google de Juan (Gmail, Calendar, Drive) o una clave secreta (Gemini).
 *
 * Todo lo demás —aritmética, open-meteo, la TRM de datos.gov.co, buscar en
 * YouTube— son cuentas o servicios abiertos que el teléfono puede hacer él
 * solo. Y hacerlos aquí no es solo más rápido: es que **el resultado es el
 * mismo**, así que pasar por Apps Script era pagar dos segundos por nada.
 *
 * ## Un efecto secundario que no se buscaba
 *
 * Lo de YouTube **no funcionaba** desde el servidor: devolvía siempre la
 * lista de resultados en vez del vídeo. Se comprobó y la razón es que
 * YouTube le sirve una página distinta a las IPs de los centros de datos de
 * Google. Desde el teléfono, con IP de casa, sale a la primera.
 *
 * ## Las cuentas son las mismas
 *
 * `calculos.gs` y esto tienen que dar el MISMO número, o ANI contesta una
 * cosa en obra y otra en el computador. Por eso las funciones están copiadas
 * literalmente, y hay una prueba que compara las dos tablas de barras.
 */

// ------------------------------------------------------------ las cuentas

// diámetro mm, área mm², perímetro mm, peso kg/m, nombre comercial.
// NSR-10 Tabla C.3.5.3-2. Idéntica a la de `calculos.gs` y a la del PC.
export const BARRAS = {
  2:  [6.4,   32,   20.0,  0.250, '1/4"'],
  3:  [9.5,   71,   30.0,  0.560, '3/8"'],
  4:  [12.7,  129,  40.0,  0.994, '1/2"'],
  5:  [15.9,  199,  50.0,  1.552, '5/8"'],
  6:  [19.1,  284,  60.0,  2.235, '3/4"'],
  7:  [22.2,  387,  70.0,  3.042, '7/8"'],
  8:  [25.4,  510,  80.0,  3.973, '1"'],
  9:  [28.7,  645,  90.0,  5.060, '1-1/8"'],
  10: [32.3,  819,  101.3, 6.404, '1-1/4"'],
  11: [35.8,  1006, 112.5, 7.907, '1-3/8"'],
  14: [43.0,  1452, 135.1, 11.380, '1-3/4"'],
  18: [57.3,  2581, 180.1, 20.240, '2-1/4"'],
};

const PESO_CONCRETO = 2400;
const APOYOS = {
  'simplemente apoyada':      [16, 20],
  'un extremo continuo':      [18.5, 24],
  'ambos extremos continuos': [21, 28],
  'voladizo':                 [8, 10],
};

const red = (n, d) => Math.round(n * 10 ** d) / 10 ** d;
const pelar = (t) => String(t || '').normalize('NFD')
  .replace(/[̀-ͯ]/g, '').toLowerCase().trim();

function barra(numero) {
  const b = BARRAS[parseInt(numero, 10)];
  if (!b) {
    return { error: `No existe la barra número ${numero}. Las que hay: `
                  + `${Object.keys(BARRAS).join(', ')}.` };
  }
  return { barra: `N.º ${parseInt(numero, 10)} (${b[4]})`, diametro_mm: b[0],
           area_mm2: b[1], perimetro_mm: b[2], peso_kg_m: b[3] };
}

function acero(barraN, metros = 1, cantidad = 1) {
  const b = barra(barraN);
  if (b.error) return b;
  const m = Number(metros), c = parseInt(cantidad, 10);
  if (isNaN(m) || isNaN(c)) return { error: 'Los metros y la cantidad tienen que ser números.' };
  if (m < 0 || c < 1) return { error: 'Metros negativos o cantidad menor que una barra.' };
  return { barra: b.barra, cantidad: c, metros_cada_una: red(m, 3),
           metros_totales: red(m * c, 2), area_total_mm2: red(b.area_mm2 * c, 1),
           peso_kg: red(b.peso_kg_m * m * c, 2) };
}

function zapata(largo, ancho, carga, capacidad) {
  const L = Number(largo), A = Number(ancho), P = Number(carga);
  const cap = Number(capacidad || 0);
  if (isNaN(L) || isNaN(A) || isNaN(P)) return { error: 'Las medidas y la carga tienen que ser números.' };
  if (L <= 0 || A <= 0) return { error: 'La zapata no puede medir cero.' };
  if (P < 0) return { error: 'La carga no puede ser negativa.' };

  const presion = P / (L * A);
  const r = { zapata: `${L} × ${A} m`, area_m2: red(L * A, 3), carga_t: red(P, 2),
              presion_t_m2: red(presion, 2),
              nota: 'Presión de servicio, sin el peso propio de la zapata ni '
                  + 'del suelo encima. Con ellos sube.' };
  if (cap > 0) {
    r.capacidad_admisible_t_m2 = red(cap, 2);
    r.cumple = presion <= cap;
    r.aprovechamiento_pct = red(presion / cap * 100, 1);
    if (presion > cap) {
      r.lado_minimo_cuadrada_m = red(Math.ceil(Math.sqrt(P / cap) * 20) / 20, 2);
    }
  }
  return r;
}

function volumen(largo, ancho, alto, cantidad = 1) {
  const L = Number(largo), A = Number(ancho), H = Number(alto);
  const c = parseInt(cantidad, 10);
  if ([L, A, H, c].some(isNaN)) return { error: 'Las medidas tienen que ser números.' };
  if (L <= 0 || A <= 0 || H <= 0) return { error: 'Ninguna medida puede ser cero.' };
  const uno = L * A * H;
  return { pieza: `${L} × ${A} × ${H} m`, cantidad: c,
           volumen_m3_cada_una: red(uno, 3), volumen_m3_total: red(uno * c, 3),
           peso_t_total: red(uno * c * PESO_CONCRETO / 1000, 2) };
}

function alturaMinima(luz, apoyo, tipo) {
  const L = Number(luz);
  if (isNaN(L) || L <= 0) return { error: 'La luz tiene que ser un número mayor que cero.' };
  const pedido = pelar(apoyo || 'simplemente apoyada');
  const elegido = Object.keys(APOYOS).find(
    (k) => pelar(k) === pedido || pelar(k).includes(pedido));
  if (!elegido) {
    return { error: `No conozco ese apoyo. Los que hay: ${Object.keys(APOYOS).join(', ')}.` };
  }
  const esLosa = pelar(tipo || '').includes('losa');
  const divisor = APOYOS[elegido][esLosa ? 1 : 0];
  return { elemento: esLosa ? 'losa maciza en una dirección' : 'viga',
           apoyo: elegido, luz_m: red(L, 2), divisor,
           altura_minima_m: red(L / divisor, 3),
           altura_minima_cm: red(L / divisor * 100, 1),
           fuente: 'NSR-10 Tabla C.9.5(a), fy = 420 MPa, concreto de peso normal',
           nota: 'Es el mínimo para NO calcular deflexiones. Se puede usar '
               + 'menos si se calculan.' };
}

function recubrimiento(donde, barraN) {
  const d = pelar(donde || '');
  const n = parseInt(barraN || 0, 10);
  if (/contra el suelo|zapata|cimenta/.test(d)) {
    return { donde: 'concreto vaciado contra el suelo y permanentemente expuesto',
             recubrimiento_mm: 75, recubrimiento_cm: 7.5, fuente: 'NSR-10 C.7.7.1(a)' };
  }
  if (/intemperie|expuesto|tierra/.test(d)) {
    const mm = n >= 6 ? 50 : 40;
    return { donde: 'expuesto a la intemperie o en contacto con el terreno',
             recubrimiento_mm: mm, recubrimiento_cm: mm / 10,
             nota: n ? `para barra N.º ${n}`
                     : 'N.º 6 o mayor: 50 mm; N.º 5 o menor: 40 mm',
             fuente: 'NSR-10 C.7.7.1(b)' };
  }
  if (/losa|muro|vigueta/.test(d)) {
    return { donde: 'losas, muros y viguetas, no expuestos', recubrimiento_mm: 20,
             recubrimiento_cm: 2.0, fuente: 'NSR-10 C.7.7.1(c)' };
  }
  if (/viga|columna/.test(d)) {
    return { donde: 'vigas y columnas, no expuestas', recubrimiento_mm: 40,
             recubrimiento_cm: 4.0, nota: 'Al refuerzo principal, estribos o espirales',
             fuente: 'NSR-10 C.7.7.1(c)' };
  }
  return { aviso: 'Dígame dónde: contra el suelo, a la intemperie, losa/muro, '
                + 'o viga/columna.',
           resumen: { 'vaciado contra el suelo': '75 mm',
                      'a la intemperie, N.º 6 o mayor': '50 mm',
                      'a la intemperie, N.º 5 o menor': '40 mm',
                      'vigas y columnas no expuestas': '40 mm',
                      'losas, muros y viguetas no expuestos': '20 mm' },
           fuente: 'NSR-10 C.7.7.1' };
}

function calcular(p) {
  const que = pelar(p.que || '');
  if (que.includes('barra') && !p.metros && !p.cantidad) return barra(p.barra);
  if (que.includes('acero') || que.includes('barra')) return acero(p.barra, p.metros, p.cantidad);
  if (que.includes('zapata') || que.includes('presion')) return zapata(p.largo, p.ancho, p.carga, p.capacidad);
  if (que.includes('volumen') || que.includes('concreto')) return volumen(p.largo, p.ancho, p.alto, p.cantidad);
  if (que.includes('altura') || que.includes('peralte')) return alturaMinima(p.luz, p.apoyo, p.tipo);
  if (que.includes('recubrimiento')) return recubrimiento(p.donde, p.barra);
  return { error: `No sé calcular «${p.que}». Puedo: barra, acero, zapata, `
                + 'volumen, altura mínima, recubrimiento.' };
}

// -------------------------------------------------------------- la fecha

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
               'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const NUM = ['doce', 'una', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete',
             'ocho', 'nueve', 'diez', 'once', 'doce'];

function horaYFecha() {
  const d = new Date();
  const h = d.getHours(), m = d.getMinutes();
  const franja = h < 12 ? 'de la mañana' : (h < 19 ? 'de la tarde' : 'de la noche');
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const art = h12 === 1 ? 'la' : 'las';
  const dicha = m === 0 ? `${art} ${NUM[h12]} en punto`
              : m === 15 ? `${art} ${NUM[h12]} y cuarto`
              : m === 30 ? `${art} ${NUM[h12]} y media`
              : `${art} ${NUM[h12]} y ${m}`;
  return {
    fecha: `${DIAS[d.getDay()]} ${d.getDate()} de ${MESES[d.getMonth()]}`,
    hora: `${dicha} ${franja}`,
    iso: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-`
       + `${String(d.getDate()).padStart(2, '0')}`,
  };
}

// --------------------------------------------------------------- el clima

// Los sitios de siempre, para no gastar una llamada en buscarlos.
const LUGARES = {
  pasto: [1.2136, -77.2811],      contadero: [0.9089, -77.5375],
  tuquerres: [1.0864, -77.6178],  puerres: [0.8836, -77.5064],
  ipiales: [0.8256, -77.6444],    'la union': [1.6047, -77.1319],
  sandona: [1.2836, -77.4711],    buesaco: [1.3839, -77.1553],
};

async function coordenadas(lugar) {
  const pedido = pelar(lugar);
  for (const [n, c] of Object.entries(LUGARES)) {
    if (n === pedido || pedido.includes(n) || n.includes(pedido)) {
      return { lat: c[0], lon: c[1], nombre: n[0].toUpperCase() + n.slice(1) };
    }
  }
  const r = await fetch('https://geocoding-api.open-meteo.com/v1/search?name='
    + encodeURIComponent(lugar) + '&count=1&language=es');
  const d = await r.json();
  const x = (d.results || [])[0];
  return x ? { lat: x.latitude, lon: x.longitude, nombre: x.name } : null;
}

/**
 * El clima. Si no dicen el lugar, se usa el GPS del propio teléfono, que es
 * más exacto que lo último que se le contó al servidor.
 */
async function elClima(p, ultimaPosicion) {
  let sitio;
  if (p.lugar) {
    sitio = await coordenadas(p.lugar);
    if (!sitio) return { error: `No encontré «${p.lugar}». Dígame otro municipio.` };
  } else if (ultimaPosicion) {
    sitio = ultimaPosicion;
  } else {
    sitio = { ...await coordenadas('pasto') };
  }

  const n = Math.max(1, Math.min(Number(p.dias) || 3, 7));
  const r = await fetch('https://api.open-meteo.com/v1/forecast'
    + `?latitude=${sitio.lat}&longitude=${sitio.lon}`
    + '&daily=precipitation_probability_max,precipitation_sum,'
    + 'temperature_2m_max,temperature_2m_min'
    + `&timezone=America%2FBogota&forecast_days=${n}`);
  const d = await r.json();
  const dd = d.daily || {};
  return {
    lugar: sitio.nombre,
    dias: (dd.time || []).map((fecha, i) => ({
      fecha,
      lluvia_pct: (dd.precipitation_probability_max || [])[i],
      lluvia_mm: (dd.precipitation_sum || [])[i],
      temp_max: (dd.temperature_2m_max || [])[i],
      temp_min: (dd.temperature_2m_min || [])[i],
    })),
    fuente: 'open-meteo.com',
  };
}

// ---------------------------------------------------------------- la TRM

async function elDolar() {
  const r = await fetch('https://www.datos.gov.co/resource/32sa-8pi3.json'
    + '?$limit=1&$order=vigenciadesde%20DESC');
  const x = (await r.json())[0];
  if (!x) return { error: 'El servicio de la TRM no devolvió nada.' };
  return { trm: Number(x.valor), desde: String(x.vigenciadesde || '').slice(0, 10),
           hasta: String(x.vigenciahasta || '').slice(0, 10),
           fuente: 'Superintendencia Financiera, vía datos.gov.co' };
}

// -------------------------------------------------------------- YouTube

/**
 * El vídeo, resuelto DESDE EL TELÉFONO.
 *
 * Esto no es solo por velocidad: desde Apps Script **no funcionaba**.
 * YouTube le sirve una página distinta a las IPs de los centros de datos de
 * Google y el identificador del vídeo no aparece, así que siempre caía en la
 * lista de resultados. Con la IP de un teléfono normal sale a la primera.
 */
async function ponerMusica(p) {
  const que = String(p.que || '').trim();
  if (!que) return { error: 'No entendí qué quiere oír.' };
  if (/(youtube\.com|youtu\.be)\//i.test(que)) {
    return { url: que.startsWith('http') ? que : 'https://' + que,
             que: 'el enlace que me dio', directo: true };
  }
  try {
    const r = await fetch('https://www.youtube.com/results?search_query='
                          + encodeURIComponent(que));
    const html = await r.text();
    const id = (html.match(/"videoId":"([\w-]{11})"/) || [])[1];
    const titulo = (html.match(/"title":\{"runs":\[\{"text":"([^"]{1,120})"/) || [])[1];
    if (id) {
      return { url: `https://www.youtube.com/watch?v=${id}`, que,
               reproduciendo: titulo || que, directo: true };
    }
  } catch (e) { /* sin red o YouTube cambió: se cae a la lista */ }
  return { url: 'https://www.youtube.com/results?search_query=' + encodeURIComponent(que),
           que, directo: false,
           aviso: 'No pude resolver el vídeo; le abro la lista para que elija.' };
}

// ------------------------------------------------------------- la puerta

/**
 * Lo que se atiende aquí sin salir del teléfono.
 *
 * Si una herramienta NO está en este mapa, se va al Apps Script. Así añadir
 * cosas al servidor no obliga a tocar esto.
 */
export const AQUI = {
  calcular:     (p) => calcular(p),
  hora_y_fecha: () => horaYFecha(),
  el_clima:     (p, pos) => elClima(p, pos),
  el_dolar:     () => elDolar(),
  poner_musica: (p) => ponerMusica(p),
};

export function seHaceAqui(nombre) {
  return Object.prototype.hasOwnProperty.call(AQUI, nombre);
}
