"use strict";

/**
 * Catálogo de mapas.
 * Añadir un escenario nuevo solo requiere:
 *   1. Copiar la imagen en public/assets/maps/
 *   2. Añadir una entrada en este array (mismo width/height que WORLD)
 *   3. Reiniciar o volver a desplegar la aplicación
 *
 * Todos los mapas comparten la resolución definida en gameConfig.WORLD.
 */

const { WORLD } = require("./gameConfig");

const maps = [
  {
    id: "placeholder-01",
    name: "Escenario de pruebas",
    image: "/assets/maps/placeholder-01.png",
    width: WORLD.width,
    height: WORLD.height
  }
];

function getMapById(mapId) {
  return maps.find((map) => map.id === mapId) ?? null;
}

module.exports = maps;
module.exports.getMapById = getMapById;
