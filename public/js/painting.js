"use strict";

/**
 * PaintEngine: la pintura del personaje (módulo 4).
 *
 * Idea general:
 *   - Cada jugador pinta sobre una textura propia (un canvas fuera de pantalla del
 *     tamaño del sprite). La pintura se recorta a la silueta del monigote usando el
 *     propio sprite como máscara alfa (globalCompositeOperation = "destination-in").
 *   - Pintar es LOCAL e inmediato (sin latencia). No se envían trazos: se envía un
 *     snapshot PNG de la textura, limitado en frecuencia. El servidor guarda el último
 *     y lo reparte al empezar la búsqueda, así el cazador ve a todos ya camuflados.
 *   - El cuentagotas ("tampón") copia el color de un píxel del mapa para clonarlo y
 *     ayudar al camuflaje.
 *
 * Coordenadas: se pinta en píxeles de MUNDO. El motor convierte el punto de mundo al
 * sistema local del monigote (deshaciendo su rotación) y de ahí a píxeles de textura.
 */
(function () {
  function clampByte(value) {
    if (value < 0) return 0;
    if (value > 255) return 255;
    return Math.round(value);
  }

  function toHex(r, g, b) {
    const h = (n) => clampByte(n).toString(16).padStart(2, "0");
    return `#${h(r)}${h(g)}${h(b)}`;
  }

  class PaintEngine {
    constructor() {
      this.textureWidth = 200;
      this.textureHeight = 360;
      this.canvas = document.createElement("canvas");
      this.canvas.width = this.textureWidth;
      this.canvas.height = this.textureHeight;
      this.ctx = this.canvas.getContext("2d");

      this.characterWidth = 37;
      this.characterHeight = 66;

      this.maskImage = null;
      this.maskReady = false;

      this.brushRadiusWorld = 1.2;
      this.color = "#6b7257";
      // Color con el que nace el cuerpo antes de pintar nada. La textura arranca
      // rellena con él para que el sprite no tenga que verse por debajo.
      this.baseColor = "#6b7257";
      this.hasPaint = false;

      this.snapshotMinIntervalMs = 400;
      this.onSnapshot = null;

      this._painting = false;
      this._lastTexPoint = null;
      this._lastSnapshotAt = 0;
      // Envío diferido del último estado cuando toca esperar al intervalo (F-25).
      this._pendingSendId = null;
    }

    configure(paintConfig, character) {
      if (paintConfig) {
        this.textureWidth = paintConfig.textureWidth ?? this.textureWidth;
        this.textureHeight = paintConfig.textureHeight ?? this.textureHeight;
        this.snapshotMinIntervalMs =
          paintConfig.snapshotMinIntervalMs ?? this.snapshotMinIntervalMs;
        this.color = paintConfig.defaultColor ?? this.color;
        this.baseColor = paintConfig.defaultColor ?? this.baseColor;
      }
      if (
        this.canvas.width !== this.textureWidth ||
        this.canvas.height !== this.textureHeight
      ) {
        this.canvas.width = this.textureWidth;
        this.canvas.height = this.textureHeight;
      }
      if (character) {
        this.characterWidth = character.width ?? this.characterWidth;
        this.characterHeight = character.height ?? this.characterHeight;
        if (
          character.sprite &&
          this.maskImage?.src?.endsWith(character.sprite) !== true
        ) {
          this._loadMask(character.sprite);
        }
      }
    }

    _loadMask(src) {
      this.maskReady = false;
      const image = new Image();
      image.onload = () => {
        this.maskImage = image;
        this.maskReady = true;
        // Recorta lo que ya hubiera pintado a la nueva silueta.
        this._applyMask();
        // Si la silueta llegó después del reset, el cuerpo aún está vacío.
        if (!this.hasPaint) {
          this._fillBase();
        }
      };
      image.onerror = () => {
        this.maskImage = null;
        this.maskReady = false;
        console.error("No se pudo cargar la máscara de pintura:", src);
      };
      image.src = src;
      this.maskImage = image;
    }

    setBrushWorldRadius(radius) {
      if (Number.isFinite(radius) && radius > 0) {
        this.brushRadiusWorld = radius;
      }
    }

    setColor(color) {
      if (typeof color === "string" && color) {
        this.color = color;
      }
    }

    getCanvas() {
      return this.canvas;
    }

    /**
     * Empieza el lienzo de la ronda: el cuerpo entero del color base.
     *
     * No se deja transparente a propósito. El monigote se dibujaba antes en dos
     * capas —el sprite debajo y la pintura encima—, y en el borde de la silueta
     * ninguna de las dos es opaca del todo, así que asomaba una parte del color
     * del sprite y perfilaba la figura sobre el mapa. Con el cuerpo ya relleno,
     * el sprite deja de hacer falta debajo y el contorno desaparece.
     */
    reset() {
      this.ctx.clearRect(0, 0, this.textureWidth, this.textureHeight);
      this._fillBase();
      this.hasPaint = false;
      this._painting = false;
      this._lastTexPoint = null;
      // Cancela un envío diferido pendiente para que no reenvíe pintura vieja.
      this._clearPendingSend();
    }

    /** Rellena toda la silueta con el color base. */
    _fillBase() {
      if (!this.maskReady || !this.maskImage) {
        return; // aún no hay silueta; se rellena en cuanto cargue la máscara
      }
      const ctx = this.ctx;
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = this.baseColor;
      ctx.fillRect(0, 0, this.textureWidth, this.textureHeight);
      this._applyMask();
    }

    /** Borra la pintura y avisa (para que el servidor la quite). */
    clear() {
      this.reset();
      this._sendSnapshot(true);
    }

    _radiusTexture() {
      const scale = this.textureWidth / this.characterWidth;
      return Math.max(0.5, this.brushRadiusWorld * scale);
    }

    _worldToTexture(worldX, worldY, charX, charY, rotationDegrees) {
      const radians = (-rotationDegrees * Math.PI) / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      const dx = worldX - charX;
      const dy = worldY - charY;
      const localX = dx * cos - dy * sin;
      const localY = dx * sin + dy * cos;
      return {
        x: (localX + this.characterWidth / 2) / this.characterWidth * this.textureWidth,
        y: (localY + this.characterHeight / 2) / this.characterHeight * this.textureHeight
      };
    }

    beginStroke(worldPoint, charX, charY, rotationDegrees) {
      this._painting = true;
      this._lastTexPoint = this._worldToTexture(
        worldPoint.x,
        worldPoint.y,
        charX,
        charY,
        rotationDegrees
      );
      this._dab(this._lastTexPoint);
    }

    continueStroke(worldPoint, charX, charY, rotationDegrees) {
      if (!this._painting) {
        return;
      }
      const point = this._worldToTexture(
        worldPoint.x,
        worldPoint.y,
        charX,
        charY,
        rotationDegrees
      );
      this._line(this._lastTexPoint, point);
      this._lastTexPoint = point;
    }

    endStroke() {
      if (!this._painting) {
        return;
      }
      this._painting = false;
      this._lastTexPoint = null;
      // F-25: respeta el intervalo. Si toca esperar, programa el envío del último
      // estado en vez de forzarlo, para no saturar la red pintando en la búsqueda.
      this._sendSnapshot(false);
    }

    _dab(point) {
      const ctx = this.ctx;
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = this.color;
      ctx.beginPath();
      ctx.arc(point.x, point.y, this._radiusTexture(), 0, Math.PI * 2);
      ctx.fill();
      this._applyMask();
      this.hasPaint = true;
    }

    _line(from, to) {
      const ctx = this.ctx;
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = this.color;
      ctx.lineWidth = this._radiusTexture() * 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      this._applyMask();
      this.hasPaint = true;
    }

    /** Recorta la pintura a la silueta del monigote. */
    _applyMask() {
      if (!this.maskReady || !this.maskImage) {
        return;
      }
      const ctx = this.ctx;
      ctx.globalCompositeOperation = "destination-in";
      ctx.drawImage(this.maskImage, 0, 0, this.textureWidth, this.textureHeight);
      ctx.globalCompositeOperation = "source-over";
    }

    /**
     * Cuentagotas/tampón: lee el color de un píxel de un canvas (el del juego) en
     * coordenadas de pantalla CSS. Devuelve el color en hexadecimal o null.
     */
    sampleColorFromCanvas(gameCanvas, cssX, cssY, dpr) {
      try {
        const ctx = gameCanvas.getContext("2d");
        const px = Math.round(cssX * dpr);
        const py = Math.round(cssY * dpr);
        const data = ctx.getImageData(px, py, 1, 1).data;
        if (data[3] === 0) {
          return null;
        }
        return toHex(data[0], data[1], data[2]);
      } catch (error) {
        console.error("No se pudo leer el color del mapa:", error);
        return null;
      }
    }

    exportSnapshot() {
      return this.hasPaint ? this.canvas.toDataURL("image/png") : "";
    }

    /** Fuerza el envío del snapshot actual (por ejemplo al fijar la posición). */
    flush() {
      this._sendSnapshot(true);
    }

    _now() {
      return typeof performance !== "undefined" && performance.now
        ? performance.now()
        : 0;
    }

    _emitNow() {
      this._clearPendingSend();
      this._lastSnapshotAt = this._now();
      this.onSnapshot(this.exportSnapshot());
    }

    _clearPendingSend() {
      if (this._pendingSendId != null) {
        clearTimeout(this._pendingSendId);
        this._pendingSendId = null;
      }
    }

    /**
     * Envía el snapshot respetando el límite de frecuencia.
     * - force: envía ya (fijar, limpiar). Cancela cualquier envío pendiente.
     * - si no toca aún, programa un único envío diferido del último estado, de
     *   modo que el último trazo nunca se pierde (mismo problema que el F-10).
     */
    _sendSnapshot(force) {
      if (typeof this.onSnapshot !== "function") {
        return;
      }
      const elapsed = this._now() - this._lastSnapshotAt;
      if (force || elapsed >= this.snapshotMinIntervalMs) {
        this._emitNow();
        return;
      }
      if (this._pendingSendId != null) {
        return; // ya hay un envío diferido en cola; enviará el estado más reciente
      }
      const wait = this.snapshotMinIntervalMs - elapsed;
      this._pendingSendId = setTimeout(() => {
        this._pendingSendId = null;
        this._emitNow();
      }, wait);
    }
  }

  window.PaintEngine = PaintEngine;
})();
