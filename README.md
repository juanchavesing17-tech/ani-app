# ANI de campo — la app

> ANI por Juan Guillermo Chaves · INGEOMAS

La asistente de Juan en el celular. Se habla con ella por voz, trae el
informe del día, y se instala en la pantalla de inicio como una app.

## Este repositorio es público a propósito, y no hay nada secreto dentro

Se puede leer entero. **No contiene ninguna credencial**, y no es un
descuido: es el diseño.

- La **dirección del servidor** y la **llave** las escribe cada quien la
  primera vez y se guardan solo en su teléfono (`localStorage`).
- La **clave de Gemini** no está aquí ni puede estarlo. Vive en un Apps
  Script privado; lo que llega a la app son **tokens de un solo uso** que
  caducan al minuto y solo sirven para la Live API.
- Quien abra esta página sin la llave ve una pantalla pidiendo la llave.

Por eso puede vivir en GitHub Pages, que es gratis y trae HTTPS —
imprescindible: sin HTTPS el navegador no da acceso al micrófono.

## Las piezas

| archivo | qué hace |
|---|---|
| `index.html` | la interfaz |
| `principal.js` | la ata con lo demás |
| `ani.js` | el WebSocket a la Live API de Gemini |
| `microfono.js` | micrófono a 16 kHz y altavoz a 24 kHz |
| `servidor.js` | la única puerta hacia el Apps Script |
| `sw.js` | para que se instale y abra sin conexión |

## Tres cosas que costaron y conviene no deshacer

**1. La dirección de la Live API con token efímero no es la normal.** Son
tres diferencias, y ninguna sale en la documentación de Google — se leyeron
del SDK de Python:

```
v1alpha            (no v1beta)
BidiGenerateContentConstrained   (no BidiGenerateContent)
?access_token=     (no ?key=)
```

Y el `setup` tiene que llevar el modelo: uno vacío se rechaza con un 1008
que no explica nada.

**2. El remuestreo del micrófono se hace a mano.** Pedirle a
`AudioContext` que abra a 16 kHz **no funciona en Android**: unos lo ignoran
y otros fallan. Se abre a la frecuencia del aparato y se remuestrea en un
*audio worklet*, que además corre fuera del hilo de la interfaz y no se
corta cuando la pantalla está ocupada.

**3. Al hablar con Apps Script hay que mandar `text/plain`.** Con
`application/json` el navegador lanza una petición de comprobación previa
que Apps Script no contesta, y no llega nada. Y hay que seguir la redirección
a `googleusercontent.com`, que es donde está la respuesta de verdad.
