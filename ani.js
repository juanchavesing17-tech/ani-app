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
import { guardarSinSenal } from './bitacora_local.js';

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
    // Lo que dice Juan mientras la sesion se abre. Ver mandarAudio().
    this.esperando = [];
    // La llave, pedida por adelantado. Ver pedirLlaveConTiempo().
    this.llavePedida = null;
    this.miTurno = '';       // lo que ANI lleva dicho en este turno
    this.suTurno = '';       // lo que Juan lleva dicho

    /**
     * Lo que pasa de verdad, contado.
     *
     * Existe porque llevo dos intentos arreglando «la voz se entrecorta» a
     * ciegas: primero la red, luego el trabajo del hilo principal. Los dos
     * eran problemas reales, y ninguno era EL problema.
     *
     * Desde el computador no se puede oír el teléfono de Juan. Esto es lo
     * más cerca: que la app cuente qué le está pasando y él lo lea.
     *
     *   interrupciones — Gemini creyó que Juan hablaba y mandó parar. Si
     *                    esto sube mientras ANI habla sola, el ruido la
     *                    está cortando y no es la red.
     *   huecos         — la cola de audio se vació esperando el siguiente
     *                    trozo. Eso SÍ es la red.
     */
    this.cuenta = {
      interrupciones: 0, huecos: 0, trozos: 0,
      msHastaAbrir: 0, msHastaLaPrimeraPalabra: 0, msDeVozRescatada: 0,
      // La consulta que más hizo esperar, y cuánto de eso fue el servidor.
      peorHerramienta: '', msPeorHerramienta: 0, msPeorEnServidor: 0,
      _pedido: 0, _dejoDeHablar: 0,
    };
  }

  /**
   * Pide la llave ANTES de que Juan pulse Conversar.
   *
   * El medidor dio **2.509 ms** entre pulsar y poder oírle, y casi todo era
   * esto: la ida y vuelta al Apps Script para pedir el token. Apps Script
   * arranca en frío en cada petición, y eso no se puede acelerar desde aquí.
   *
   * Pero sí se puede hacer antes. Se pide al abrir la app, y cuando Juan
   * pulsa ya está esperando.
   *
   * **El token dura media hora**, así que pedirlo con antelación no lo
   * estropea. Lo que sí tiene un minuto es el plazo para ABRIR la sesión con
   * él — por eso esto se vuelve a pedir al cabo de un rato, y por eso no se
   * pide nada más arrancar, sino cuando la app lleva un momento abierta.
   */
  pedirLlaveConTiempo() {
    if (this.encendida) return;          // ya está hablando: no hace falta
    this.llavePedida = this.pedirAlServidor('token_de_voz', {})
      .catch(() => null);

    // Un token de hace casi un minuto ya no sirve para ABRIR. La primera
    // versión lo tiraba y no pedía otro, así que quien dejara la app abierta
    // un rato pagaba los 2,5 segundos completos — que es justo lo que midió
    // Juan: 519 ms cuando la llave estaba fresca, 2.565 cuando ya no.
    //
    // Así que en vez de tirarla, se renueva.
    clearTimeout(this.relevo);
    this.relevo = setTimeout(() => this.pedirLlaveConTiempo(), 45000);
  }

  /** Al colgar, que deje de pedir llaves para una conversación que no hay. */
  dejarDePedirLlaves() {
    clearTimeout(this.relevo);
    this.relevo = null;
    this.llavePedida = null;
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
    this.cuenta._pedido = performance.now();
    let llave;
    try {
      // Si ya se pidió por adelantado, aquí no se espera nada. Ver
      // `pedirLlaveConTiempo()`: son los 2,5 segundos que midió Juan entre
      // pulsar Conversar y que ANI pudiera oírle.
      llave = await (this.llavePedida
                     || this.pedirAlServidor('token_de_voz', {}));
      this.dejarDePedirLlaves();
      // El servidor dice cuánto tardó ÉL, y cuánto de eso fue Gemini. Lo que
      // no cuadre con lo que mide el teléfono es arranque en frío de Apps
      // Script y red — que no se pueden tocar desde aquí, y por eso importa
      // saber cuánto son antes de intentar arreglar nada. Ver `seguridad.gs`.
      this.cuenta.msServidor = llave._ms || 0;
      this.cuenta.msGemini = llave._ms_gemini || 0;
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
    // Hasta que Gemini confirme el setup, la sesion NO acepta audio.
    this.lista = false;
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
      this.lista = false;
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
    // La sesión todavía no está abierta: se GUARDA en vez de tirarlo.
    //
    // Esto es lo que hacía que ANI «se demorara en escuchar». Entre que Juan
    // pulsa Conversar y la sesión queda abierta pasan un par de segundos —el
    // token al Apps Script, el WebSocket, el setup— y el micrófono ya está
    // grabando desde el primer instante. Antes, todo lo que dijera en ese
    // rato se perdía: tenía que repetirlo, y parecía que ANI tardaba en
    // oírle.
    //
    // Ahora se guarda y se suelta de golpe en cuanto la sesión abre.
    // Se espera a `setupComplete`, NO a que el socket esté abierto.
    //
    // Esa diferencia es el fallo que hacía que a veces ANI abriera la línea,
    // se quedara escuchando y no contestara nunca. El socket queda `OPEN` en
    // cuanto conecta, pero la sesión no está lista hasta que Gemini confirma
    // el `setup` — y entre una cosa y otra pasan décimas de segundo en las
    // que el micrófono ya está soltando un trozo cada 64 ms.
    //
    // La Live API exige que no llegue nada antes del `setupComplete`. Si le
    // cae audio en esa rendija, la sesión queda inservible: abierta,
    // escuchando, muda. Y era intermitente porque dependía de si en ese
    // instante había voz o ruido.
    if (!this.lista) {
      this.esperando.push(arrayBuffer);
      // Tope de unos 3 segundos. Más atrás no interesa: si abrir tardó tanto,
      // lo que dijo al principio ya no viene a cuento, y mandarlo entero
      // sería empezar la conversación con un turno viejo.
      if (this.esperando.length > 47) this.esperando.shift();
      return;
    }
    this.enviarTrozo(arrayBuffer);
  }

  enviarTrozo(arrayBuffer) {
    this.ws.send(JSON.stringify({
      realtimeInput: {
        audio: {
          mimeType: 'audio/pcm;rate=16000',
          data: base64De(arrayBuffer),
        },
      },
    }));
  }

  /** Lo que Juan dijo mientras la línea se abría. */
  soltarLoGuardado() {
    if (!this.esperando.length) return;
    this.cuenta.msDeVozRescatada =
      Math.round(this.esperando.length * 64);
    for (const trozo of this.esperando) {
      try { this.enviarTrozo(trozo); } catch (e) { break; }
    }
    this.esperando = [];
  }

  async recibir(datos) {
    // La Live API contesta en JSON, pero a veces empaquetado como Blob.
    const texto = datos instanceof Blob ? await datos.text()
                : typeof datos === 'string' ? datos
                : new TextDecoder().decode(datos);
    let m;
    try { m = JSON.parse(texto); } catch (e) { return; }

    if (m.setupComplete) {
      // Desde AQUI se puede mandar audio, no desde que abrio el socket.
      this.lista = true;
      this.cuenta.msHastaAbrir =
        Math.round(performance.now() - this.cuenta._pedido);
      this.soltarLoGuardado();
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
      this.cuenta.interrupciones++;
      this.altavoz.callar();
      this.avisar('escuchando');
      return;
    }

    if (sc.inputTranscription && sc.inputTranscription.text) {
      // Cada trozo de transcripcion marca que Juan SIGUE hablando. El
      // ultimo que llegue es, por tanto, cuando se callo — y es desde ahi
      // desde donde hay que medir lo que tarda ANI en contestar.
      this.cuenta._dejoDeHablar = performance.now();
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
        if (!this.cuenta.trozos && this.cuenta._dejoDeHablar) {
          this.cuenta.msHastaLaPrimeraPalabra =
            Math.round(performance.now() - this.cuenta._dejoDeHablar);
          // Y se consume. Sin esto, un turno en el que ANI hable sin que Juan
          // haya dicho nada —al volver de una herramienta, por ejemplo— se
          // mediría desde la última vez que él habló, que pueden ser minutos.
          // Así salieron 48.856 ms en una conversación que iba bien.
          //
          // Es la tercera vez que uno de estos contadores miente. La regla
          // que faltaba: un cronómetro se para cuando se lee, no se queda
          // corriendo a la espera de que alguien lo mire.
          this.cuenta._dejoDeHablar = 0;
        }
        this.cuenta.trozos++;
        this.altavoz.encolar(bytesDe(p.inlineData.data));
      }
    }

    if (sc.turnComplete) {
      // Se reinicia la cuenta de trozos: la espera se mide por turno, no
      // acumulada, que es lo que Juan nota.
      this.cuenta.trozos = 0;
      // Lo que llegue a partir de aquí es una frase NUEVA. Sin este aviso,
      // el altavoz no puede distinguir «empieza a hablar» de «se quedó sin
      // audio a mitad», y cuenta un corte en cada turno. Ver `microfono.js`.
      this.altavoz.nuevaFrase();
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
        // APUNTAR NO HACE ESPERAR. Se guarda en el teléfono y se contesta al
        // instante; la subida a la hoja va por detrás.
        //
        // El medidor de Juan lo puso en números: `apuntar_en_bitacora` tardaba
        // 3.046 ms, de los cuales 1.716 eran el viaje del servidor a Sheets.
        // Eso es mucho rato callado para alguien que está en obra con las
        // manos ocupadas y solo quería dejar una nota.
        //
        // No es una promesa a la ligera: la cola ya guarda de forma duradera,
        // reintenta, mantiene el orden y **no borra nada hasta que el servidor
        // confirma**. Lo que cambia es la garantía —«va a estar en la hoja» en
        // vez de «ya está»— y eso se ve en ajustes, que dice cuántos esperan.
        // Es lo contrario del fallo de ayer, donde se perdía en silencio.
        if (l.name === 'apuntar_en_bitacora') {
          const a = l.args || {};
          salida = guardarSinSenal(a.nota, a.obra,
                                   this.posicion && this.posicion.nombre);
          if (!salida.error) {
            // La obra sale de la cola, que es quien recuerda la última que
            // nombró — no de lo que ANI acabe de decir. Ver `bitacora_local`.
            const donde = salida.obra;
            salida = { apuntado: true, obra: donde,
                       aviso: donde ? 'Apuntado en ' + donde + '.'
                                    : 'Apuntado.' };
            // Se dispara la subida, pero no se espera: eso es todo el punto.
            this.avisar('subir bitacora');
          }
        } else if (seHaceAqui(l.name)) {
          // Lo que no necesita la cuenta de Google de Juan ni una clave
          // secreta no tiene por qué costar dos segundos de viaje al
          // servidor. Ver `aqui_mismo.js`: ahí está medido y explicado.
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
        //
        // Apuntar ya no puede llegar aquí: no pasa por el servidor. Va a la
        // cola del teléfono y sube después, así que la falta de señal dejó de
        // ser un caso especial y pasó a ser el camino normal.
        salida = { error: 'No pude consultarlo: ' + String(e).slice(0, 120) };
      }
      const tardo = Math.round(performance.now() - t0);
      console.log(`${l.name}: ${tardo} ms `
                  + `(${seHaceAqui(l.name) ? 'aquí' : 'servidor'})`);

      // La herramienta más lenta del rato, para el medidor. Hasta ahora solo
      // se desglosaba la apertura, y las herramientas son lo que se siente
      // lento EN MEDIO de la conversación: son las que hacen que ANI se quede
      // callada mientras Juan espera.
      // `>` a secas dejaba fuera la PRIMERA, porque compararla contra cero da
      // falso cuando tarda cero. Y en una conversación con una sola consulta,
      // esa primera es justo la que interesa.
      if (!this.cuenta.peorHerramienta || tardo > this.cuenta.msPeorHerramienta) {
        this.cuenta.peorHerramienta = l.name;
        this.cuenta.msPeorHerramienta = tardo;
        this.cuenta.msPeorEnServidor = (salida && salida._ms) || 0;
      }

      // Y las medidas NO viajan a Gemini.
      //
      // `responder_` le pega `_ms` a toda respuesta del servidor, y esto se
      // le pasa al modelo tal cual. O sea que en cada turno ANI recibía un
      // `_ms: 234` que no significa nada para ella: tokens gastados en
      // fontanería de medición, y un dato de más que puede acabar
      // mencionando. Se queda aquí, que es donde sirve.
      salida = sinLasMedidas(salida);

      // Una herramienta puede pedir que la app HAGA algo, no solo que
      // conteste. Y hasta ahora no se hacía: `poner_musica` resolvía el vídeo
      // de YouTube, devolvía el enlace, ANI decía «ya la puse»… y no pasaba
      // nada, porque en toda la app no había una línea que abriera una URL.
      // Que ANI diga que hizo algo que no hizo es lo peor que puede pasar.
      if (salida && salida.url) this.avisar('abrir', { url: salida.url });
      // Y solo se pregunta por propuestas pendientes si acaba de haber una.
      // Antes se preguntaba al final de CADA turno: un viaje al Apps Script
      // —dos segundos— que el 95% de las veces no traía nada.
      if (salida && salida.propuesto) this.avisar('hay propuesta');

      return { id: l.id, name: l.name, response: { result: salida } };
    }));

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      toolResponse: { functionResponses: respuestas },
    }));
  }

  /** Lo medido, para enseñarlo en la pantalla. */
  comoVa() {
    return Object.assign({}, this.cuenta,
                         { huecos: this.altavoz ? this.altavoz.huecos : 0 });
  }

  silenciar(callado) {
    if (this.mic) this.mic.silenciar(callado);
  }

  async apagar() {
    this.encendida = false;
    // Se apaga aquí y no solo en `onclose`: colgar y volver a llamar enseguida
    // podría pillar la bandera encendida de la sesión anterior, y entonces el
    // audio saldría antes del `setup` de la nueva.
    this.lista = false;
    if (this.ws) {
      try { this.ws.close(1000, 'hasta luego'); } catch (e) { /* ya cerrado */ }
      this.ws = null;
    }
    if (this.mic) { await this.mic.apagar(); this.mic = null; }
    await this.altavoz.cerrar();
    this.avisar('dormida');
  }
}

/**
 * La respuesta sin la fontanería de medición.
 *
 * Lo que va a Gemini tiene que ser lo que la herramienta averiguó, y nada
 * más. Un `_ms` colado ahí son tokens en cada turno y un dato que ANI podría
 * acabar diciendo en voz alta.
 */
function sinLasMedidas(salida) {
  if (!salida || typeof salida !== 'object') return salida;
  const limpia = {};
  for (const k of Object.keys(salida)) {
    if (!k.startsWith('_ms')) limpia[k] = salida[k];
  }
  return limpia;
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
