/**
 * Lo que ata la interfaz con ANI.
 *
 * ANI por Juan Guillermo Chaves · INGEOMAS
 */

import { Conversacion } from './ani.js';
import * as servidor from './servidor.js';

const $ = (id) => document.getElementById(id);
const ROTULO = {
  dormida: 'En reposo',
  'pidiendo permiso': 'Pidiendo el micrófono…',
  abriendo: 'Abriendo la línea…',
  escuchando: 'Escuchando',
  oyendo: 'Escuchando',
  hablando: 'Hablando',
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

function pintar(quien, texto, vivo = false) {
  $('vacio')?.remove();
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
    // El núcleo late con la voz. Es lo único que le dice a Juan que ANI lo
    // está oyendo de verdad, sin tener que mirar letra.
    const r = 15 + Math.min(1, extra.nivel * 2.2) * 11;
    $('pulso').setAttribute('r', r.toFixed(1));
    return;
  }

  $('estado').textContent = ROTULO[que] || que;

  if (que === 'oyendo') pintarVivo('juan', extra.texto);
  if (que === 'hablando') pintarVivo('ani', extra.texto);
  if (que === 'escuchando') cerrarBurbuja();

  if (que === 'dormida' || que === 'se cayo' || que.startsWith('sin ')) {
    cerrarBurbuja();
    $('conversar').classList.remove('viva');
    $('conversar').textContent = 'Conversar';
    $('btnSilencio').disabled = true;
    $('pulso').setAttribute('r', 15);
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
  // que sabe dónde anda: el disparador de las 4:40 corre en Google y desde
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
