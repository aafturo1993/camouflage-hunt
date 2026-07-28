"use strict";

/**
 * GameRenderer: dibuja el mapa sobre un <canvas> usando la Camera.
 *
 * Responsabilidades del Módulo 2:
 *   - Cargar la imagen del mapa.
 *   - Ajustar el canvas al tamaño real (devicePixelRatio) y a los cambios de ventana.
 *   - Bucle de render con requestAnimationFrame.
 *   - Entrada de cámara: arrastre (pointer) y zoom (rueda) centrado en el cursor.
 *
 * Los personajes, la pintura y la detección llegan en módulos posteriores;
 * este renderer expone la cámara y las conversiones de coordenadas que usarán.
 */
(function () {
  const WHEEL_ZOOM_IN = 1.1;
  const WHEEL_ZOOM_OUT = 1 / 1.1;
  const BUTTON_ZOOM_STEP = 1.15;

  class GameRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.world = { width: 2560, height: 1440 };
      this.camera = new window.Camera(this.world);
      this.mapImage = null;
      this.mapReady = false;
      this.mapId = null;
      this.running = false;
      this._rafId = null;
      this._drag = null;
      this._dpr = 1;
      this._onResize = () => this.resize();

      this._bindInput();
    }

    setWorld(world) {
      this.world = { width: world.width, height: world.height };
      this.camera.setWorld(this.world);
    }

    setZoomLimits(minZoom, maxZoom) {
      this.camera.setZoomLimits(minZoom, maxZoom);
    }

    /**
     * Carga un mapa. Si ya es el mismo mapId no hace nada (evita recargar la imagen).
     * map = { id, image, width, height }
     */
    loadMap(map) {
      if (this.mapId === map.id) {
        return;
      }
      this.mapId = map.id;
      this.setWorld(map);
      this.mapReady = false;
      this.mapImage = null;

      const image = new Image();
      image.onload = () => {
        this.mapImage = image;
        this.mapReady = true;
      };
      image.onerror = () => {
        this.mapImage = null;
        this.mapReady = false;
        console.error("No se pudo cargar la imagen del mapa:", map.image);
      };
      image.src = map.image;

      this.camera.setZoom(this.camera.minZoom);
      this.camera.centerOnWorld(this.world.width / 2, this.world.height / 2);
    }

    start() {
      if (this.running) {
        this.resize();
        return;
      }
      this.running = true;
      window.addEventListener("resize", this._onResize);
      this.resize();

      const loop = () => {
        if (!this.running) {
          return;
        }
        this.render();
        this._rafId = window.requestAnimationFrame(loop);
      };
      this._rafId = window.requestAnimationFrame(loop);
    }

    stop() {
      this.running = false;
      if (this._rafId) {
        window.cancelAnimationFrame(this._rafId);
        this._rafId = null;
      }
      window.removeEventListener("resize", this._onResize);
      this._drag = null;
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this._dpr = dpr;

      const cssWidth = Math.max(1, Math.round(rect.width));
      const cssHeight = Math.max(1, Math.round(rect.height));

      this.canvas.width = Math.round(cssWidth * dpr);
      this.canvas.height = Math.round(cssHeight * dpr);
      this.camera.setViewport(cssWidth, cssHeight);
    }

    render() {
      const ctx = this.ctx;
      const dpr = this._dpr;
      const viewportWidth = this.camera.viewport.width;
      const viewportHeight = this.camera.viewport.height;

      // Trabajamos en píxeles CSS; el DPR se aplica una sola vez aquí.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, viewportWidth, viewportHeight);

      ctx.fillStyle = "#0f1419";
      ctx.fillRect(0, 0, viewportWidth, viewportHeight);

      if (this.mapReady && this.mapImage) {
        const topLeft = this.camera.worldToScreen(0, 0);
        const drawWidth = this.world.width * this.camera.zoom;
        const drawHeight = this.world.height * this.camera.zoom;

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(this.mapImage, topLeft.x, topLeft.y, drawWidth, drawHeight);
      } else {
        ctx.fillStyle = "#c8d2d8";
        ctx.font = "16px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("Cargando mapa…", viewportWidth / 2, viewportHeight / 2);
      }
    }

    zoomInCentered() {
      this.camera.zoomAt(
        this.camera.viewport.width / 2,
        this.camera.viewport.height / 2,
        BUTTON_ZOOM_STEP
      );
    }

    zoomOutCentered() {
      this.camera.zoomAt(
        this.camera.viewport.width / 2,
        this.camera.viewport.height / 2,
        1 / BUTTON_ZOOM_STEP
      );
    }

    _localPointer(event) {
      const rect = this.canvas.getBoundingClientRect();
      return {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top
      };
    }

    _bindInput() {
      const canvas = this.canvas;

      canvas.addEventListener("pointerdown", (event) => {
        // Solo botón principal para el ratón; táctil pasa igualmente.
        if (event.pointerType === "mouse" && event.button !== 0) {
          return;
        }
        const point = this._localPointer(event);
        this._drag = { x: point.x, y: point.y };
        canvas.classList.add("grabbing");
        try {
          canvas.setPointerCapture(event.pointerId);
        } catch {
          /* setPointerCapture puede fallar en algunos navegadores; no es crítico. */
        }
      });

      canvas.addEventListener("pointermove", (event) => {
        if (!this._drag) {
          return;
        }
        const point = this._localPointer(event);
        this.camera.panByScreen(point.x - this._drag.x, point.y - this._drag.y);
        this._drag = { x: point.x, y: point.y };
      });

      const endDrag = (event) => {
        if (!this._drag) {
          return;
        }
        this._drag = null;
        canvas.classList.remove("grabbing");
        try {
          canvas.releasePointerCapture(event.pointerId);
        } catch {
          /* ignorar */
        }
      };

      canvas.addEventListener("pointerup", endDrag);
      canvas.addEventListener("pointercancel", endDrag);

      canvas.addEventListener(
        "wheel",
        (event) => {
          event.preventDefault();
          const point = this._localPointer(event);
          const factor = event.deltaY < 0 ? WHEEL_ZOOM_IN : WHEEL_ZOOM_OUT;
          this.camera.zoomAt(point.x, point.y, factor);
        },
        { passive: false }
      );
    }
  }

  window.GameRenderer = GameRenderer;
})();
