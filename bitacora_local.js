/**
 * Los apuntes de obra que se dictaron sin señal.
 *
 * ## Por qué esto existe
 *
 * Juan trabaja en obra en Nariño, y ahí la señal no está garantizada. Sin
 * esto, decir «apunta que la columna tres quedó fundida» en un sitio sin
 * cobertura devolvía un error y **el apunte se perdía**. Justo el momento en
 * que más falta hace la bitácora es cuando menos se puede contar con la red.
 *
 * Así que si el servidor no contesta, el apunte se queda en el teléfono y
 * sube solo cuando vuelva la señal. Lo que ANI le dice a Juan cambia —«lo
 * tengo guardado aquí, lo subo cuando haya señal»— porque decirle que está en
 * la bitácora cuando no lo está sería peor que el error.
 *
 * ## La hora que se guarda es la de la obra, no la de la subida
 *
 * Un apunte hecho a las tres de la tarde en obra y subido a las ocho de la
 * noche en casa tiene que decir las tres. Por eso se guarda `cuando` y el
 * servidor lo respeta —ver `accionApuntarAtrasado_`, que además comprueba que
 * la fecha no sea disparatada, porque un celular puede tener el reloj mal.
 *
 * ## Vive en `localStorage` y no en memoria
 *
 * Porque el caso típico es exactamente ese: se queda sin señal, cierra la
 * app, y sigue trabajando. Si esto viviera en memoria, cerrar la app perdería
 * los apuntes — que es de lo que esto protege.
 */

const CAJON = 'ani_apuntes_sin_subir';

/**
 * Tope de apuntes guardados. Con más que esto, algo va mal —lleva semanas sin
 * señal, o la subida falla siempre— y seguir acumulando llenaría el
 * almacenamiento del teléfono en silencio.
 */
const TOPE = 200;

function leer() {
  try {
    const crudo = localStorage.getItem(CAJON);
    const lista = crudo ? JSON.parse(crudo) : [];
    return Array.isArray(lista) ? lista : [];
  } catch (e) {
    return [];                       // cajón corrupto: mejor vacío que roto
  }
}

function escribir(lista) {
  try {
    localStorage.setItem(CAJON, JSON.stringify(lista));
    return true;
  } catch (e) {
    // Almacenamiento lleno. Se dice que no se pudo, para que ANI no prometa
    // que lo guardó.
    console.warn('no cabe el apunte en el teléfono: ' + e);
    return false;
  }
}

/** Cuántos esperan a que vuelva la señal. */
export function cuantosEsperan() {
  return leer().length;
}

/**
 * Guarda un apunte que no se pudo subir.
 *
 * Devuelve lo que ANI le va a leer a Juan en voz alta. Que quede claro que
 * está en el teléfono y no en la bitácora todavía: sabiéndolo, si el apunte
 * es crítico puede buscarse un sitio con señal.
 */
/**
 * La última obra que nombró, recordada AQUÍ.
 *
 * Antes esto lo llevaba el servidor, y funcionaba mientras cada apunte pasaba
 * por él. Ahora los apuntes se guardan primero en el teléfono y suben después,
 * así que el servidor ya no ve el orden en que se dijeron — y sin esto se
 * perdería lo que hace que la bitácora sirva en obra: **decir la obra una vez
 * y que se quede.** En obra nadie repite el mismo dato veinte veces.
 */
const OBRA = 'ani_ultima_obra';

export function guardarSinSenal(nota, obra, donde) {
  const lista = leer();

  obra = String(obra || '').trim();
  if (obra) {
    try { localStorage.setItem(OBRA, obra); } catch (e) { /* da igual */ }
  } else {
    obra = localStorage.getItem(OBRA) || '';
  }

  lista.push({
    nota: String(nota || '').slice(0, 1000),
    obra: obra,
    donde: String(donde || ''),
    cuando: new Date().toISOString(),
  });
  while (lista.length > TOPE) lista.shift();

  if (!escribir(lista)) {
    return { error: 'No pude guardarlo: el teléfono no tiene espacio.' };
  }
  return {
    apuntado: true,
    obra: obra || null,
    esperando: lista.length,
    aviso: 'Sin señal. Lo tengo guardado aquí y lo subo apenas vuelva.',
  };
}

/** La obra en la que se está apuntando ahora mismo, si hay alguna. */
export function obraActual() {
  return localStorage.getItem(OBRA) || '';
}

/**
 * Sube lo que haya. Se llama al arrancar y cuando vuelve la conexión.
 *
 * Va **de uno en uno y en orden**, y para al primer fallo. En paralelo sería
 * más rápido, pero las filas quedarían desordenadas en la hoja, y una
 * bitácora de obra que no va en orden cronológico no se puede leer.
 *
 * Cada uno se borra solo cuando el servidor confirma. Si se borrara antes,
 * un fallo a mitad perdería el apunte — y no perderlos es todo el motivo de
 * que esto exista.
 */
export async function subirLoQueEspera(pedir) {
  let lista = leer();
  if (!lista.length) return { subidos: 0, quedan: 0 };

  let subidos = 0;
  while (lista.length) {
    const uno = lista[0];
    try {
      const r = await pedir('apuntar_atrasado', uno);
      if (!r || r.error) break;
    } catch (e) {
      break;                          // sigue sin haber señal: otra vez será
    }
    lista = leer().slice(1);          // se relee: pudo entrar otro entretanto
    escribir(lista);
    subidos++;
  }

  if (subidos) console.log(`bitácora: subidos ${subidos} apunte(s) atrasados`);
  return { subidos, quedan: lista.length };
}
