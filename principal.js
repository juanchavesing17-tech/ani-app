/**
 * Lo que ata la interfaz con ANI.
 *
 * ANI por Juan Guillermo Chaves · INGEOMAS
 */

import { Conversacion } from './ani.js';
import { FondoParticulas } from './particulas.js';
import * as servidor from './servidor.js';

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
 * que lo hace la tarjeta gráfica y no cuesta batería. Estas cinco barras sí
 * tienen que seguir lo que se está oyendo.
 */
function pintarOndas(nivel) {
  const g = $('ondas');
  if (!g) return;
  const alto = Math.max(2, Math.min(1, nivel * 3) * 26);
  let d = '';
  for (let i = 0; i < 5; i++) {
    // Las de en medio más altas que las de los lados: así parece una voz y
    // no un ecualizador de cinco palos iguales.
    const h = Math.max(2, alto * [0.45, 0.8, 1, 0.8, 0.45][i]
                          * (0.75 + Math.random() * 0.5));
    d += `<rect x="${186 + i * 7}" y="${232 - h / 2}" width="3.4" `
       + `height="${h.toFixed(1)}" rx="1.7"/>`;
  }
  g.innerHTML = d;
}

/** Al primer mensaje el núcleo se aparta para dejar leer. */
function encogerNucleo() {
  $('nucleo')?.classList.add('chico');
}

function pintar(quien, texto, vivo = false) {
  $('vacio')?.remove();
  encogerNucleo();
  const chat = $('chat');
  const div = document.createElement('div');
  div.className = `dicho ${quien === 'juan' ? 'de-juan' : 'de-ani'}`
                + (vivo ? ' vivo' : '');
  div.textContent = texto;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div;
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

function avisar(que, extra = {}) {
  if (que === 'nivel') {
    // El núcleo late con la voz. Es lo que le dice a Juan que ANI lo está
    // oyendo de verdad, sin tener que mirar letra.
    $('pulso').setAttribute('r',
      (78 + Math.min(1, extra.nivel * 2.2) * 9).toFixed(1));
    pintarOndas(extra.nivel);
    fondo.actualizarVoz(extra.nivel);
    return;
  }

  $('estado').textContent = ROTULO[que] || que;
  fondo.cambiarEstado(que);

  // Cuando ANI propone algo que sale hacia fuera, la tarjeta aparece sola:
  // no hay que acordarse de mirar.
  if (que === 'escuchando') mirarSiHayPendiente();

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

  charla = new Conversacion(servidor.pedir, avisar, asentar);
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
$('btnInforme').onclick = async () => {
  $('aviso').textContent = '';
  if (!servidor.estaConfigurada()) { abrirAjustes(); return; }

  $('estado').textContent = 'Trayendo el informe…';
  try {
    const r = await servidor.pedir('hablado_de_hoy', {});
    if (!r.hay || !r.fresco) {
      // Antes que decir algo desactualizado, se pide el de ahora mismo.
      const ahora = await servidor.pedir('despertador', { con_voz: false });
      pintar('ani', ahora.texto || r.motivo || 'No pude traer el informe.');
      $('estado').textContent = 'En reposo';
      return;
    }
    pintar('ani', r.texto);
    if (r.audio) sonar(r.audio);
  } catch (e) {
    $('aviso').textContent = String(e).replace(/^Error:\s*/, '');
  }
  $('estado').textContent = 'En reposo';
};

function sonar(base64) {
  const audio = new Audio('data:audio/wav;base64,' + base64);
  $('estado').textContent = 'Hablando';
  audio.onended = () => { $('estado').textContent = 'En reposo'; };
  audio.play().catch(() => {
    // Sin gesto del usuario el navegador no deja sonar. Aquí sí lo hay
    // —pulsó el botón—, pero si algún día no, que se sepa por qué.
    $('aviso').textContent = 'Toque otra vez para oírlo.';
  });
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

// ---------------------------------------------------------- los ajustes

function abrirAjustes() {
  $('url').value = localStorage.getItem('ani_url') || '';
  $('secreto').value = '';
  $('ajustes').classList.add('abierta');
}

$('btnAjustes').onclick = abrirAjustes;

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
}

// Sin esto, en Android la barra de direcciones al aparecer y desaparecer
// cambia la altura y el chat da saltos.
const ajustarAlto = () => document.documentElement.style
  .setProperty('--alto', window.innerHeight + 'px');
window.addEventListener('resize', ajustarAlto);
ajustarAlto();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* da igual */ });
}
