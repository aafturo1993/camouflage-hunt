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

// Todos los mapas comparten la resolución de WORLD (2560x1440). Las imágenes ya
// están normalizadas a ese tamaño en public/assets/maps/.
function map(id, name, file) {
  return {
    id,
    name,
    image: `/assets/maps/${file}`,
    width: WORLD.width,
    height: WORLD.height
  };
}

const maps = [
  map("oficina-2d", "Oficina 2D", "oficina-2d.jpg"),
  map("home-office", "Home Office", "home-office.jpg"),
  map("medievo", "Medievo", "medievo.jpg"),
  map("meninas", "Las Meninas", "meninas.jpg"),
  map("simpsons", "Los Simpson", "simpsons.jpg"),
  map("simpsons-personajes", "Simpson (personajes)", "simpsons-personajes.jpg"),
  map("bosque", "Bosque", "bosque.jpg"),
  map("montanas", "Montañas", "montanas.jpg"),
  map("galaxia", "Galaxia", "galaxia.jpg"),
  map("skyline", "Skyline", "skyline.jpg"),
  map("homer", "Homer", "homer.jpg"),
  map("lego", "Lego", "lego.jpg"),
  map("lotr", "El Señor de los Anillos", "lotr.jpg"),
  map("trono-de-hierro", "Trono de Hierro", "trono-de-hierro.jpg"),
  map("rey-de-la-noche", "El Rey de la Noche", "rey-de-la-noche.jpg"),
  map("placeholder-01", "Escenario de pruebas", "placeholder-01.png")
];

module.exports = maps;
