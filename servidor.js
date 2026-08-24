/**
 * El enlace con el Apps Script: la única puerta de la app hacia fuera.
 *
 * Guarda la dirección y el secreto en el propio teléfono
 * (`localStorage`). Eso es lo que hay que entender bien:
 *
 *   - **El secreto vive en el celular de Juan**, protegido por la clave de
 *     bloqueo del teléfono, igual que su correo o su banco.
 *   - **La clave de Gemini NO está aquí.** Vive en el Apps Script; lo que
 *     llega a la app son tokens de un solo uso y un minuto.
 *   - Si el secreto se filtra, el daño está acotado a la lista cerrada de
 *     acciones de `seguridad.gs`. No hay ninguna de borrar.
 *   - Y se cambia en diez segundos desde Apps Script, sin tocar la app.
 */

const LLAVE_URL = 'ani_url';
const LLAVE_SECRETO = 'ani_secreto';

export function estaConfigurada() {
  return !!(localStorage.getItem(LLAVE_URL)
            && localStorage.getItem(LLAVE_SECRETO));
}

export function guardarAcceso(url, secreto) {
  localStorage.setItem(LLAVE_URL, url.trim());
  localStorage.setItem(LLAVE_SECRETO, secreto.trim());
}

export function olvidarAcceso() {
  localStorage.removeItem(LLAVE_URL);
  localStorage.removeItem(LLAVE_SECRETO);
}

/**
 * Le pide algo al Apps Script.
 *
 * Va por POST y con `redirect: follow`: Apps Script contesta con un 302
 * hacia `googleusercontent.com` y ahí es donde está el JSON. Sin seguir el
 * salto no llega nada, y es el error más típico al hablar con Apps Script
 * desde una página.
 */
export async function pedir(accion, datos = {}) {
  const url = localStorage.getItem(LLAVE_URL);
  const secreto = localStorage.getItem(LLAVE_SECRETO);
  if (!url || !secreto) throw new Error('ANI no está configurada todavía.');

  const r = await fetch(url, {
    method: 'POST',
    redirect: 'follow',
    // Apps Script no responde a la petición de comprobación previa que
    // dispara un `Content-Type: application/json`. Con `text/plain` el
    // navegador no la manda, y el script lee el cuerpo igual.
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ secreto, accion, datos }),
  });

  if (!r.ok) throw new Error(`El servidor respondió ${r.status}.`);

  const texto = await r.text();
  try {
    return JSON.parse(texto);
  } catch (e) {
    // Casi siempre significa que la sesión de Google caducó y Apps Script
    // devolvió una página de inicio de sesión en vez del JSON.
    throw new Error('El servidor contestó algo que no entiendo. '
                    + '¿Está bien la dirección?');
  }
}

/** Dónde está el teléfono, para el clima del informe de mañana. */
export function contarDondeEstoy() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      pedir('donde_estoy', {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
      }).catch(() => { /* que falle en silencio: es un extra */ });
    },
    () => { /* dijo que no al permiso, o no hay señal. Se usa el último */ },
    { timeout: 8000, maximumAge: 10 * 60 * 1000 });
}
