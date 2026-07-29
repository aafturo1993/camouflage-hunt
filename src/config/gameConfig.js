"use strict";

/**
 * Configuración central del juego.
 * Fuente única de verdad para dimensiones, cámara, tiempos y límites.
 * Tanto el servidor como el cliente consumen estos valores
 * (el cliente los recibe a través de GET /api/config).
 */

// Todos los mapas comparten la misma resolución para simplificar el motor.
const WORLD = {
  width: 2560,
  height: 1440
};

// Límites de zoom por rol. El zoom es la escala mapa->pantalla: 1.0 = 100 %
// (1 píxel de mapa por píxel de pantalla).
// - HIDER: se acerca hasta el 800 % para pintar el monigote a detalle con el pincel
//   fino del módulo 4 (con el monigote a 37x66, por debajo de ahí el pincel se queda
//   grueso), y se aleja hasta el 50 % para comprobar cómo lo verá el cazador antes de
//   fijarse.
// - HUNTER: arranca en el 75 %, que es el encaje exacto del mapa 2560x1440 en una
//   pantalla 1080p, así que entra viendo el mapa entero sin marco. Se acerca hasta el
//   mismo 800 % que el escondido: sin eso, con el monigote bien camuflado, encontrarlo
//   era imposible. La dificultad ya la pone la munición contada y el reloj, no el
//   impedirle mirar de cerca.
const CAMERA = {
  zoomStep: 0.15,
  roles: {
    HIDER: { minZoom: 0.5, maxZoom: 8.0 },
    HUNTER: { minZoom: 0.75, maxZoom: 8.0 },
    UNASSIGNED: { minZoom: 0.5, maxZoom: 8.0 }
  }
};

// Personaje (monigote). Tamaño en píxeles de MUNDO; velocidad en píxeles/segundo.
// El personaje se ancla por su CENTRO.
const CHARACTER = {
  sprite: "/assets/players/monigote-01.png",
  width: 41,
  height: 73,
  speed: 340,
  // El escondido gira su monigote con la tecla R. Cada pulsación suma este
  // ángulo, así que ocho pulsaciones dan la vuelta completa y lo devuelven
  // a la vertical.
  rotationStepDegrees: 45
};

// Reglas de disparo del cazador.
// Munición total por ronda = nº de escondidos + extraShots.
const HUNTER = {
  shotCooldownMs: 800,
  extraShots: 5,
  hitPaddingX: 8,
  hitPaddingY: 8
};

// Pintura del personaje (módulo 4).
// - La pintura vive en una textura propia del tamaño del sprite; se recorta a la
//   silueta del monigote y se dibuja encima.
// - Los pinceles se miden en RADIO de píxeles de MUNDO. El monigote mide 37x66 de
//   mundo, así que "xs" es muy fino (para detalle a 800 %) y "l" rellena rápido.
// - La sincronización es por snapshot: una imagen PNG por jugador, no trazos.
const PAINT = {
  textureWidth: 200,
  textureHeight: 360,
  brushSizes: { xs: 0.5, s: 1.2, m: 2.5, l: 5 },
  defaultBrush: "s",
  // El monigote empieza en blanco: así se ve de un vistazo lo que llevas
  // camuflado y lo que te queda por pintar.
  defaultColor: "#ffffff",
  // Opciones de color de la rueda. El cuentagotas añade cualquier color del mapa.
  palette: [
    "#2b2f33", "#3a3f37", "#5c4a3a", "#6b7257", "#8a5a3b",
    "#9aa06f", "#b5651d", "#c7b489", "#4a5d68", "#7a8a99",
    "#a83e3e", "#8fae86", "#c0c6cc", "#d9c7a3", "#e8e2d0"
  ],
  snapshotMaxBytes: 150000,
  snapshotMinIntervalMs: 400
};

// Puntuación (módulo 6). Solo puntúan los escondidos; el cazador no.
// - perSecondHidden: puntos por cada segundo con vida.
// - survivalBonus: extra si el escondido llega vivo al final de la ronda.
// - camouflageBonus: extra cada vez que el cazador le apunta sin disparar
//   (el cursor se posa sobre él durante aimDwellMs y se va). Premia el camuflaje.
// - maxCamouflageBonuses: tope de bonus de camuflaje por ronda, para no acumular sin fin.
const SCORING = {
  aimDwellMs: 500,
  hider: {
    perSecondHidden: 1,
    survivalBonus: 150,
    camouflageBonus: 25,
    maxCamouflageBonuses: 4
  }
};

// Poco más de seis minutos por ronda. La preparación va justa a propósito:
// quien no termine de camuflarse puede seguir pintándose durante la búsqueda
// sin moverse del sitio. El grueso del tiempo se lo lleva la caza, que es donde
// el cazador tiene que ir zona por zona y acercarse a mirar.
const TIMERS = {
  preparationSeconds: 100,
  searchSeconds: 270
};

const LIMITS = {
  maxPlayers: 20,
  // Mínimo de jugadores para empezar. Por defecto 2.
  // Para probar en solitario: arrancar con MIN_PLAYERS=1 (o `npm run start:solo`).
  minPlayers: Number(process.env.MIN_PLAYERS) || 2
};

const DEFAULT_MAP_ID = "oficina-2d";

module.exports = {
  WORLD,
  CAMERA,
  CHARACTER,
  HUNTER,
  PAINT,
  SCORING,
  TIMERS,
  LIMITS,
  DEFAULT_MAP_ID
};
