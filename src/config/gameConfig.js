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

// Límites de zoom por rol. minZoom = 1 significa "100 % (1 píxel de mapa = 1 píxel de pantalla)".
// El cazador tiene un zoom más limitado para mantener la dificultad.
const CAMERA = {
  zoomStep: 0.15,
  roles: {
    HIDER: { minZoom: 1.0, maxZoom: 2.5 },
    HUNTER: { minZoom: 1.0, maxZoom: 1.5 },
    UNASSIGNED: { minZoom: 1.0, maxZoom: 2.5 }
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
