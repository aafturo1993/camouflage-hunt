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
// - HUNTER: vista de conjunto obligatoria y poco margen (75-85 %). El 75 % es el encaje
//   exacto del mapa 2560x1440 en una pantalla 1080p, así que entra viendo el mapa entero
//   sin marco; en pantallas más anchas o más pequeñas tendrá que arrastrar. El techo bajo
//   es lo que da dificultad al juego.
const CAMERA = {
  zoomStep: 0.15,
  roles: {
    HIDER: { minZoom: 0.5, maxZoom: 8.0 },
    HUNTER: { minZoom: 0.75, maxZoom: 0.85 },
    UNASSIGNED: { minZoom: 0.5, maxZoom: 8.0 }
  }
};

// Personaje (monigote). Tamaño en píxeles de MUNDO; velocidad en píxeles/segundo.
// El personaje se ancla por su CENTRO.
const CHARACTER = {
  sprite: "/assets/players/monigote-01.png",
  width: 37,
  height: 66,
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

const TIMERS = {
  preparationSeconds: 120,
  searchSeconds: 180
};

const LIMITS = {
  maxPlayers: 20,
  // Mínimo de jugadores para empezar. Por defecto 2.
  // Para probar en solitario: arrancar con MIN_PLAYERS=1 (o `npm run start:solo`).
  minPlayers: Number(process.env.MIN_PLAYERS) || 2
};

const DEFAULT_MAP_ID = "placeholder-01";

module.exports = {
  WORLD,
  CAMERA,
  CHARACTER,
  HUNTER,
  TIMERS,
  LIMITS,
  DEFAULT_MAP_ID
};
