/**
 * La conversación con ANI: el WebSocket a la Live API de Gemini.
 *
 * Se habla el protocolo a pelo, sin el SDK de Google. Dos razones:
 *
 *   1. El SDK de JavaScript se instala con npm y trae un montón de cosas.
 *      Esta app se sirve desde GitHub Pages como archivos sueltos, sin paso
 *      de compilación. Menos piezas, menos que se rompa.
 *   2. El protocolo son cuatro mensajes. Escribirlos a mano cabe en este
 *      archivo y se lee entero.
 *
 * **La clave de Gemini no está aquí ni puede estarlo.** Lo que se usa es un
 * token efímero que pide el Apps Script: sirve una vez, un minuto para
 * abrir la sesión, y solo para la Live API. Ver `token.gs`.
 */

import { Microfono, Altavoz } from './microfono.js';
import { AQUI, seHaceAqui } from './aqui_mismo.js';

/**
 * La dirección de la Live API **para tokens efímeros**, que NO es la misma
 * que para una clave normal. Son tres diferencias y las tres son necesarias:
 *
 *   1. `v1alpha`, no `v1beta`
 *   2. `BidiGenerateContentConstrained`, no `BidiGenerateContent`
 *   3. el token va en `access_token`, no en `key`
 *
 * Cada una por separado devuelve un error distinto y ninguno dice cuál es el
 * problema: con `BidiGenerateContent` sale «Method doesn't allow unregistered
 * callers», con `?key=` sale «API key not valid», y con `v1beta` sale
 * «Missing or malformed auth token». Se dieron con las tres leyendo el SDK de
 * Python (`google/genai/live.py`), no la documentación.
 *
 * El SDK manda el token en una cabecera `Authorization: Token …`, pero un
 * navegador **no puede poner cabeceras en un WebSocket**. Por eso va en la
 * URL, que la API también acepta — y por eso el token es de un solo uso y de
 * un minuto: una URL se queda escrita en sitios, y esta caduca antes de que
 * eso importe.
 */
const CASA = 'wss://generativelanguage.googleapis.com/ws/'
           + 'google.ai.generativelanguage.v1alpha.GenerativeService.'
           + 'BidiGenerateContentConstrained';
const MODELO = 'models/gemini-3.1-flash-live-preview';

export class Conversacion {
  /**
   * @param {function(string,object=)} avisar  qué está pasando, para la interfaz
   * @param {function(string,string)}  decir   (quien, texto) para el chat
   */
  constructor(pedirAlServidor, avisar, decir) {
    this.pedirAlServidor = pedirAlServidor;
    this.avisar = avisar;
    this.decir = decir;
    this.ws = null;
    this.mic = null;
    this.altavoz = new Altavoz();
    this.encendida = false;
    // Dónde está el teléfono AHORA, para el clima sin preguntarle al
    // servidor. Lo pone la app al arrancar; si no hay, se usa Pasto.
    this.posicion = null;
    this.miTurno = '';       // lo que ANI lleva dicho en este turno
    this.suTurno = '';       // lo que Juan lleva dicho
  }

  async encender() {
    if (this.encendida) return;
    this.encendida = true;
    this.avisar('pidiendo permiso');

    // El micrófono PRIMERO. Si Juan va a decir que no al permiso, mejor
    // saberlo antes de gastar un token que solo vale un minuto.
    this.mic = new Microfono(
      (trozo) => this.mandarAudio(trozo),
      (nivel) => this.avisar('nivel', { nivel }));
    try {
      await this.mic.encender();
      await this.altavoz.preparar();
    } catch (e) {
      this.encendida = false;
      this.avisar('sin microfono', { detalle: String(e) });
      return;
    }

    this.avisar('abriendo');
    let llave;
    try {
      llave = await this.pedirAlServidor('token_de_voz', {});
      if (llave.error) throw new Error(llave.error);
    } catch (e) {
      await this.apagar();
      this.avisar('sin permiso', { detalle: String(e) });
      return;
    }

    // El token tiene UN MINUTO para abrir la sesión. De aquí al `onopen` no
    // puede haber nada lento en medio, y por eso el micrófono se pidió antes.
    this.abrirSocket(llave.token, llave.modelo);
  }

  abrirSocket(token, modelo) {
    this.ws = new WebSocket(`${CASA}?access_token=${encodeURIComponent(token)}`);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      // La voz, la identidad y las reglas ya vienen firmadas dentro del
      // token; aquí solo hace falta el modelo. Un `setup` vacío se rechaza
      // con un 1008 que no explica nada.
      this.ws.send(JSON.stringify({ setup: { model: modelo || MODELO } }));
    };

    this.ws.onmessage = (e) => this.recibir(e.data);

    this.ws.onerror = () => this.avisar('se cayo');

    this.ws.onclose = (e) => {
      const limpio = e.code === 1000 || !this.encendida;
      this.avisar(limpio ? 'dormida' : 'se cayo', { codigo: e.code });
      this.encendida = false;
      this.mic && this.mic.apagar();
      this.altavoz.callar();
    };
  }

  /**
   * Un trozo de micrófono hacia Gemini.
   *
   * Va en `audio`, NO en `mediaChunks`. Ese último está retirado y el
   * servidor no lo ignora: **cierra la conexión** con un 1007 al primer
   * trozo. Se veía como que ANI escuchaba un segundo y se cortaba, sin
   * ningún error a la vista.
   */
  mandarAudio(arrayBuffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      realtimeInput: {
        audio: {
          mimeType: 'audio/pcm;rate=16000',
          data: base64De(arrayBuffer),
        },
      },
    }));
  }

  async recibir(datos) {
    // La Live API contesta en JSON, pero a veces empaquetado como Blob.
    const texto = datos instanceof Blob ? await datos.text()
                : typeof datos === 'string' ? datos
                : new TextDecoder().decode(datos);
    let m;
    try { m = JSON.parse(texto); } catch (e) { return; }

    if (m.setupComplete) {
      this.avisar('escuchando');
      return;
    }

    // ANI pide una herramienta. Unas se hacen aquí mismo y otras van al
    // Apps Script; lo decide .
    if (m.toolCall) { this.atenderHerramientas(m.toolCall); return; }

    const sc = m.serverContent;
    if (!sc) return;

    // Juan interrumpió. Hay que callar YA lo que estaba agendado, o ANI
    // sigue hablando encima de él y no se entiende ninguno de los dos.
    if (sc.interrupted) {
      this.altavoz.callar();
      this.avisar('escuchando');
      return;
    }

    if (sc.inputTranscription && sc.inputTranscription.text) {
      this.suTurno += sc.inputTranscription.text;
      this.avisar('oyendo', { texto: this.suTurno });
    }

    if (sc.outputTranscription && sc.outputTranscription.text) {
      this.miTurno += sc.outputTranscription.text;
      this.avisar('hablando', { texto: this.miTurno });
    }

    const partes = (sc.modelTurn && sc.modelTurn.parts) || [];
    for (const p of partes) {
      if (p.inlineData && p.inlineData.data) {
        this.altavoz.encolar(bytesDe(p.inlineData.data));
      }
    }

    if (sc.turnComplete) {
      if (this.suTurno.trim()) this.decir('juan', this.suTurno.trim());
      if (this.miTurno.trim()) this.decir('ani', this.miTurno.trim());
      this.suTurno = this.miTurno = '';
      this.avisar('escuchando');
    }
  }

  /**
   * ANI pidió una o varias herramientas.
   *
   * Van todas a la vez, no una tras otra: mientras se espera, la
   * conversación está parada y Juan oyendo silencio. Dos consultas seguidas
   * de tres segundos son seis; en paralelo son tres.
   */
  async atenderHerramientas(toolCall) {
    const llamadas = toolCall.functionCalls || [];
    if (!llamadas.length) return;

    this.avisar('buscando', { que: llamadas.map((l) => l.name).join(', ') });

    const respuestas = await Promise.all(llamadas.map(async (l) => {
      let salida;
      const t0 = performance.now();
      const alServidor = () => this.pedirAlServidor('usar_herramienta',
        { nombre: l.name, argumentos: l.args || {} });

      try {
        // Primero se mira si esto se puede hacer aquí mismo. Lo que no
        // necesita la cuenta de Google de Juan ni una clave secreta no tiene
        // por qué costar dos segundos de viaje al servidor. Ver
        // `aqui_mismo.js`: ahí está medido y explicado.
        if (seHaceAqui(l.name)) {
          try {
            salida = await AQUI[l.name](l.args || {}, this.posicion);
          } catch (fallo) {
            // El teléfono no alcanzó el servicio: sin datos, mala cobertura,
            // o una red que lo bloquea. El servidor sale por otra red y a lo
            // mejor sí llega. No es hipotético: hubo un rato en que
            // open-meteo no era alcanzable desde una conexión y sí desde los
            // servidores de Google.
            console.warn(`${l.name} falló aquí (${fallo}); pruebo el servidor`);
            salida = await alServidor();
          }
        } else {
          salida = await alServidor();
        }
      } catch (e) {
        // Se le contesta SIEMPRE, aunque sea con el fallo. Si se deja sin
        // respuesta, la sesión se queda esperando y ANI enmudece.
        salida = { error: 'No pude consultarlo: ' + String(e).slice(0, 120) };
      }
      const tardo = Math.round(performance.now() - t0);
      console.log(`${l.name}: ${tardo} ms `
                  + `(${seHaceAqui(l.name) ? 'aquí' : 'servidor'})`);
      return { id: l.id, name: l.name, response: { result: salida } };
    }));

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      toolResponse: { functionResponses: respuestas },
    }));
  }

  silenciar(callado) {
    if (this.mic) this.mic.silenciar(callado);
  }

  async apagar() {
    this.encendida = false;
    if (this.ws) {
      try { this.ws.close(1000, 'hasta luego'); } catch (e) { /* ya cerrado */ }
      this.ws = null;
    }
    if (this.mic) { await this.mic.apagar(); this.mic = null; }
    await this.altavoz.cerrar();
    this.avisar('dormida');
  }
}

// ------------------------------------------------------- base64 y binario

function base64De(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  // De a trozos: pasarle 60.000 argumentos de golpe a `fromCharCode` revienta
  // la pila en los móviles, y un trozo de audio son justo ese orden.
  let s = '';
  const paso = 8192;
  for (let i = 0; i < bytes.length; i += paso) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + paso));
  }
  return btoa(s);
}

function bytesDe(base64) {
  const binario = atob(base64);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
  return bytes.buffer;
}
