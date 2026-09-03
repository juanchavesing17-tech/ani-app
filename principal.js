/**
 * Lo que ata la interfaz con ANI.
 *
 * ANI por Juan Guillermo Chaves · INGEOMAS
 */

import { Conversacion } from './ani.js';
import { FondoParticulas } from './particulas.js';
import * as servidor from './servidor.js';
import * as bitacoraLocal from './bitacora_local.js';

const $ = (id) => document.getElementById(id);
const fondo = new FondoParticulas($('particulas'));
const ROTULO = {
  dormida: 'En reposo',
  'pidiendo permiso': 'Pidiendo el micrófono…',
  abriendo: 'Abriendo la línea…',
  escuchando: 'Escuchando',
  oyendo: 'Escuchando',
  hablando: 'Hablando',
  buscando: 'Consultando…',
  'se cayo': 'Se cortó',
  'sin permiso': 'No pude abrir la voz',
  'sin microfono': 'Sin micrófono',
};

let charla = null;
// Una conversacion preparada de antemano, con su llave ya pedida.
let adelantada = null;

/**
 * La burbuja que está creciendo, UNA POR CADA UNO.
 *
 * Antes había una sola variable para las dos, y al empezar a hablar ANI la
 * de Juan se quedaba huérfana en pantalla: su frase aparecía dos veces, la
 * de en vivo en cursiva y la definitiva debajo. Lo vio él en el celular.
 */
const vivas = { juan: null, ani: null };

// ------------------------------------------------------------- el chat

/**
 * Las barras de voz dentro del núcleo.
 *
 * Es lo único del núcleo que mueve JavaScript: los anillos los gira el CSS,
 * que lo hace la tarjeta gráfica y no cuesta batería.
 *
 * ## Las barras se crean UNA vez y luego solo se estiran
 *
 * La primera versión hacía `innerHTML` con las cinco barras en cada aviso de
 * nivel — **dieciséis veces por segundo**, porque llega uno por cada trozo de
 * micrófono. Cada `innerHTML` obliga al navegador a parsear el texto y a
 * rehacer esos nodos, y todo eso pasa en el hilo principal, el mismo que
 * está encolando el audio de ANI.
 *
 * En un computador ni se nota. En un teléfono compite con la voz, y es parte
 * de por qué sonaba entrecortada. Ahora se tocan cinco atributos y ya.
 */
/* ── ANI, la de la pantalla ────────────────────────────────────────────────
 *
 * Los gestos son los mismos que en el panel del computador: los escribio
 * Juan mirandolos correr. Falta el giro de cabeza (fotogramas 17-20): a
 * 340 px en un telefono no se apreciaria y costaba cuatro imagenes.
 *
 * Las cinco barritas de voz que habia aqui ya no hacen falta --el nivel lo
 * lleva el resplandor-- y de paso se le quita trabajo al hilo que atiende
 * la voz, que en un telefono es el que importa.
 */
const GESTOS = {
  dormida:    { pasos: [1, 2, 3, 2, 1],       ms: 600 },
  escuchando: { pasos: [3, 10, 2, 1, 2, 3],   ms: 280 },
  pensando:   { pasos: [1, 2, 3, 2, 1],       ms: 280 },
  hablando:   { pasos: [4, 5, 6, 7, 6, 4, 5], ms: 200 },
  error:      { pasos: [8, 13, 12],           ms: 340, veces: 2 },
};

/* Los DOCE estados de la app repartidos entre las cinco secuencias.
 *
 * La app tiene mas estados que el panel --pedir permiso, abrir la linea,
 * cortarse-- y por eso las caras de error aqui trabajan de verdad: «se
 * corto» y «no pude abrir el microfono» son exactamente eso. */
const CARA_DE = {
  'dormida': 'dormida',
  'pidiendo permiso': 'pensando',
  'abriendo': 'pensando',
  'buscando': 'pensando',
  'escuchando': 'escuchando',
  'oyendo': 'escuchando',
  'hablando': 'hablando',
  'se cayo': 'error',
  'sin permiso': 'error',
  'sin microfono': 'error',
};

let aniSitua = '';          // vacia a proposito: si arranca con el valor que
let aniCara = 0;            // se le va a pedir, el primer cambio no hace nada
let aniPaso = 0, aniVuelta = 0, aniReloj = null;

function aniPoner(n, ms) {
  if (n === aniCara) return;
  aniCara = n;
  const fig = $('figura');
  if (!fig) return;
  fig.style.setProperty('--cruce',
    Math.min(140, Math.max(40, Math.round(ms / 3))) + 'ms');
  const capas = fig.children;
  for (let i = 0; i < capas.length; i++) {
    capas[i].classList.toggle('puesta', +capas[i].dataset.n === n);
  }
}

function aniAvanzar() {
  const s = GESTOS[aniSitua];
  if (!s) return;
  aniPoner(s.pasos[aniPaso], s.ms);
  aniPaso++;
  if (aniPaso >= s.pasos.length) {
    aniPaso = 0;
    aniVuelta++;
    // Una reaccion pasa y se queda quieta: en bucle seria un tic.
    if (s.veces && aniVuelta >= s.veces) {
      aniPaso = s.pasos.length - 1;
      aniPoner(s.pasos[aniPaso], 300);
      return;
    }
  }
  aniReloj = setTimeout(aniAvanzar, s.ms);
}

function aniGesto(estado) {
  const cual = CARA_DE[estado] || 'dormida';
  if (cual === aniSitua) return;
  clearTimeout(aniReloj);
  aniSitua = cual; aniPaso = 0; aniVuelta = 0;
  document.body.dataset.ani = cual;
  aniAvanzar();
}

/* El resplandor sigue la voz. Es lo que separa un adorno de un indicador. */
function pintarOndas(nivel) {
  const b = $('brilloVoz');
  if (b) b.setAttribute('opacity', Math.min(.85, .16 + nivel * 3).toFixed(2));
}

/** Al primer mensaje el núcleo se aparta para dejar leer. */
function encogerNucleo() {
  $('nucleo')?.classList.add('chico');
}

/**
 * Cuántas burbujas se guardan en pantalla.
 *
 * Juan lo describió como que «se llena la interfaz de mensajes y no da
 * espacio para más». Cada turno deja dos, y no se quitaba ninguna: en una
 * conversación larga son cientos de elementos que el navegador vuelve a medir
 * en cada cuadro — y ese trabajo se lo quita al hilo que encola el audio de
 * ANI. O sea que la conversación larga se pagaba en voz entrecortada.
 *
 * Cuarenta es de sobra para subir a mirar lo que se dijo. Lo que importa de
 * verdad queda apuntado en la bitácora, no en el chat.
 */
const BURBUJAS_EN_PANTALLA = 40;

function pintar(quien, texto, vivo = false) {
  $('vacio')?.remove();
  encogerNucleo();
  const chat = $('chat');
  const div = document.createElement('div');
  div.className = `dicho ${quien === 'juan' ? 'de-juan' : 'de-ani'}`
                + (vivo ? ' vivo' : '');
  div.textContent = texto;
  chat.appendChild(div);

  while (chat.children.length > BURBUJAS_EN_PANTALLA) {
    chat.removeChild(chat.firstElementChild);
  }

  chat.scrollTop = chat.scrollHeight;
  return div;
}

/**
 * Abrir algo fuera de la app: un vídeo, un mapa, la hoja de la bitácora.
 *
 * Con `noopener` a propósito: sin eso, la página que se abre puede tocar la
 * nuestra desde `window.opener`, y la nuestra tiene el secreto guardado.
 */
function abrirFuera(url) {
  if (!url) return;
  const abierta = window.open(url, '_blank', 'noopener');
  // Android bloquea la ventana si no viene de un toque suyo, y esto viene de
  // que ANI usó una herramienta. Se le deja el enlace a mano en vez de
  // dejarle creer que sonó algo que no sonó.
  if (!abierta) {
    const div = pintar('ani', 'Toque aquí para abrirlo');
    div.classList.add('enlace');
    div.onclick = () => window.open(url, '_blank', 'noopener');
  }
}

/**
 * Lo que se va oyendo se pinta en UNA burbuja que va creciendo, no en una
 * por trozo. La Live API manda la transcripción a pedazos y sin esto el
 * chat se llena de fragmentos sueltos.
 */
function pintarVivo(quien, texto) {
  if (vivas[quien]) {
    vivas[quien].textContent = texto;
    $('chat').scrollTop = $('chat').scrollHeight;
    return;
  }
  vivas[quien] = pintar(quien, texto, true);
}

/**
 * Se acabó el turno: la burbuja que estaba creciendo se queda con el texto
 * definitivo y deja de verse en cursiva. **No se pinta otra** — pintar una
 * nueva encima era lo que duplicaba las frases.
 */
function asentar(quien, texto) {
  if (vivas[quien]) {
    vivas[quien].textContent = texto;
    vivas[quien].classList.remove('vivo');
    vivas[quien] = null;
  } else {
    pintar(quien, texto);
  }
}

/** Lo que quedara a medias, se deja quieto en pantalla en vez de borrarlo. */
function cerrarBurbuja() {
  for (const quien of ['juan', 'ani']) {
    if (vivas[quien]) { vivas[quien].classList.remove('vivo');
                        vivas[quien] = null; }
  }
}

// ------------------------------------------------------------ el estado

// Cuándo se pintó por última vez el latido del núcleo.
//
// Los avisos de nivel llegan 16 veces por segundo, uno por cada trozo de
// micrófono. Pintar a esa frecuencia no aporta nada —el ojo no lo distingue
// de 12— y sí le quita tiempo al hilo principal, que es el que encola el
// audio de ANI. Se limita a ~12 veces por segundo.
let ultimoLatido = 0;

function avisar(que, extra = {}) {
  if (que === 'nivel') {
    // El nivel se le pasa SIEMPRE al fondo: guardarlo es una asignación y no
    // dibuja nada; ya lo lee su propio bucle cuando le toca.
    fondo.actualizarVoz(extra.nivel);

    const ahora = performance.now();
    if (ahora - ultimoLatido < 80) return;
    ultimoLatido = ahora;

    // El núcleo late con la voz. Es lo que le dice a Juan que ANI lo está
    // oyendo de verdad, sin tener que mirar letra.
    $('pulso').setAttribute('r',
      (78 + Math.min(1, extra.nivel * 2.2) * 9).toFixed(1));
    pintarOndas(extra.nivel);
    return;
  }

  // Una herramienta pidió abrir algo — YouTube o WhatsApp. Se hace aquí y no
  // dentro de `ani.js` porque abrir ventanas es cosa de la interfaz.
  if (que === 'abrir') { abrirFuera(extra.url); return; }

  // ANI acaba de apuntar algo. Ella ya contestó —el apunte está guardado en
  // el teléfono— y la subida a la hoja va por detrás, sin hacerla esperar.
  if (que === 'subir bitacora') { subirApuntesAtrasados(); return; }

  // Cuando ANI propone algo que sale hacia fuera, la tarjeta aparece sola.
  // Solo se pregunta cuando acaba de proponerse algo: preguntarlo al final de
  // cada turno costaba un viaje al Apps Script —dos segundos— que casi nunca
  // traía nada.
  if (que === 'hay propuesta') { mirarSiHayPendiente(); return; }

  $('estado').textContent = ROTULO[que] || que;
  aniGesto(que);
  fondo.cambiarEstado(que);

  if (que === 'oyendo') pintarVivo('juan', extra.texto);
  if (que === 'hablando') pintarVivo('ani', extra.texto);
  if (que === 'escuchando') cerrarBurbuja();

  if (que === 'dormida' || que === 'se cayo' || que.startsWith('sin ')) {
    cerrarBurbuja();
    $('conversar').classList.remove('viva');
    $('conversar').textContent = 'Conversar';
    $('btnSilencio').disabled = true;
    $('pulso').setAttribute('r', 78);
    pintarOndas(0);
    charla = null;
  }
  if (extra.detalle) {
    $('aviso').textContent = extra.detalle.replace(/^Error:\s*/, '');
  }
}

// --------------------------------------------------------- los botones

$('conversar').onclick = async () => {
  $('aviso').textContent = '';

  if (charla) { await charla.apagar(); return; }

  if (!servidor.estaConfigurada()) {
    abrirAjustes();
    return;
  }

  charla = adelantada || new Conversacion(servidor.pedir, avisar, asentar);
  adelantada = null;
  // El GPS del propio teléfono, para que el clima no tenga que ir a
  // preguntarle al servidor dónde estaba la última vez.
  charla.posicion = servidor.ultimaPosicion;
  $('conversar').classList.add('viva');
  $('conversar').textContent = 'Terminar';
  $('btnSilencio').disabled = false;
  await charla.encender();
};

$('btnSilencio').onclick = () => {
  const b = $('btnSilencio');
  const callado = b.textContent === '🔊';
  b.textContent = callado ? '🔇' : '🔊';
  if (charla) charla.silenciar(callado);
};

/**
 * El informe de hoy, el mismo que llega a Telegram de madrugada.
 *
 * Se pide el que ya está hecho en vez de generarlo: así suena la voz buena
 * —la que grabó GitHub con la Live API— en vez de la de texto a voz.
 */
$('btnInforme').onclick = () => darElInforme();

/**
 * @param {boolean} despertando  si esto tiene que SONAR sí o sí
 *
 * La diferencia importa. Con el botón ☀, Juan está despierto y mirando: si no
 * hay audio, leer el texto basta. **Despertándolo no**: un texto en una
 * pantalla que nadie mira es exactamente igual que no hacer nada, y él sigue
 * dormido creyendo que ANI iba a sonar.
 */
async function darElInforme(despertando = false) {
  $('aviso').textContent = '';
  if (!servidor.estaConfigurada()) { abrirAjustes(); return; }

  $('estado').textContent = 'Trayendo el informe…';
  try {
    const r = await servidor.pedir('hablado_de_hoy', {});

    if (r.hay && r.fresco && r.audio) {
      pintar('ani', r.texto);
      sonar(r.audio);
      $('estado').textContent = 'En reposo';
      return;
    }

    // El buzón está vacío o trae el de ayer. Antes que decir algo
    // desactualizado, se pide el de ahora mismo — y **con voz si esto es un
    // despertador**, aunque fabricarla cueste unos segundos. A las siete de
    // la mañana esos segundos no importan; que suene, sí.
    const ahora = await servidor.pedir('despertador', { con_voz: despertando });
    pintar('ani', ahora.texto || r.motivo || 'No pude traer el informe.');
    if (ahora.audio) sonar(ahora.audio);
    else if (despertando) leerEnVozAlta(ahora.texto || r.motivo);

  } catch (e) {
    $('aviso').textContent = String(e).replace(/^Error:\s*/, '');
    // Ni con eso. Se le dice algo, con la voz que sea, antes que dejarlo
    // dormido en silencio.
    if (despertando) {
      leerEnVozAlta('Buenos días, jefe. No pude traer el informe de hoy, '
                  + 'pero es hora de levantarse.');
    }
  }
  $('estado').textContent = 'En reposo';
}

/**
 * La última red: la voz del propio teléfono.
 *
 * No es la de ANI y suena a robot, pero **funciona sin internet y sin Gemini**
 * — va incluida en Android. Es lo que separa «lo despertó con una voz fea» de
 * «no lo despertó», y esa diferencia vale más que la calidad del audio.
 */
function leerEnVozAlta(texto) {
  if (!texto || !window.speechSynthesis) return;

  const decir = () => {
    try {
      const d = new SpeechSynthesisUtterance(texto);
      d.lang = 'es-CO';
      d.rate = 0.95;
      speechSynthesis.speak(d);
    } catch (e) { /* si tampoco se puede, queda la vibración */ }
  };

  // Las voces del sistema cargan de forma ASÍNCRONA, y si se habla antes de
  // que estén, el navegador se traga la frase sin decir nada.
  //
  // Da la casualidad de que ese es justo el caso que importa: a las siete la
  // app se abre en frío y habla enseguida. En las pruebas de aquí las voces
  // ya estaban cargadas, así que **este fallo no lo pude reproducir** — pero
  // esperar cuesta cinco líneas y quedarse mudo cuesta el despertador.
  if (speechSynthesis.getVoices().length) { decir(); return; }

  let dicho = false;
  const unaVez = () => { if (!dicho) { dicho = true; decir(); } };
  speechSynthesis.addEventListener('voiceschanged', unaVez, { once: true });
  // Y por si ese aviso no llega nunca: se intenta igual. Hablar sin voces
  // cargadas puede fallar; no intentarlo falla seguro.
  setTimeout(unaVez, 1200);
}

function sonar(base64) {
  const audio = new Audio('data:audio/wav;base64,' + base64);
  $('estado').textContent = 'Hablando';
  audio.onended = () => { $('estado').textContent = 'En reposo'; };
  audio.play().catch(() => {
    // Sin gesto del usuario el navegador no deja sonar. Desde el botón sí lo
    // hay; al despertar puede que no, y para eso está `pedirQueLoToque`.
    $('estado').textContent = 'En reposo';
    pedirQueLoToque(audio);
  });
}

/**
 * Cuando el navegador no deja sonar sin que nadie haya tocado la pantalla.
 *
 * Pasa al abrir la app desde el despertador. Callarse sería lo peor: Juan
 * seguiría dormido creyendo que ANI iba a hablar. Así que se pone un botón
 * grande, se vibra —que sí está permitido— y con un toque suena.
 */
function pedirQueLoToque(audio) {
  const div = pintar('ani', '▶  Toque aquí para oír el informe');
  div.classList.add('enlace');
  div.onclick = () => {
    audio.play().catch(() => {});
    div.remove();
  };
  if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 400]);
}

/**
 * Despertar: la app abierta sola a las siete de la mañana.
 *
 * ## Por qué esto vive aquí y no en una app de automatización
 *
 * Montar el despertador en Automate eran once bloques en un lienzo de nodos,
 * y Juan lo dijo claro: «la app es bastante confusa». Todo lo que se pueda
 * hacer aquí es un bloque menos que él tenga que armar y entender.
 *
 * Así, en el teléfono solo queda «a las siete, abre esta dirección». Lo demás
 * —mirar si hoy es festivo, traer el informe, sonar— lo hace este código, que
 * es donde se puede probar y arreglar.
 *
 * ## El festivo se comprueba AQUÍ
 *
 * Un horario sabe qué día de la semana es, pero no sabe que el 20 de julio no
 * se trabaja. Se le pregunta al servidor, que sí lo sabe. Ver `festivos.gs`.
 */
async function despertar() {
  document.title = 'ANI · buenos días';
  $('estado').textContent = 'Buenos días…';

  try {
    const dia = await servidor.pedir('es_dia_laboral', {});
    if (dia && dia.suena === 'no') {
      // Hoy no. Ni un sonido: la gracia de que no suene es que no suene.
      pintar('ani', dia.motivo || 'Hoy no hay que madrugar, jefe.');
      $('estado').textContent = 'En reposo';
      return;
    }
  } catch (e) {
    // Sin respuesta no se sabe si hoy es festivo. Se sigue: despertarlo un
    // festivo es un fastidio; no despertarlo un día de obra le cuesta caro.
    console.warn('no pude comprobar si hoy es festivo: ' + e);
  }

  // `true`: esto tiene que sonar sí o sí. Ver `darElInforme`.
  await darElInforme(true);
}

// ------------------------------------------- lo que sale hacia fuera

/**
 * Enseña lo que ANI dejó propuesto, si hay algo.
 *
 * El contenido va **entero y literal**, no resumido: Juan está aprobando un
 * correo que va a leer otra persona, y enseñarle un resumen sería hacerle
 * firmar algo que no vio.
 */
async function mirarSiHayPendiente() {
  let p;
  try { p = await servidor.pedir('ver_pendiente', {}); } catch (e) { return; }
  if (!p || !p.hay) { $('tarjeta').classList.remove('abierta'); return; }

  const ES = { correo: 'Correo por enviar', evento: 'Cita por crear' };
  $('tarjetaTitulo').textContent = ES[p.tipo] || 'Esperando su visto bueno';

  const d = p.detalle || {};
  if (p.tipo === 'correo') {
    $('tarjetaCampo').textContent = `Para: ${d.para}\nAsunto: ${d.asunto}`;
    $('tarjetaCuerpo').textContent = d.mensaje || '';
  } else {
    $('tarjetaCampo').textContent = p.descripcion;
    $('tarjetaCuerpo').textContent = (d.lugar ? 'En ' + d.lugar : '');
  }
  $('enviar').textContent = p.tipo === 'correo' ? 'Enviar' : 'Crear la cita';
  $('tarjeta').classList.add('abierta');
}

async function resolver(si) {
  $('tarjeta').classList.remove('abierta');
  try {
    const r = await servidor.pedir('confirmar_pendiente', { si });
    pintar('ani', r.mensaje || r.error || (si ? 'Hecho.' : 'No lo mandé.'));
  } catch (e) {
    $('aviso').textContent = String(e).replace(/^Error:\s*/, '');
  }
}

$('enviar').onclick = () => resolver(true);
$('cancelar').onclick = () => resolver(false);

// ------------------------------------------------------------- la cámara

$('btnFoto').onclick = () => $('camara').click();

/**
 * Una foto del plano, de la grieta, de lo que sea.
 *
 * Se encoge antes de mandarla: una foto de un celular de hoy son 4 MB, y
 * subirlos por los datos del teléfono en obra tarda una eternidad. A 1024 px
 * de lado Gemini lee un plano igual de bien y son unos 150 KB.
 */
$('camara').onchange = async (e) => {
  const archivo = e.target.files[0];
  if (!archivo) return;
  e.target.value = '';                    // para poder repetir la misma foto

  $('estado').textContent = 'Mirando la foto…';
  fondo.cambiarEstado('buscando');
  try {
    const base64 = await encoger(archivo, 1024);
    pintar('juan', '📷 (le enseñé una foto)');
    const r = await servidor.pedir('usar_herramienta', {
      nombre: 'mirar_foto',
      argumentos: { imagen: base64, pregunta: '' },
    });
    pintar('ani', r.veo || r.error || 'No pude ver la foto.');
  } catch (err) {
    $('aviso').textContent = String(err).replace(/^Error:\s*/, '');
  }
  $('estado').textContent = 'En reposo';
  fondo.cambiarEstado('dormida');
};

function encoger(archivo, lado) {
  return new Promise((ok, mal) => {
    const img = new Image();
    img.onload = () => {
      const e = Math.min(1, lado / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * e);
      c.height = Math.round(img.height * e);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      ok(c.toDataURL('image/jpeg', 0.82).split(',')[1]);
    };
    img.onerror = () => mal(new Error('No pude leer la foto.'));
    img.src = URL.createObjectURL(archivo);
  });
}

// ------------------------------------------------- el medidor

/**
 * Los números de lo que está pasando, con un toque largo en «ANI».
 *
 * Existe porque «la voz se entrecorta» se intentó arreglar dos veces a
 * ciegas: primero la red, luego el trabajo del hilo principal. Los dos eran
 * problemas reales y ninguno era EL problema, porque desde el computador no
 * se puede oír este teléfono.
 *
 * Con esto Juan lee tres números y se sabe cuál de las tres cosas es:
 *
 *   interrupciones altas → el ruido la está cortando (no es la red)
 *   huecos altos         → la red no da (no es el ruido)
 *   espera alta          → tarda en contestar (otra cosa distinta)
 */
function contarComoVa() {
  const caja = $('comoVa');
  if (!caja) return;

  if (!charla) {
    caja.textContent = 'No hay ninguna conversación abierta.\n\n'
      + 'Encienda Conversar, hable un rato, y vuelva aquí sin colgar.';
    return;
  }

  const c = charla.comoVa();
  caja.textContent = [
    `Se cortó sola        ${c.interrupciones}`,
    '   Gemini creyó que usted hablaba encima y la mandó callar.',
    '   Si esto sube mientras ANI habla sola, es el RUIDO.',
    '',
    `Huecos de audio      ${c.huecos}`,
    '   La cola se quedó sin audio esperando el siguiente trozo.',
    '   Si esto sube, es la RED.',
    '',
    `Tardó en abrir       ${c.msHastaAbrir} ms`,
    // El total se parte en tres, porque solo uno de los tres se puede
    // arreglar. Sin esta división, «tarda cuatro segundos» no dice a quién
    // hay que apretar — y adivinarlo ya salió caro una vez.
    `   de eso, el servidor  ${c.msServidor || 0} ms`,
    `   y dentro, Gemini     ${c.msGemini || 0} ms`,
    `   el resto (${Math.max(0, (c.msHastaAbrir || 0) - (c.msServidor || 0))} ms) es arranque en frío de Google y red.`,
    '   Eso no se puede tocar desde aquí.',
    '',
    `Tardó en contestar   ${c.msHastaLaPrimeraPalabra} ms`,
    `Voz rescatada        ${c.msDeVozRescatada} ms`,
    '   Lo que usted dijo mientras la línea se abría, y que antes',
    '   se perdía. Si esto sale alto, ahí estaba la demora.',
    '',
    // Lo que se siente lento EN MEDIO de la conversación no es abrir: es
    // quedarse callada mientras consulta algo.
    ...(c.peorHerramienta ? [
      `La más lenta         ${c.peorHerramienta}`,
      `   tardó ${c.msPeorHerramienta} ms, y el servidor solo ${c.msPeorEnServidor} ms`,
      '   La diferencia es arranque en frío de Google y red.',
    ] : ['Ninguna herramienta usada todavía en esta conversación.']),
  ].join('\n');
}

// ---------------------------------------------------------- los ajustes

/**
 * Abre la hoja de la bitácora. El enlace lo da el servidor, que es quien
 * sabe cuál es: se crea sola la primera vez que Juan apunta algo.
 */
$('verBitacora').onclick = async () => {
  $('verBitacora').textContent = 'Buscándola…';
  try {
    const r = await servidor.pedir('abrir_bitacora', {});
    if (r.error) throw new Error(r.error);
    abrirFuera(r.url);
  } catch (e) {
    $('aviso').textContent = String(e).replace(/^Error:\s*/, '');
  }
  $('verBitacora').textContent = 'Abrir la hoja';
};

/** Lo que ANI recuerda, para que Juan pueda revisarlo y no adivinarlo. */
async function contarQueRecuerda() {
  const caja = $('memoria');
  try {
    const r = await servidor.pedir('que_recuerdas', {});
    caja.textContent = r.cuantos
      ? r.recuerdos.map((x) => '· ' + x).join('\n')
      : 'Todavía no le ha pedido que recuerde nada.';
  } catch (e) {
    caja.textContent = 'No pude consultarlo ahora mismo.';
  }
}

function abrirAjustes() {
  contarComoVa();
  contarQueRecuerda();

  // Si hay apuntes esperando señal, decirlo aquí. Juan tiene que poder saber
  // que algo suyo no ha llegado todavía a la bitácora.
  const esperan = bitacoraLocal.cuantosEsperan();
  $('esperando').textContent = esperan
    ? (esperan === 1
        ? 'Hay 1 apunte esperando señal para subir.'
        : `Hay ${esperan} apuntes esperando señal para subir.`)
    : 'Lo que apunta en obra. Se guarda en una hoja de cálculo de su Drive.';
  $('url').value = localStorage.getItem('ani_url') || '';
  $('secreto').value = '';
  // Sin configurar no hay a dónde volver: la pantalla principal no haría
  // nada. El botón aparece cuando ya hay acceso guardado.
  $('volver').style.display = servidor.estaConfigurada() ? 'flex' : 'none';
  $('ajustes').classList.add('abierta');
}

$('btnAjustes').onclick = abrirAjustes;

/**
 * Volver. Solo si ANI ya está configurada: si no lo está, no hay ningún
 * sitio al que volver —la pantalla principal no serviría de nada— y el botón
 * se esconde.
 */
function cerrarAjustes() {
  if (!servidor.estaConfigurada()) return;
  $('ajustes').classList.remove('abierta');
  $('aviso').textContent = '';
}
$('volver').onclick = cerrarAjustes;

$('guardar').onclick = async () => {
  const url = $('url').value.trim();
  const secreto = $('secreto').value.trim();
  if (!url.endsWith('/exec')) {
    $('aviso').textContent = 'La dirección debe terminar en /exec.';
    $('ajustes').classList.remove('abierta');
    return;
  }
  servidor.guardarAcceso(url, secreto);
  $('ajustes').classList.remove('abierta');
  $('aviso').textContent = '';
  $('estado').textContent = 'Probando…';
  try {
    const r = await servidor.pedir('saludo', {});
    if (r.error) throw new Error(r.error);
    pintar('ani', `Aquí estoy, jefe. Son ${r.hora} y lo tengo en ${r.lugar}.`);
    $('estado').textContent = 'En reposo';
    servidor.contarDondeEstoy();
  } catch (e) {
    $('aviso').textContent = String(e).replace(/^Error:\s*/, '');
    $('estado').textContent = 'Sin conectar';
  }
};

$('olvidar').onclick = () => {
  servidor.olvidarAcceso();
  $('ajustes').classList.remove('abierta');
  $('aviso').textContent = 'Acceso borrado de este teléfono.';
};

// ------------------------------------------------------------ al arrancar

if (!servidor.estaConfigurada()) {
  abrirAjustes();
} else {
  // Cada vez que Juan abre la app se le cuenta al servidor dónde está, para
  // que el informe de mañana traiga el clima del sitio correcto. Es lo único
  // que sabe dónde anda: el disparador de las 5:50 corre en Google y desde
  // allá no hay forma de saberlo. Ver `clima.gs`.
  servidor.contarDondeEstoy();
  // La llave de voz, pedida ya: al pulsar Conversar no habra que esperar
  // los 2,5 segundos del viaje al Apps Script.
  adelantada = new Conversacion(servidor.pedir, avisar, asentar);
  adelantada.pedirLlaveConTiempo();
  subirApuntesAtrasados(true);   // al arrancar sí se anuncia

  // Abierta por el despertador: `…/?despertar`, o simplemente abierta a la
  // hora de despertarse. Ver `esHoraDeDespertar`.
  if (/[?&]despertar\b/.test(location.search) || esHoraDeDespertar()) {
    despertar();
  }
}

/**
 * Cuándo dar el informe sin que nadie lo pida.
 *
 * ## Por qué existe esto
 *
 * Lo limpio es que el despertador abra `…/?despertar`. Pero eso obliga a que
 * el programador del teléfono sepa abrir una DIRECCIÓN, y no todos pueden:
 * MacroDroid gratis no le da a Juan todas las acciones, y las rutinas que
 * trae Android abren *aplicaciones*, no enlaces.
 *
 * Así que se le quita el requisito: **si la app se abre a la hora de
 * levantarse un día laboral, y hoy no ha dado el informe, lo da.** Con eso
 * sirve cualquier cosa que abra la app — una rutina de Android, un acceso
 * directo, o el propio Juan tocando el icono.
 *
 * ## La ventana es estrecha a propósito
 *
 * Una hora, de 6:40 a 7:40. Fuera de ahí no pasa nada, porque si él abre ANI
 * a las diez para apuntar algo no quiere que le lea el clima. Y una sola vez
 * al día: si la abre dos veces seguidas, la segunda no repite.
 *
 * El día de la semana lo mira aquí por encima, pero **quien decide de verdad
 * es `despertar()`**, que le pregunta al servidor — y el servidor sabe de
 * festivos. Esto solo evita hacer la pregunta un domingo.
 */
function esHoraDeDespertar() {
  const ahora = new Date();
  const dia = ahora.getDay();
  if (dia === 0 || dia === 6) return false;

  const minutos = ahora.getHours() * 60 + ahora.getMinutes();
  if (minutos < 6 * 60 + 40 || minutos > 7 * 60 + 40) return false;

  const hoy = ahora.toISOString().slice(0, 10);
  if (localStorage.getItem('ani_ya_desperto') === hoy) return false;
  try { localStorage.setItem('ani_ya_desperto', hoy); } catch (e) { /* da igual */ }
  return true;
}

/**
 * Los apuntes que se dictaron sin señal, en cuanto la haya.
 *
 * Se intenta al arrancar y cada vez que el teléfono dice que volvió la
 * conexión. Lo de `online` no siempre es de fiar —a veces avisa antes de que
 * la red sirva de verdad— pero como al primer fallo se para y los apuntes se
 * quedan donde están, un aviso prematuro no cuesta nada.
 */
async function subirApuntesAtrasados(avisando = false) {
  if (!bitacoraLocal.cuantosEsperan()) return;
  const r = await bitacoraLocal.subirLoQueEspera(servidor.pedir);

  // Solo se anuncia cuando había apuntes ATASCADOS —al arrancar la app o al
  // volver la señal—. En el camino normal, apuntar y subir son lo mismo desde
  // fuera, y decirlo cada vez sería ruido en la conversación.
  if (avisando && r.subidos) {
    pintar('ani', r.subidos === 1
      ? 'Subí el apunte que tenía guardado sin señal.'
      : `Subí los ${r.subidos} apuntes que tenía guardados sin señal.`);
  }
}
window.addEventListener('online', () => subirApuntesAtrasados(true));

// Sin esto, en Android la barra de direcciones al aparecer y desaparecer
// cambia la altura y el chat da saltos.
const ajustarAlto = () => document.documentElement.style
  .setProperty('--alto', window.innerHeight + 'px');
window.addEventListener('resize', ajustarAlto);
ajustarAlto();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* da igual */ });
}

/* Arranca en reposo. No espera a que carguen los once: los tres primeros van
 * sin `lazy` y son los unicos que hacen falta para empezar. */
aniGesto('dormida');
