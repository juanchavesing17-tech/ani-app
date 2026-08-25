/**
 * El micrófono, convertido a lo que la Live API exige.
 *
 * Gemini quiere PCM de 16 bits a 16.000 Hz, mono. El navegador entrega
 * `Float32` a la frecuencia que le dé la gana el teléfono —normalmente
 * 44.100 o 48.000—. Todo este archivo es esa traducción, hecha en un
 * *audio worklet* para que corra en el hilo de audio y no se corte cuando la
 * interfaz esté ocupada pintando.
 *
 * Se hace a mano y no con la conversión del navegador porque `AudioContext`
 * con `sampleRate: 16000` **no funciona en Android**: unos lo ignoran y
 * otros fallan al abrir el micrófono. Remuestrear aquí funciona en todos.
 */

// El worklet va como texto y se carga desde un Blob: así la app cabe en unos
// pocos archivos y se sirve desde GitHub Pages sin rutas raras.
const CODIGO_WORKLET = `
/**
 * Corre en el hilo de audio. Recibe bloques de Float32 a la frecuencia del
 * aparato y suelta Int16 a 16 kHz.
 */
class Remuestreador extends AudioWorkletProcessor {
  constructor(opciones) {
    super();
    this.destino = opciones.processorOptions.destino;   // 16000
    this.paso = sampleRate / this.destino;
    this.donde = 0;
    // Se acumulan ~64 ms antes de mandar. Trozos más chicos son más
    // llamadas y más batería; más grandes se oyen como retraso.
    this.tope = Math.round(this.destino * 0.064);
    this.buffer = new Int16Array(this.tope);
    this.llenos = 0;
  }

  process(entradas) {
    const canal = entradas[0] && entradas[0][0];
    if (!canal) return true;

    // Remuestreo lineal. Suena bien de sobra para voz, y es una resta y una
    // multiplicación por muestra: cabe en el hilo de audio sin sudar.
    while (this.donde < canal.length) {
      const i = Math.floor(this.donde);
      const resto = this.donde - i;
      const a = canal[i];
      const b = i + 1 < canal.length ? canal[i + 1] : a;
      const v = a + (b - a) * resto;

      // Float -1..1 a entero de 16 bits, recortando para que un grito no dé
      // la vuelta al número y suene a chasquido.
      const recortado = Math.max(-1, Math.min(1, v));
      this.buffer[this.llenos++] = recortado < 0
        ? recortado * 0x8000 : recortado * 0x7fff;

      if (this.llenos >= this.tope) {
        this.port.postMessage(this.buffer.slice(0, this.llenos).buffer);
        this.llenos = 0;
      }
      this.donde += this.paso;
    }
    this.donde -= canal.length;
    return true;
  }
}
registerProcessor('remuestreador', Remuestreador);
`;

export const ENTRADA_HZ = 16000;
export const SALIDA_HZ = 24000;

/**
 * Cuánto audio se acumula antes de empezar a sonar. **Se ajusta solo.**
 *
 * ## Por qué no es un número fijo
 *
 * Se probaron dos a ojo y los dos se quedaron cortos: 20 ms al principio, y
 * luego 180. Con 180, el medidor de Juan dio **4 huecos en una conversación**
 * — cuatro cortes audibles.
 *
 * El problema de elegirlo a ojo es que depende de la red de ese momento: en
 * la oficina con WiFi sobran 100 ms y en obra con 4G flojo no bastan 300. Un
 * número fijo o se queda corto o mete retraso para nada.
 *
 * ## Y por qué crece Y ENCOGE
 *
 * La primera versión solo crecía, y salió mal: el medidor de Juan pasó de 4
 * huecos a 16, y ANI se volvía más lenta cuanto más se hablaba con ella. La
 * causa no era la red — era que **lo que se contaba como hueco no lo era**.
 * Ver {@link Altavoz#encolar}.
 *
 * Arreglada la cuenta, hacía falta lo otro: que un mal rato de red no deje el
 * colchón inflado el resto de la conversación. Sube {@link CRECE} con cada
 * corte de verdad y baja {@link ENCOGE} por cada frase que salga limpia.
 *
 * El precio de un colchón grande es retraso al empezar cada frase. Por eso
 * hay tope: pasado medio segundo la conversación se siente lenta, y es peor
 * el remedio que la enfermedad.
 */
const COLCHON_MINIMO = 0.2;
const COLCHON_MAXIMO = 0.6;
const CRECE = 0.08;
const ENCOGE = 0.02;

/**
 * Si el trozo anterior llegó hace más de esto, el silencio **no es culpa de
 * la red**: es que ANI se calló a propósito —fue a usar una herramienta, o
 * terminó de hablar—. Sin esta comprobación, cada pausa normal contaría como
 * corte y el colchón crecería por nada.
 */
const SILENCIO_QUE_NO_ES_HUECO = 1.0;

export class Microfono {
  constructor(alTrozo, alNivel) {
    this.alTrozo = alTrozo;       // (ArrayBuffer) => void, PCM 16 kHz
    this.alNivel = alNivel;       // (0..1) para pintar la onda
    this.contexto = null;
    this.flujo = null;
    this.nodo = null;
    this.silenciado = false;
  }

  async encender() {
    this.flujo = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,     // sin esto ANI se oye a sí misma
        noiseSuppression: true,     // en obra hace falta
        autoGainControl: true,
      },
    });

    this.contexto = new (window.AudioContext || window.webkitAudioContext)();
    // Los navegadores arrancan el audio en pausa hasta que hay un gesto del
    // usuario. Como esto se llama desde el botón, aquí ya se puede.
    if (this.contexto.state === 'suspended') await this.contexto.resume();

    const url = URL.createObjectURL(
      new Blob([CODIGO_WORKLET], { type: 'application/javascript' }));
    try {
      await this.contexto.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    const fuente = this.contexto.createMediaStreamSource(this.flujo);
    this.nodo = new AudioWorkletNode(this.contexto, 'remuestreador', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: { destino: ENTRADA_HZ },
    });

    this.nodo.port.onmessage = (e) => {
      if (this.silenciado) return;
      this.alTrozo(e.data);
      if (this.alNivel) this.alNivel(nivelDe(new Int16Array(e.data)));
    };

    fuente.connect(this.nodo);
  }

  silenciar(callado) { this.silenciado = callado; }

  async apagar() {
    if (this.nodo) { this.nodo.port.onmessage = null; this.nodo.disconnect(); }
    if (this.flujo) this.flujo.getTracks().forEach((t) => t.stop());
    if (this.contexto) await this.contexto.close();
    this.contexto = this.flujo = this.nodo = null;
  }
}

/** Cuánto suena, de 0 a 1. Solo para la animación. */
function nivelDe(muestras) {
  let suma = 0;
  for (let i = 0; i < muestras.length; i++) suma += muestras[i] * muestras[i];
  return Math.min(1, Math.sqrt(suma / muestras.length) / 8000);
}

/**
 * El altavoz. Encola lo que va llegando y lo suelta seguido.
 *
 * Hace falta una cola porque la Live API manda el audio en trocitos según lo
 * genera: reproducirlos sueltos con `new Audio()` deja huecos audibles entre
 * uno y otro. Aquí cada trozo se agenda justo donde acaba el anterior.
 */
export class Altavoz {
  constructor() {
    this.contexto = null;
    // 0 quiere decir «no hay ninguna frase sonando ahora mismo». Es lo que
    // distingue empezar a hablar de quedarse sin audio a mitad.
    this.siguiente = 0;
    this.sonando = [];
    // Cortes de VERDAD: la cola se vació mientras ANI seguía hablando. Es la
    // medida de si el colchón alcanza. Ver `encolar`.
    this.huecos = 0;
    // Se ajusta solo, arriba y abajo. Ver el comentario de COLCHON_MINIMO.
    this.colchon = COLCHON_MINIMO;
    this.ultimoTrozo = 0;
    this.huboCorteEnEsta = false;
  }

  /**
   * ANI empieza otra frase. Lo llama `ani.js` al cerrarse cada turno.
   *
   * Hace falta que alguien lo diga desde fuera: desde aquí dentro, «la cola
   * está vacía porque acabó la frase» y «la cola está vacía porque un trozo
   * viene tarde» **se ven exactamente igual**, y confundirlas fue justo el
   * fallo que hizo que ANI se frenara sola.
   */
  nuevaFrase() {
    // La frase anterior salió entera: la red va bien y se puede devolver
    // parte del retraso. Sin esto, un mal rato deja el colchón inflado el
    // resto de la conversación.
    if (!this.huboCorteEnEsta) {
      this.colchon = Math.max(COLCHON_MINIMO, this.colchon - ENCOGE);
    }
    this.huboCorteEnEsta = false;
    this.siguiente = 0;
  }

  async preparar() {
    if (this.contexto) return;
    this.contexto = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: SALIDA_HZ,
    });
    if (this.contexto.state === 'suspended') await this.contexto.resume();
  }

  /**
   * Un trozo de PCM 16 bits a 24 kHz, tal como llega de Gemini.
   *
   * ## El colchón, que es lo que evita que la voz suene entrecortada
   *
   * Los trozos llegan por internet y **no llegan a ritmo constante**: la red
   * del celular tiene jitter, y sobre todo en obra. Si se empiezan a
   * reproducir en cuanto llega el primero, el segundo que se retrase deja un
   * hueco de silencio audible. Y luego el tercero. Eso es exactamente lo que
   * Juan describió como «su voz se oye entrecortada».
   *
   * La primera versión daba **20 milisegundos** de margen. Es nada: cualquier
   * variación normal de una red móvil se lo come.
   *
   * Ahora se espera a tener {@link COLCHON} de audio acumulado antes de
   * empezar a soltarlo. Ese retraso se paga UNA vez al principio de cada
   * frase, y a cambio la frase entera sale seguida.
   *
   * No se pone más grande porque el retraso sí se nota al conversar: es el
   * tiempo entre que ANI empieza a generar y Juan la empieza a oír.
   */
  encolar(arrayBuffer) {
    if (!this.contexto) return;
    const enteros = new Int16Array(arrayBuffer);
    if (!enteros.length) return;

    const buf = this.contexto.createBuffer(1, enteros.length, SALIDA_HZ);
    const canal = buf.getChannelData(0);
    for (let i = 0; i < enteros.length; i++) canal[i] = enteros[i] / 32768;

    const fuente = this.contexto.createBufferSource();
    fuente.buffer = buf;
    fuente.connect(this.contexto.destination);

    const ahora = this.contexto.currentTime;
    const desdeElUltimo = ahora - this.ultimoTrozo;
    this.ultimoTrozo = ahora;

    if (this.siguiente < ahora) {
      // La cola está vacía. Ahora hay que decidir POR QUÉ, porque las dos
      // razones piden cosas opuestas y confundirlas ya salió caro:
      //
      //   - Si es el principio de una frase, esto es lo normal y no hay nada
      //     que arreglar. La versión anterior lo contaba como corte, así que
      //     contaba turnos en vez de fallos: 16 «huecos» en una conversación
      //     de 16 turnos. Y con cada uno inflaba el colchón, de modo que ANI
      //     se iba frenando cuanto más se hablaba con ella.
      //
      //   - Si es a mitad de una frase, un trozo llegó tarde. ESO es un corte
      //     audible y es lo que hay que compensar.
      //
      // `siguiente` en cero solo lo pone `nuevaFrase()` o `callar()`. Y aun
      // así se mira el reloj: tras una pausa larga ANI estaba callada a
      // propósito, no esperando a la red.
      const empiezaFrase = this.siguiente === 0
                        || desdeElUltimo > SILENCIO_QUE_NO_ES_HUECO;

      if (!empiezaFrase) {
        this.huecos++;
        this.huboCorteEnEsta = true;
        this.colchon = Math.min(COLCHON_MAXIMO, this.colchon + CRECE);
      }

      // En los dos casos se rehace el colchón entero: arrancar pegado al
      // reloj deja que el siguiente retraso vuelva a cortar, y de ahí se
      // entra en un tartamudeo que ya no para.
      this.siguiente = ahora + this.colchon;
    }
    fuente.start(this.siguiente);
    this.siguiente += buf.duration;

    this.sonando.push(fuente);
    fuente.onended = () => {
      this.sonando = this.sonando.filter((f) => f !== fuente);
    };
  }

  /**
   * Callar de golpe. Es lo que se hace cuando Juan interrumpe: la Live API
   * avisa de que lo interrumpieron y lo que ya se agendó hay que tirarlo, o
   * ANI sigue hablando encima de él.
   */
  callar() {
    this.sonando.forEach((f) => { try { f.stop(); } catch (e) { /* ya paró */ } });
    this.sonando = [];
    // Lo que venga después es una frase nueva, no la continuación de esta.
    this.siguiente = 0;
    this.huboCorteEnEsta = false;
  }

  async cerrar() {
    this.callar();
    if (this.contexto) await this.contexto.close();
    this.contexto = null;
  }
}
