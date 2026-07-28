"use strict";

/**
 * GameRenderer: dibuja el mapa y los personajes sobre un <canvas> usando la Camera.
 *
 * Modos de control:
 *   - "IDLE"   : solo mapa (o nada). Cámara con arrastre y zoom.
 *   - "PREP"   : escondido en preparación. Mueve su personaje con flechas/WASD;
 *                la cámara sigue al personaje; el arrastre queda desactivado.
 *   - "SEARCH" : búsqueda. Cámara con arrastre y zoom; se dibujan todos los
 *                personajes congelados. Si `allowShoot`, el clic dispara.
 *
 * Coordenadas de mundo: la posición del personaje es de MUNDO; la cámara la
 * transforma para dibujar. El personaje se ancla por su CENTRO.
 */
(function () {
  const CLICK_THRESHOLD_PX = 6;
  const MOVE_SEND_INTERVAL_MS = 90;
  const MAX_DELTA_SECONDS = 0.05;
  const DEFAULT_ZOOM_STEP = 0.15;

  const MOVE_KEYS = {
    ArrowUp: "up",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
    KeyW: "up",
    KeyS: "down",
    KeyA: "left",
    KeyD: "right"
  };

  class GameRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.world = { width: 2560, height: 1440 };
      this.camera = new window.Camera(this.world);

      this.mapImage = null;
      this.mapReady = false;
      this.mapId = null;

      this.character = { sprite: null, width: 74, height: 132, speed: 340 };
      this.sprite = null;
      this.spriteReady = false;

      this.mode = "IDLE";
      this.self = null;
      this.locked = false;
      this.characters = [];
      this.effects = [];
      this.allowShoot = false;
      this.viewerId = null;
      this.zoomStep = DEFAULT_ZOOM_STEP;

      this.onSelfMove = null;
      this.onShoot = null;
      this.onLockToggle = null;

      this.running = false;
      this._rafId = null;
      this._lastTs = 0;
      this._dpr = 1;

      this._keys = new Set();
      this._lastSentPos = null;
      this._lastSentAt = 0;

      this._pointer = null; // { id, startX, startY, lastX, lastY, moved }

      this._onResize = () => this.resize();
      this._onKeyDown = (event) => this._handleKeyDown(event);
      this._onKeyUp = (event) => this._handleKeyUp(event);
      this._onBlur = () => this._keys.clear();

      this._bindPointerInput();
    }

    setViewerId(id) {
      this.viewerId = id ?? null;
    }

    setZoomStep(step) {
      if (Number.isFinite(step) && step > 0) {
        this.zoomStep = step;
      }
    }

    setWorld(world) {
      this.world = { width: world.width, height: world.height };
      this.camera.setWorld(this.world);
    }

    setZoomLimits(minZoom, maxZoom) {
      this.camera.setZoomLimits(minZoom, maxZoom);
    }

    setCharacterConfig(config) {
      if (!config) {
        return;
      }
      this.character = {
        sprite: config.sprite,
        width: config.width,
        height: config.height,
        speed: config.speed
      };
      if (config.sprite && this.sprite?.src?.endsWith(config.sprite) !== true) {
        this._loadSprite(config.sprite);
      }
    }

    _loadSprite(src) {
      this.spriteReady = false;
      const image = new Image();
      image.onload = () => {
        this.sprite = image;
        this.spriteReady = true;
      };
      image.onerror = () => {
        this.sprite = null;
        this.spriteReady = false;
        console.error("No se pudo cargar el sprite del personaje:", src);
      };
      image.src = src;
      this.sprite = image;
    }

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

    // --- Modos ---------------------------------------------------------------

    setModeIdle() {
      this.mode = "IDLE";
      this.self = null;
      this.characters = [];
      this.effects = [];
      this.allowShoot = false;
    }

    setModePrepHider(startPosition) {
      this.mode = "PREP";
      this.allowShoot = false;
      this.locked = false;
      this.characters = [];
      this.effects = [];
      this._keys.clear();
      this.self = this._clampCharacter(
        startPosition ?? { x: this.world.width / 2, y: this.world.height / 2 }
      );
      this._lastSentPos = { ...this.self };
      this.camera.centerOnWorld(this.self.x, this.self.y);
    }

    setModeSearch(options = {}) {
      this.mode = "SEARCH";
      this.self = null;
      this.locked = false;
      this.allowShoot = Boolean(options.shoot);
      this.effects = [];
      this._keys.clear();
    }

    setCharacters(list) {
      this.characters = Array.isArray(list) ? list : [];
    }

    spawnShot(x, y, hit) {
      this.effects.push({ x, y, hit: Boolean(hit), birth: null });
    }

    // --- Ciclo de vida -------------------------------------------------------

    start() {
      if (this.running) {
        this.resize();
        return;
      }
      this.running = true;
      window.addEventListener("resize", this._onResize);
      window.addEventListener("keydown", this._onKeyDown);
      window.addEventListener("keyup", this._onKeyUp);
      // F-03: si se pierde el foco (Alt+Tab) soltamos las teclas para que el
      // personaje no siga andando solo.
      window.addEventListener("blur", this._onBlur);
      this.resize();

      const loop = (timestamp) => {
        if (!this.running) {
          return;
        }
        this._update(timestamp);
        this.render(timestamp);
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
      window.removeEventListener("keydown", this._onKeyDown);
      window.removeEventListener("keyup", this._onKeyUp);
      window.removeEventListener("blur", this._onBlur);
      this._pointer = null;
      this._keys.clear();
      this._lastTs = 0;
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this._dpr = dpr;

      const cssWidth = Math.max(1, Math.round(rect.width));
      const cssHeight = Math.max(1, Math.round(rect.height));
      const pixelWidth = Math.round(cssWidth * dpr);
      const pixelHeight = Math.round(cssHeight * dpr);

      // F-18: solo reasignamos el tamaño del canvas si cambió de verdad;
      // reasignarlo reinicia el contexto de dibujo.
      if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
        this.canvas.width = pixelWidth;
        this.canvas.height = pixelHeight;
      }
      this.camera.setViewport(cssWidth, cssHeight);
    }

    // --- Actualización -------------------------------------------------------

    _update(timestamp) {
      const previous = this._lastTs || timestamp;
      const dt = Math.min(MAX_DELTA_SECONDS, (timestamp - previous) / 1000);
      this._lastTs = timestamp;

      if (this.mode === "PREP" && this.self) {
        this._updateMovement(dt, timestamp);
        this.camera.centerOnWorld(this.self.x, this.self.y);
      }
    }

    _updateMovement(dt, timestamp) {
      if (this.locked) {
        return; // posición fijada: no se mueve ni se envían actualizaciones
      }
      let dx = 0;
      let dy = 0;
      if (this._keys.has("left")) dx -= 1;
      if (this._keys.has("right")) dx += 1;
      if (this._keys.has("up")) dy -= 1;
      if (this._keys.has("down")) dy += 1;

      if (dx !== 0 || dy !== 0) {
        const length = Math.hypot(dx, dy) || 1;
        const step = this.character.speed * dt;
        this.self.x += (dx / length) * step;
        this.self.y += (dy / length) * step;
        this.self = this._clampCharacter(this.self);
      }

      // Envío al servidor con límite de frecuencia (no en cada frame).
      const moved =
        !this._lastSentPos ||
        this._lastSentPos.x !== this.self.x ||
        this._lastSentPos.y !== this.self.y;
      if (moved && timestamp - this._lastSentAt >= MOVE_SEND_INTERVAL_MS) {
        this._lastSentAt = timestamp;
        this._lastSentPos = { x: this.self.x, y: this.self.y };
        if (typeof this.onSelfMove === "function") {
          this.onSelfMove({
            x: Math.round(this.self.x),
            y: Math.round(this.self.y)
          });
        }
      }
    }

    _clampCharacter(position) {
      const halfWidth = this.character.width / 2;
      const halfHeight = this.character.height / 2;
      return {
        x: clamp(position.x, halfWidth, this.world.width - halfWidth),
        y: clamp(position.y, halfHeight, this.world.height - halfHeight)
      };
    }

    // --- Render --------------------------------------------------------------

    render(timestamp) {
      const ctx = this.ctx;
      const dpr = this._dpr;
      const viewportWidth = this.camera.viewport.width;
      const viewportHeight = this.camera.viewport.height;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, viewportWidth, viewportHeight);
      ctx.fillStyle = "#0f1419";
      ctx.fillRect(0, 0, viewportWidth, viewportHeight);

      if (this.mapReady && this.mapImage) {
        const topLeft = this.camera.worldToScreen(0, 0);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(
          this.mapImage,
          topLeft.x,
          topLeft.y,
          this.world.width * this.camera.zoom,
          this.world.height * this.camera.zoom
        );
      } else {
        ctx.fillStyle = "#c8d2d8";
        ctx.font = "16px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("Cargando mapa…", viewportWidth / 2, viewportHeight / 2);
      }

      if (this.mode === "PREP" && this.self) {
        this._drawCharacter(this.self.x, this.self.y, { isSelf: true });
      } else if (this.mode === "SEARCH") {
        for (const character of this.characters) {
          this._drawCharacter(character.x, character.y, {
            found: character.found,
            // F-12: marca cuál es el personaje del propio jugador.
            isSelf: character.id != null && character.id === this.viewerId
          });
        }
      }

      this._drawEffects(timestamp);
    }

    _drawCharacter(worldX, worldY, options = {}) {
      const ctx = this.ctx;
      const zoom = this.camera.zoom;
      const screen = this.camera.worldToScreen(worldX, worldY);
      const width = this.character.width * zoom;
      const height = this.character.height * zoom;
      const left = screen.x - width / 2;
      const top = screen.y - height / 2;

      ctx.save();
      if (options.found) {
        ctx.globalAlpha = 0.55;
      }

      if (this.spriteReady && this.sprite) {
        ctx.drawImage(this.sprite, left, top, width, height);
      } else {
        // Silueta de reserva si el sprite aún no cargó.
        ctx.fillStyle = "#f2f4f6";
        ctx.strokeStyle = "#9aa4ad";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(screen.x, screen.y, width / 2, height / 2, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();

      if (options.found) {
        // Marca de "encontrado": aspa roja sobre el personaje.
        ctx.save();
        ctx.strokeStyle = "#d1332e";
        ctx.lineWidth = Math.max(3, 5 * zoom);
        ctx.lineCap = "round";
        const r = Math.min(width, height) * 0.35;
        ctx.beginPath();
        ctx.moveTo(screen.x - r, screen.y - r);
        ctx.lineTo(screen.x + r, screen.y + r);
        ctx.moveTo(screen.x + r, screen.y - r);
        ctx.lineTo(screen.x - r, screen.y + r);
        ctx.stroke();
        ctx.restore();
      }

      if (options.isSelf) {
        // Etiqueta para identificar el propio personaje. "FIJADO" solo en preparación.
        const locked = this.mode === "PREP" && this.locked;
        const color = locked ? "#1f9d55" : "#1b6ef3";

        if (locked) {
          ctx.save();
          ctx.strokeStyle = color;
          ctx.lineWidth = Math.max(2, 3 * zoom);
          ctx.beginPath();
          ctx.ellipse(
            screen.x,
            screen.y,
            width / 2 + 8,
            height / 2 + 8,
            0,
            0,
            Math.PI * 2
          );
          ctx.stroke();
          ctx.restore();
        }

        ctx.save();
        ctx.fillStyle = color;
        ctx.font = "bold 13px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText(locked ? "FIJADO" : "TÚ", screen.x, top - 6);
        ctx.restore();
      }
    }

    _drawEffects(timestamp) {
      if (this.effects.length === 0) {
        return;
      }
      const ctx = this.ctx;
      const remaining = [];

      for (const effect of this.effects) {
        if (effect.birth === null) {
          effect.birth = timestamp;
        }
        const age = timestamp - effect.birth;
        const duration = effect.hit ? 700 : 350;
        if (age > duration) {
          continue;
        }
        remaining.push(effect);

        const progress = age / duration;
        const screen = this.camera.worldToScreen(effect.x, effect.y);
        const maxRadius = (effect.hit ? 46 : 26) * this.camera.zoom;
        const radius = maxRadius * progress;

        ctx.save();
        ctx.globalAlpha = 1 - progress;
        ctx.strokeStyle = effect.hit ? "#ff7a1a" : "#c8d2d8";
        ctx.lineWidth = effect.hit ? 5 : 3;
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
        ctx.stroke();
        if (effect.hit) {
          ctx.fillStyle = "rgba(255, 122, 26, 0.25)";
          ctx.fill();
        }
        ctx.restore();
      }

      this.effects = remaining;
    }

    // --- Zoom por botones ----------------------------------------------------

    zoomInCentered() {
      this.camera.zoomAt(
        this.camera.viewport.width / 2,
        this.camera.viewport.height / 2,
        1 + this.zoomStep
      );
    }

    zoomOutCentered() {
      this.camera.zoomAt(
        this.camera.viewport.width / 2,
        this.camera.viewport.height / 2,
        1 / (1 + this.zoomStep)
      );
    }

    // --- Entrada de teclado --------------------------------------------------

    _handleKeyDown(event) {
      if (this.mode !== "PREP") {
        return;
      }
      if (event.code === "Enter") {
        event.preventDefault();
        this._toggleLock();
        return;
      }
      const direction = MOVE_KEYS[event.code];
      if (!direction) {
        return;
      }
      if (this.locked) {
        return; // fijado: se ignora el movimiento
      }
      event.preventDefault();
      this._keys.add(direction);
    }

    _toggleLock() {
      if (!this.self) {
        return;
      }
      this.locked = !this.locked;
      this._keys.clear();
      if (typeof this.onLockToggle === "function") {
        this.onLockToggle(this.locked, {
          x: Math.round(this.self.x),
          y: Math.round(this.self.y)
        });
      }
    }

    _handleKeyUp(event) {
      const direction = MOVE_KEYS[event.code];
      if (!direction) {
        return;
      }
      this._keys.delete(direction);

      // F-10: al soltar, enviamos la posición exacta para que, si la preparación
      // termina justo después, el monigote se congele donde se dejó y no hasta
      // 30 px más allá por culpa del intervalo de envío.
      if (
        this.mode === "PREP" &&
        !this.locked &&
        this.self &&
        typeof this.onSelfMove === "function"
      ) {
        this._lastSentPos = { x: this.self.x, y: this.self.y };
        this._lastSentAt = this._lastTs;
        this.onSelfMove({
          x: Math.round(this.self.x),
          y: Math.round(this.self.y)
        });
      }
    }

    // --- Entrada de puntero (arrastre y disparo) -----------------------------

    _localPointer(event) {
      const rect = this.canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }

    _bindPointerInput() {
      const canvas = this.canvas;

      canvas.addEventListener("pointerdown", (event) => {
        if (event.pointerType === "mouse" && event.button !== 0) {
          return;
        }
        const point = this._localPointer(event);
        this._pointer = {
          id: event.pointerId,
          startX: point.x,
          startY: point.y,
          lastX: point.x,
          lastY: point.y,
          moved: false
        };
        try {
          canvas.setPointerCapture(event.pointerId);
        } catch {
          /* no crítico */
        }
      });

      canvas.addEventListener("pointermove", (event) => {
        // F-15: solo seguimos el dedo/puntero que inició el arrastre.
        if (!this._pointer || event.pointerId !== this._pointer.id) {
          return;
        }
        const point = this._localPointer(event);
        const dx = point.x - this._pointer.lastX;
        const dy = point.y - this._pointer.lastY;
        this._pointer.lastX = point.x;
        this._pointer.lastY = point.y;

        const totalDx = point.x - this._pointer.startX;
        const totalDy = point.y - this._pointer.startY;
        if (Math.hypot(totalDx, totalDy) > CLICK_THRESHOLD_PX) {
          this._pointer.moved = true;
        }

        // El arrastre solo mueve la cámara fuera del modo preparación.
        if (this.mode !== "PREP") {
          canvas.classList.add("grabbing");
          this.camera.panByScreen(dx, dy);
        }
      });

      const endPointer = (event) => {
        if (!this._pointer || event.pointerId !== this._pointer.id) {
          return;
        }
        const wasClick = !this._pointer.moved;
        const point = this._localPointer(event);
        this._pointer = null;
        canvas.classList.remove("grabbing");
        try {
          canvas.releasePointerCapture(event.pointerId);
        } catch {
          /* ignorar */
        }

        if (wasClick && this.mode === "SEARCH" && this.allowShoot) {
          const world = this.camera.screenToWorld(point.x, point.y);
          if (typeof this.onShoot === "function") {
            this.onShoot({ x: Math.round(world.x), y: Math.round(world.y) });
          }
        }
      };

      canvas.addEventListener("pointerup", endPointer);
      canvas.addEventListener("pointercancel", () => {
        this._pointer = null;
        canvas.classList.remove("grabbing");
      });

      canvas.addEventListener(
        "wheel",
        (event) => {
          event.preventDefault();
          const point = this._localPointer(event);
          const factor =
            event.deltaY < 0 ? 1 + this.zoomStep : 1 / (1 + this.zoomStep);
          this.camera.zoomAt(point.x, point.y, factor);
        },
        { passive: false }
      );
    }
  }

  function clamp(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  window.GameRenderer = GameRenderer;
})();
