/**
 * El fondo de constelaciones de ANI, adaptado al celular.
 *
 * Es el mismo `particulas.js` del panel del computador: las mismas tres capas
 * de profundidad, la misma deriva senoidal, los mismos destellos, pulsos
 * viajando por las conexiones y ondas al cambiar de estado. Y reacciona igual
 * a lo que ANI esté haciendo.
 *
 * ## Lo que cambia, y por qué no es capricho
 *
 * En el computador hay 200 partículas. Las conexiones se calculan comparando
 * cada una con todas las demás: **20.000 distancias por fotograma**, sesenta
 * veces por segundo. Un portátil ni se entera; un teléfono se calienta y se
 * queda sin batería en una hora.
 *
 * Aquí son ~70, que son 2.400 comparaciones — ocho veces menos trabajo. Se
 * nota poco porque la pantalla también es ocho veces más pequeña.
 *
 * Y tres cosas más que en un teléfono importan y en un escritorio no:
 *
 *   1. **Se para al esconder la app.** Sin esto sigue dibujando en segundo
 *      plano gastando batería para nadie.
 *   2. **Se para con la pantalla apagada**, por lo mismo.
 *   3. **Respeta «reducir movimiento»** de Android. Quien lo activa suele
 *      tener un motivo, y un fondo que serpentea es justo lo que le molesta.
 *
 * El `shadowBlur` se deja pero más bajo: es lo más caro de dibujar en un
 * móvil, y es también lo que separa un punto plano de una luz. Bajarlo a la
 * mitad se ve casi igual y cuesta la mitad.
 */

const ESTADOS = {
  dormida:    { color: [80, 200, 230], velocidad: 0.55, enlace: 95,  destello: 0.0010, pulso: 0.006 },
  escuchando: { color: [0, 255, 255],  velocidad: 1.00, enlace: 110, destello: 0.0030, pulso: 0.020 },
  pensando:   { color: [0, 255, 255],  velocidad: 2.10, enlace: 125, destello: 0.0075, pulso: 0.060 },
  hablando:   { color: [255, 165, 40], velocidad: 1.35, enlace: 115, destello: 0.0050, pulso: 0.035 },
};

// Los estados de la app no son los mismos nombres que los del fondo.
const EQUIVALE = {
  dormida: 'dormida',
  'pidiendo permiso': 'dormida',
  abriendo: 'pensando',
  escuchando: 'escuchando',
  oyendo: 'escuchando',
  hablando: 'hablando',
  buscando: 'pensando',
  'se cayo': 'dormida',
};

export class FondoParticulas {
  constructor(canvas) {
    this.lienzo = canvas;
    this.ctx = canvas.getContext('2d');
    this.particulas = [];
    this.pulsos = [];
    this.ondas = [];
    this.toque = { x: null, y: null, radio: 120 };
    this.estado = 'dormida';
    this.nivelVoz = 0;
    this.corriendo = false;
    this._mezcla = {
      color: [...ESTADOS.dormida.color],
      velocidad: ESTADOS.dormida.velocidad,
      enlace: ESTADOS.dormida.enlace,
    };
    this._t = 0;
    this._ultimo = 0;

    this.quieto = matchMedia('(prefers-reduced-motion: reduce)').matches;

    this._ajustar();
    // `resize` no salta en todos los casos que importan en un móvil —girar el
    // teléfono con la app instalada, por ejemplo—. El observador mira el
    // elemento y se entera siempre.
    if (window.ResizeObserver) {
      new ResizeObserver(() => this._ajustar()).observe(canvas);
    } else {
      addEventListener('resize', () => this._ajustar());
    }

    // Las partículas se apartan del dedo, como del ratón en el computador.
    // `passive` para no bloquear el desplazamiento del chat.
    canvas.addEventListener('touchmove', (e) => {
      const t = e.touches[0];
      if (t) { this.toque.x = t.clientX; this.toque.y = t.clientY; }
    }, { passive: true });
    canvas.addEventListener('touchend', () => {
      this.toque.x = this.toque.y = null;
    }, { passive: true });

    // Lo que de verdad salva la batería
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.parar(); else this.arrancar();
    });

    this.arrancar();
  }

  arrancar() {
    if (this.corriendo || this.quieto) {
      if (this.quieto) this._unaVez();     // un fotograma fijo, no negro
      return;
    }
    this.corriendo = true;
    this._animar();
  }

  parar() { this.corriendo = false; }

  cambiarEstado(nombre) {
    const cual = EQUIVALE[nombre] || 'dormida';
    if (!ESTADOS[cual] || cual === this.estado) return;
    this.estado = cual;
    this.ondas.push({ x: this.ancho / 2, y: this.alto / 2, r: 0, vida: 1 });
  }

  actualizarVoz(nivel) {
    this.nivelVoz = Math.max(0, Math.min(1, nivel));
  }

  /**
   * Ajusta el lienzo al hueco que el CSS le da.
   *
   * Se mide el ELEMENTO (`clientWidth`), no la ventana. El CSS ya lo estira
   * con `position:fixed; inset:0`, así que el elemento es la verdad y la
   * ventana solo una suposición. Poniéndole un tamaño en píxeles a partir de
   * `innerWidth` se puede quedar corto —pasó en las pruebas: lienzo de 321
   * con la ventana a 375— y entonces el fondo no llega a los bordes.
   *
   * En un teléfono esto pasa de verdad: al girarlo, al salir el teclado, o
   * al aparecer y desaparecer la barra de direcciones.
   */
  _ajustar() {
    // El dpr se topa a 2 aunque el teléfono diga 3 o 4: a partir de ahí no se
    // distingue y cada punto extra son cuatro píxeles más que pintar.
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.ancho = this.lienzo.clientWidth || innerWidth;
    this.alto = this.lienzo.clientHeight || innerHeight;
    this.lienzo.width = Math.round(this.ancho * dpr);
    this.lienzo.height = Math.round(this.alto * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._sembrar();
  }

  _sembrar() {
    // En el computador: área/12500 con tope 200. Aquí el doble de espaciadas
    // y tope 70, que es lo que aguanta un teléfono sin calentarse.
    const cuantas = Math.min(70, Math.floor((this.ancho * this.alto) / 9000));
    this.particulas = Array.from({ length: cuantas }, () => {
      const capa = Math.random() < 0.4 ? 0 : Math.random() < 0.7 ? 1 : 2;
      const escala = [0.8, 1.15, 1.7][capa];
      return {
        capa, escala,
        x: Math.random() * this.ancho,
        y: Math.random() * this.alto,
        r: (Math.random() * 1.5 + 0.6) * escala,
        vx: (Math.random() - 0.5) * 0.55 * escala,
        vy: (Math.random() - 0.5) * 0.55 * escala,
        op: (Math.random() * 0.5 + 0.28) * [0.9, 1, 1.08][capa],
        fase: Math.random() * Math.PI * 2,
        giro: (Math.random() - 0.5) * 0.024,
        destello: 0,
      };
    });
  }

  _interpolar() {
    const meta = ESTADOS[this.estado];
    const m = this._mezcla;
    const k = 0.045;
    for (let i = 0; i < 3; i++) m.color[i] += (meta.color[i] - m.color[i]) * k;
    m.velocidad += (meta.velocidad - m.velocidad) * k;
    m.enlace += (meta.enlace - m.enlace) * k;
  }

  /** Un solo fotograma, para cuando el teléfono pide no animar. */
  _unaVez() { this._pintar(); }

  /**
   * El bucle, limitado a 30 fotogramas por segundo.
   *
   * ## Por qué se limita
   *
   * Este bucle corre en el mismo hilo que encola el audio de ANI. A 60
   * fotogramas hace el doble de trabajo —2.400 comparaciones de distancia y
   * setenta halos por fotograma— y en un teléfono eso le quita tiempo a la
   * voz. Juan lo oyó: «su voz se oye entrecortada».
   *
   * A 30 el fondo se ve igual de fluido —son partículas que derivan
   * despacio, no un videojuego— y cuesta la mitad.
   */
  _animar() {
    if (!this.corriendo) return;
    requestAnimationFrame(() => this._animar());

    const ahora = performance.now();
    if (ahora - this._ultimo < 32) return;
    // Se avanza el reloj interno con el tiempo REAL, no con un paso fijo:
    // así la deriva va a la misma velocidad aunque se salten fotogramas.
    this._t += Math.min(0.1, (ahora - this._ultimo) / 1000);
    this._ultimo = ahora;

    this._interpolar();
    this._mover();
    this._pintar();
  }

  _mover() {
    const m = this._mezcla;
    const meta = ESTADOS[this.estado];
    const empuje = 1 + this.nivelVoz * 2.2;

    for (const p of this.particulas) {
      p.fase += p.giro;
      const deriva = Math.sin(this._t * 0.6 + p.fase) * 0.3 * p.escala;
      p.x += (p.vx + deriva) * m.velocidad * empuje;
      p.y += (p.vy - deriva * 0.5) * m.velocidad * empuje;

      if (p.x > this.ancho + 20) p.x = -20;
      else if (p.x < -20) p.x = this.ancho + 20;
      if (p.y > this.alto + 20) p.y = -20;
      else if (p.y < -20) p.y = this.alto + 20;

      if (this.toque.x !== null) {
        const dx = this.toque.x - p.x, dy = this.toque.y - p.y;
        const d = Math.hypot(dx, dy);
        if (d < this.toque.radio && d > 0) {
          const f = (this.toque.radio - d) / this.toque.radio;
          const a = Math.atan2(dy, dx);
          p.x -= Math.cos(a) * f * 2.6 * p.escala;
          p.y -= Math.sin(a) * f * 2.6 * p.escala;
        }
      }

      if (p.destello > 0) p.destello *= 0.94;
      else if (Math.random() < meta.destello) p.destello = 1;
    }
  }

  _pintar() {
    const { ctx } = this;
    const m = this._mezcla;
    const meta = ESTADOS[this.estado];
    const [r, g, b] = m.color.map(Math.round);

    ctx.clearRect(0, 0, this.ancho, this.alto);

    // ---- conexiones: lo que da el aire de constelación ----
    ctx.lineWidth = 0.85;
    const enlace = m.enlace;
    const nuevos = [];
    for (let i = 0; i < this.particulas.length; i++) {
      const a = this.particulas[i];
      for (let j = i + 1; j < this.particulas.length; j++) {
        const c = this.particulas[j];
        const dx = a.x - c.x, dy = a.y - c.y;
        // El descarte por caja va ANTES de la raíz cuadrada: la mayoría de
        // los pares están lejos y así ni se calcula la hipotenusa.
        if (Math.abs(dx) > enlace || Math.abs(dy) > enlace) continue;
        const d = Math.hypot(dx, dy);
        if (d >= enlace) continue;
        ctx.strokeStyle = `rgba(${r},${g},${b},${(1 - d / enlace) * 0.34})`;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(c.x, c.y);
        ctx.stroke();
        if (nuevos.length < 2 && Math.random() < meta.pulso * 0.012) {
          nuevos.push({ a, c, t: 0, vel: 0.02 + Math.random() * 0.03 });
        }
      }
    }
    if (this.pulsos.length < 14) this.pulsos.push(...nuevos);

    // ---- pulsos viajando por las conexiones ----
    ctx.shadowBlur = 8;
    ctx.shadowColor = `rgba(${r},${g},${b},.9)`;
    this.pulsos = this.pulsos.filter((p) => {
      p.t += p.vel;
      if (p.t >= 1) return false;
      ctx.fillStyle = `rgba(255,255,255,${Math.sin(p.t * Math.PI) * 0.85})`;
      ctx.beginPath();
      ctx.arc(p.a.x + (p.c.x - p.a.x) * p.t,
              p.a.y + (p.c.y - p.a.y) * p.t, 1.7, 0, Math.PI * 2);
      ctx.fill();
      return true;
    });

    // ---- ondas al cambiar de estado ----
    this.ondas = this.ondas.filter((o) => {
      o.r += 9;
      o.vida -= 0.012;
      if (o.vida <= 0) return false;
      ctx.strokeStyle = `rgba(${r},${g},${b},${o.vida * 0.28})`;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2);
      ctx.stroke();
      return true;
    });

    // ---- partículas ----
    for (const p of this.particulas) {
      const brillo = p.destello;
      const op = Math.min(1, p.op + brillo * 0.85);
      ctx.shadowBlur = 5 + p.capa * 2 + brillo * 14;
      ctx.shadowColor = `rgba(${r},${g},${b},${0.65 + brillo * 0.35})`;
      ctx.fillStyle = brillo > 0.25
        ? `rgba(255,255,255,${op})`
        : `rgba(${r},${g},${b},${op})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * (1 + brillo * 2.2), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  }
}
