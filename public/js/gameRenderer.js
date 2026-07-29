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

      this.character = {
        sprite: null,
        width: 37,
        height: 66,
        speed: 340,
        rotationStepDegrees: 45
      };
      this.sprite = null;
      this.spriteReady = false;

      this.mode = "IDLE";
      this.self = null;
      this.locked = false;
      // Ángulo del monigote propio, en grados. Se gira con R.
      this.rotation = 0;
      this.characters = [];
      this.effects = [];
      this.allowShoot = false;
      this.viewerId = null;
      this.zoomStep = DEFAULT_ZOOM_STEP;

      this.onSelfMove = null;
      this.onShoot = null;
      this.onLockToggle = null;
      // Pintura (módulo 4). El cliente enruta aquí el ratón cuando se puede pintar.
      this.onPaint = null;
      this.selfTextureCanvas = null;
      this._paintCache = new Map(); // id -> { src, image } para dibujar en búsqueda
      // Punto sobre el que pintar en búsqueda (el propio monigote congelado del
      // escondido que aún no ha sido encontrado). null = no se pinta en búsqueda.
      this.paintAnchor = null;
      // Revelado de resultados: marca a todos los monigotes y muestra sus nombres.
      this.reveal = false;

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

    /**
     * Fija el estado de "fijado" desde fuera. Lo usa el cliente para revertir si
     * el servidor rechaza el `player:lock` (F-21).
     */
    setLocked(value) {
      this.locked = Boolean(value);
      this._keys.clear();
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
        speed: config.speed,
        rotationStepDegrees: config.rotationStepDegrees ?? 45
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
      this.rotation = 0;
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
      this.paintAnchor = null;
      this.effects = [];
      this._keys.clear();
    }

    /**
     * Fija el punto de pintura en búsqueda: el propio monigote del escondido no
     * encontrado. Con null, no se pinta (cazador, ya encontrado, o preparación).
     */
    setPaintAnchor(anchor) {
      this.paintAnchor =
        anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y)
          ? { x: anchor.x, y: anchor.y, rotation: anchor.rotation ?? 0 }
          : null;
    }

    setReveal(value) {
      this.reveal = Boolean(value);
    }

    /**
     * Encaja el mapa entero en la vista para el revelado de resultados, aunque el
     * mínimo de zoom del rol no llegara a tanto. Centra el mapa.
     */
    revealFit() {
      const fit = Math.min(
        this.camera.viewport.width / this.world.width,
        this.camera.viewport.height / this.world.height
      );
      this.camera.setZoomLimits(Math.min(fit, this.camera.minZoom), this.camera.maxZoom);
      this.camera.setZoom(fit);
      this.camera.centerOnWorld(this.world.width / 2, this.world.height / 2);
    }

    /** ¿Se puede pintar ahora? En preparación siempre; en búsqueda si hay ancla. */
    _canPaintNow() {
      if (this.mode === "PREP") {
        return Boolean(this.self);
      }
      return this.paintAnchor != null;
    }

    /**
     * Marca el canvas cuando el puntero está sobre el cuerpo del monigote, que
     * es lo único que se puede pintar. El CSS usa esa marca para cambiar el
     * puntero al círculo de pintura y así se ve de un vistazo dónde pinta.
     */
    _updatePaintCursor(event) {
      const anchor = this._canPaintNow() ? this.getPaintAnchor() : null;
      if (!anchor) {
        this.canvas.classList.remove("over-character");
        return;
      }
      // Mientras se está dando un trazo, el puntero no cambia aunque el ratón
      // se salga del cuerpo: el trazo sigue siendo válido.
      if (this._pointer) {
        this.canvas.classList.add("over-character");
        return;
      }
      // Medir el canvas cuesta, así que se hace solo si de verdad se puede
      // pintar: al cazador, que mueve el ratón sin parar, no le cuesta nada.
      const point = this._localPointer(event);
      const world = this.camera.screenToWorld(point.x, point.y);
      this.canvas.classList.toggle(
        "over-character",
        this._isOverCharacter(world, anchor)
      );
    }

    /** ¿El punto de mundo cae dentro del cuerpo del monigote? */
    _isOverCharacter(world, anchor) {
      const radians = (-(anchor.rotation || 0) * Math.PI) / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      const dx = world.x - anchor.x;
      const dy = world.y - anchor.y;
      const localX = dx * cos - dy * sin;
      const localY = dx * sin + dy * cos;
      return (
        Math.abs(localX) <= this.character.width / 2 &&
        Math.abs(localY) <= this.character.height / 2
      );
    }

    /** Posición y giro del monigote que se está pintando. */
    getPaintAnchor() {
      if (this.mode === "PREP" && this.self) {
        return { x: this.self.x, y: this.self.y, rotation: this.rotation };
      }
      return this.paintAnchor;
    }

    setCharacters(list) {
      const characters = Array.isArray(list) ? list : [];
      // Carga (y cachea) la pintura de cada personaje para dibujarla en búsqueda.
      for (const character of characters) {
        if (!character.paint) {
          character._paintImage = null;
          continue;
        }
        let entry = this._paintCache.get(character.id);
        if (!entry || entry.src !== character.paint) {
          const image = new Image();
          image.src = character.paint;
          entry = { src: character.paint, image };
          this._paintCache.set(character.id, entry);
        }
        character._paintImage = entry.image;
      }
      this.characters = characters;
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
      } else if (this.mode === "SEARCH" && this.paintAnchor) {
        // El escondido que sigue pintando ve su monigote centrado.
        this.camera.centerOnWorld(this.paintAnchor.x, this.paintAnchor.y);
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
        this._sendSelf(timestamp);
      }
    }

    /**
     * Sitio que ocupa el monigote sobre los ejes del mapa. De pie es su ancho y
     * su alto; girado 45° la diagonal ocupa más, así que los bordes del mapa se
     * alcanzan antes. El servidor hace el mismo cálculo.
     */
    _halfExtent(rotationDegrees = this.rotation) {
      const radians = (rotationDegrees * Math.PI) / 180;
      const cos = Math.abs(Math.cos(radians));
      const sin = Math.abs(Math.sin(radians));
      const halfWidth = this.character.width / 2;
      const halfHeight = this.character.height / 2;
      return {
        x: cos * halfWidth + sin * halfHeight,
        y: sin * halfWidth + cos * halfHeight
      };
    }

    _clampCharacter(position) {
      const half = this._halfExtent();
      return {
        x: clamp(position.x, half.x, this.world.width - half.x),
        y: clamp(position.y, half.y, this.world.height - half.y)
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
        // Sin mapa no se dibuja a nadie. Si el telón se abre antes de que la
        // imagen esté lista, los monigotes se verían recortados sobre el fondo
        // vacío y el cazador sabría dónde está cada uno antes de empezar.
        return;
      }

      if (this.mode === "PREP" && this.self) {
        this._drawCharacter(this.self.x, this.self.y, {
          isSelf: true,
          rotation: this.rotation,
          texture: this.selfTextureCanvas
        });
      } else if (this.mode === "SEARCH") {
        for (const character of this.characters) {
          const isSelf = character.id != null && character.id === this.viewerId;
          // Si soy un escondido que sigue pintando, mi monigote muestra la textura
          // en vivo, no la última recibida por red.
          const texture =
            isSelf && this.paintAnchor && this.selfTextureCanvas
              ? this.selfTextureCanvas
              : character._paintImage;
          this._drawCharacter(character.x, character.y, {
            found: character.found,
            rotation: character.rotation ?? 0,
            isSelf, // F-12: marca cuál es el personaje del propio jugador.
            texture,
            // En el revelado se marca a todos y se muestra el nombre.
            reveal: this.reveal,
            name: character.name
          });
        }
      }

      this._drawEffects(timestamp);
    }

    /**
     * Silueta del monigote teñida de un color, guardada para no rehacerla en
     * cada fotograma. Sirve para el borde: se dibuja desplazada por debajo del
     * cuerpo y lo que asoma alrededor es el contorno.
     */
    _silhouette(color) {
      if (!this.spriteReady || !this.sprite) {
        return null;
      }
      if (!this._silhouettes) {
        this._silhouettes = new Map();
      }
      const cached = this._silhouettes.get(color);
      if (cached && cached.src === this.sprite.src) {
        return cached.canvas;
      }
      const canvas = document.createElement("canvas");
      canvas.width = this.sprite.naturalWidth || 200;
      canvas.height = this.sprite.naturalHeight || 360;
      const context = canvas.getContext("2d");
      context.drawImage(this.sprite, 0, 0, canvas.width, canvas.height);
      context.globalCompositeOperation = "source-in";
      context.fillStyle = color;
      context.fillRect(0, 0, canvas.width, canvas.height);
      this._silhouettes.set(color, { src: this.sprite.src, canvas });
      return canvas;
    }

    /**
     * Contorno del monigote. El desplazamiento va en píxeles de PANTALLA, no de
     * mundo, así el borde se mantiene igual de fino por mucho que se acerque el
     * cazador: si fuera de mundo, al 800 % sería un pegote.
     */
    _drawOutline(left, top, width, height, style) {
      const silhouette = this._silhouette(style.color);
      if (!silhouette) {
        return;
      }
      const d = style.offset;
      const pasos = style.diagonal
        ? [[-d, 0], [d, 0], [0, -d], [0, d], [-d, -d], [d, -d], [-d, d], [d, d]]
        : [[-d, 0], [d, 0], [0, -d], [0, d]];
      const ctx = this.ctx;
      ctx.save();
      // Se multiplica para respetar el atenuado del personaje ya encontrado.
      ctx.globalAlpha = ctx.globalAlpha * style.alpha;
      for (const [offsetX, offsetY] of pasos) {
        ctx.drawImage(silhouette, left + offsetX, top + offsetY, width, height);
      }
      ctx.restore();
    }

    _drawCharacter(worldX, worldY, options = {}) {
      const ctx = this.ctx;
      const zoom = this.camera.zoom;
      const screen = this.camera.worldToScreen(worldX, worldY);
      const width = this.character.width * zoom;
      const height = this.character.height * zoom;
      const left = screen.x - width / 2;
      const top = screen.y - height / 2;

      const radians = ((Number(options.rotation) || 0) * Math.PI) / 180;

      ctx.save();
      // En el revelado se ven todos a plena opacidad (para apreciar el camuflaje);
      // durante la búsqueda el cazado se atenúa.
      if (options.found && !options.reveal) {
        ctx.globalAlpha = 0.55;
      }
      if (radians !== 0) {
        // Giramos el lienzo alrededor del centro del monigote y seguimos
        // dibujando con las mismas coordenadas de siempre.
        ctx.translate(screen.x, screen.y);
        ctx.rotate(radians);
        ctx.translate(-screen.x, -screen.y);
      }

      // Borde. Durante la partida es el mínimo imprescindible: un píxel muy
      // tenue, lo justo para que el cazador tenga algo a lo que agarrarse sin
      // regalarle la silueta. Al acabar, en el revelado, se marca de verdad
      // para que se vea dónde estaba cada uno y lo bien que se camufló.
      if (options.reveal) {
        this._drawOutline(left, top, width, height, {
          color: "#11161b",
          offset: 3,
          alpha: 0.9,
          diagonal: true
        });
        this._drawOutline(left, top, width, height, {
          color: "#ffffff",
          offset: 1.5,
          alpha: 0.95,
          diagonal: true
        });
      } else {
        // El borde crece con el acercamiento en vez de ser fijo. En la vista de
        // conjunto, que es desde donde el cazador barre el mapa, se queda en una
        // fracción de píxel y no se distingue; solo cuando se acerca de verdad a
        // mirar una zona llega a un píxel. Antes era 1 píxel siempre y a esa
        // distancia el monigote se reconocía a la primera pasada.
        this._drawOutline(left, top, width, height, {
          color: "#0f1419",
          offset: clamp(zoom * 0.2, 0.12, 1),
          alpha: 0.14,
          diagonal: false
        });
      }

      // La pintura SUSTITUYE al sprite, no se dibuja encima. Con las dos capas
      // superpuestas, en el borde de la silueta ninguna es opaca del todo y
      // asomaba parte del color del sprite: eso perfilaba al monigote sobre el
      // mapa y lo delataba por muy bien camuflado que estuviera. La pintura ya
      // nace cubriendo todo el cuerpo, así que no hace falta nada debajo.
      const texture = options.texture;
      const textureReady =
        Boolean(texture) &&
        (texture instanceof HTMLCanvasElement ||
          (texture.complete && texture.naturalWidth > 0));

      if (textureReady) {
        ctx.drawImage(texture, left, top, width, height);
      } else if (this.spriteReady && this.sprite) {
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

      if (options.reveal) {
        // Revelado de resultados: un aro alrededor de cada monigote (rojo si fue
        // cazado, verde si sobrevivió) y su nombre debajo, para ver a todos y
        // cómo se camuflaron. El aro no gira con el cuerpo.
        const ringColor = options.found ? "#d1332e" : "#1f9d55";
        const ringRadius = Math.max(width, height) / 2 + 10;
        ctx.save();
        ctx.strokeStyle = ringColor;
        ctx.lineWidth = Math.max(2, 3 * zoom);
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, ringRadius, 0, Math.PI * 2);
        ctx.stroke();

        if (options.name) {
          const label = options.name;
          ctx.font = "bold 13px system-ui, sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          const labelY = screen.y + ringRadius + 4;
          const textWidth = ctx.measureText(label).width;
          ctx.fillStyle = "rgba(15, 20, 25, 0.8)";
          ctx.fillRect(screen.x - textWidth / 2 - 4, labelY - 2, textWidth + 8, 18);
          ctx.fillStyle = "#eef2f5";
          ctx.fillText(label, screen.x, labelY);
        }
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
            radians,
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
      if (event.code === "KeyR") {
        event.preventDefault();
        this._rotate();
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

    /**
     * Gira el monigote un paso (45° por defecto). A la octava pulsación ha dado
     * la vuelta entera y vuelve a estar de pie, que es la forma de deshacerlo.
     * Con la posición fijada no se gira, igual que no se anda.
     */
    _rotate() {
      if (!this.self || this.locked) {
        return;
      }
      const step = this.character.rotationStepDegrees || 45;
      this.rotation = (this.rotation + step) % 360;
      // Tumbado ocupa más a lo ancho: puede quedar medio cuerpo fuera del mapa.
      this.self = this._clampCharacter(this.self);
      // Girar no es un movimiento continuo, así que se manda en el momento.
      this._sendSelf();
    }

    /** Manda al servidor dónde está y cómo está colocado el monigote propio. */
    _sendSelf(timestamp) {
      if (!this.self || typeof this.onSelfMove !== "function") {
        return;
      }
      this._lastSentPos = { x: this.self.x, y: this.self.y };
      if (Number.isFinite(timestamp)) {
        this._lastSentAt = timestamp;
      }
      this.onSelfMove({
        x: Math.round(this.self.x),
        y: Math.round(this.self.y),
        rotation: this.rotation
      });
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
          y: Math.round(this.self.y),
          rotation: this.rotation
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
      if (this.mode === "PREP" && !this.locked && this.self) {
        this._sendSelf(this._lastTs);
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

        // El ratón pinta el monigote (preparación, o búsqueda si aún se puede).
        if (this._canPaintNow() && typeof this.onPaint === "function") {
          const world = this.camera.screenToWorld(point.x, point.y);
          this.onPaint("down", world, point);
        }
      });

      // Puntero en reposo: solo sirve para saber si está sobre el monigote y
      // cambiar el cursor. El seguimiento del arrastre va aparte, más abajo.
      canvas.addEventListener("pointermove", (event) => {
        this._updatePaintCursor(event);
      });

      canvas.addEventListener("pointerleave", () => {
        canvas.classList.remove("over-character");
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

        // Si se puede pintar, el ratón pinta; si no, arrastra la cámara.
        if (this._canPaintNow() && typeof this.onPaint === "function") {
          const world = this.camera.screenToWorld(point.x, point.y);
          this.onPaint("move", world, point);
        } else {
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

        // Fin de trazo de pintura (preparación o búsqueda).
        if (this._canPaintNow() && typeof this.onPaint === "function") {
          const world = this.camera.screenToWorld(point.x, point.y);
          this.onPaint("up", world, point);
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

      // Apuntado del cazador: informa la posición del cursor (aunque no haya
      // botón pulsado) durante la búsqueda, para el bonus de camuflaje.
      canvas.addEventListener("pointermove", (event) => {
        if (
          this.mode === "SEARCH" &&
          this.allowShoot &&
          typeof this.onAim === "function"
        ) {
          const point = this._localPointer(event);
          const world = this.camera.screenToWorld(point.x, point.y);
          this.onAim(world);
        }
      });
    }
  }

  function clamp(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  window.GameRenderer = GameRenderer;
})();
