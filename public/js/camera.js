"use strict";

/**
 * Cámara 2D.
 *
 * Modelo:
 *   - El mundo (el mapa) tiene un tamaño fijo en píxeles: world.width x world.height.
 *   - La cámara guarda la coordenada de MUNDO que queda en el centro del viewport (x, y)
 *     y un factor de zoom.
 *   - El viewport se mide en píxeles CSS (no en píxeles físicos); el renderer se encarga
 *     del devicePixelRatio.
 *
 * Las posiciones de los personajes se guardan siempre en coordenadas de mundo.
 * La cámara solo las transforma para dibujarlas (worldToScreen / screenToWorld).
 */
(function () {
  function clamp(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  class Camera {
    constructor(world) {
      this.world = { width: world.width, height: world.height };
      this.viewport = { width: 1, height: 1 };
      this.zoom = 1;
      this.minZoom = 1;
      this.maxZoom = 2.5;
      this.x = this.world.width / 2;
      this.y = this.world.height / 2;
      this.clampToBounds();
    }

    setWorld(world) {
      this.world = { width: world.width, height: world.height };
      this.clampToBounds();
    }

    setViewport(width, height) {
      this.viewport.width = Math.max(1, width);
      this.viewport.height = Math.max(1, height);
      this.clampToBounds();
    }

    setZoomLimits(minZoom, maxZoom) {
      this.minZoom = minZoom;
      this.maxZoom = maxZoom;
      this.setZoom(this.zoom);
    }

    setZoom(zoom) {
      this.zoom = clamp(zoom, this.minZoom, this.maxZoom);
      this.clampToBounds();
    }

    /** Zoom manteniendo fijo el punto de mundo que hay bajo (screenX, screenY). */
    zoomAt(screenX, screenY, factor) {
      const before = this.screenToWorld(screenX, screenY);
      this.zoom = clamp(this.zoom * factor, this.minZoom, this.maxZoom);
      const after = this.screenToWorld(screenX, screenY);
      this.x += before.x - after.x;
      this.y += before.y - after.y;
      this.clampToBounds();
    }

    /** Desplaza la cámara según un arrastre medido en píxeles de pantalla. */
    panByScreen(dxScreen, dyScreen) {
      this.x -= dxScreen / this.zoom;
      this.y -= dyScreen / this.zoom;
      this.clampToBounds();
    }

    centerOnWorld(x, y) {
      this.x = x;
      this.y = y;
      this.clampToBounds();
    }

    worldToScreen(worldX, worldY) {
      return {
        x: (worldX - this.x) * this.zoom + this.viewport.width / 2,
        y: (worldY - this.y) * this.zoom + this.viewport.height / 2
      };
    }

    screenToWorld(screenX, screenY) {
      return {
        x: (screenX - this.viewport.width / 2) / this.zoom + this.x,
        y: (screenY - this.viewport.height / 2) / this.zoom + this.y
      };
    }

    /**
     * Mantiene la cámara dentro del mapa.
     * Si el mundo es más pequeño que el viewport en un eje, lo centra.
     */
    clampToBounds() {
      const halfWorldViewW = this.viewport.width / (2 * this.zoom);
      const halfWorldViewH = this.viewport.height / (2 * this.zoom);

      if (this.world.width <= halfWorldViewW * 2) {
        this.x = this.world.width / 2;
      } else {
        this.x = clamp(this.x, halfWorldViewW, this.world.width - halfWorldViewW);
      }

      if (this.world.height <= halfWorldViewH * 2) {
        this.y = this.world.height / 2;
      } else {
        this.y = clamp(this.y, halfWorldViewH, this.world.height - halfWorldViewH);
      }
    }
  }

  window.Camera = Camera;
})();
