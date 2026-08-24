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
    this.siguiente = 0;
    this.sonando = [];
  }

  async preparar() {
    if (this.contexto) return;
    this.contexto = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: SALIDA_HZ,
    });
    if (this.contexto.state === 'suspended') await this.contexto.resume();
  }

  /** Un trozo de PCM 16 bits a 24 kHz, tal como llega de Gemini. */
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
    // Si la cola se vació (llegó tarde el siguiente trozo), se arranca un
    // pelo por delante del reloj para no cortar la sílaba en curso.
    if (this.siguiente < ahora) this.siguiente = ahora + 0.02;
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
    this.siguiente = 0;
  }

  async cerrar() {
    this.callar();
    if (this.contexto) await this.contexto.close();
    this.contexto = null;
  }
}
