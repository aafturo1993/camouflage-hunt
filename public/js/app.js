"use strict";

const socket = io();

const elements = {
  connectionPanel: document.querySelector("#connection-panel"),
  lobbyPanel: document.querySelector("#lobby-panel"),
  gamePanel: document.querySelector("#game-panel"),
  playerName: document.querySelector("#player-name"),
  roomCodeInput: document.querySelector("#room-code"),
  createRoom: document.querySelector("#create-room"),
  joinRoom: document.querySelector("#join-room"),
  connectionError: document.querySelector("#connection-error"),
  roomCodeTitle: document.querySelector("#room-code-title"),
  copyCode: document.querySelector("#copy-code"),
  connectionStatus: document.querySelector("#connection-status"),
  playerCount: document.querySelector("#player-count"),
  playerList: document.querySelector("#player-list"),
  readyButton: document.querySelector("#ready-button"),
  startButton: document.querySelector("#start-button"),
  lobbyMessage: document.querySelector("#lobby-message"),
  roundNumber: document.querySelector("#round-number"),
  phaseTitle: document.querySelector("#phase-title"),
  timer: document.querySelector("#timer"),
  gameStage: document.querySelector("#game-stage"),
  gameCanvas: document.querySelector("#game-canvas"),
  curtain: document.querySelector("#curtain"),
  roleTitle: document.querySelector("#role-title"),
  roleHelp: document.querySelector("#role-help"),
  cameraHint: document.querySelector("#camera-hint"),
  cameraControls: document.querySelector("#camera-controls"),
  ammoHud: document.querySelector("#ammo-hud"),
  ammoCount: document.querySelector("#ammo-count"),
  paintToolbar: document.querySelector("#paint-toolbar"),
  paintEyedropper: document.querySelector("#paint-eyedropper"),
  paintColor: document.querySelector("#paint-color"),
  paintWheel: document.querySelector("#paint-wheel"),
  paintClear: document.querySelector("#paint-clear"),
  zoomIn: document.querySelector("#zoom-in"),
  zoomOut: document.querySelector("#zoom-out"),
  finishRound: document.querySelector("#finish-round"),
  returnLobby: document.querySelector("#return-lobby"),
  gameMessage: document.querySelector("#game-message")
};

let roomState = null;
let countdownInterval = null;

let clientConfig = null;
let configPromise = null;
let renderer = null;

// Control del escenario y del disparo.
let lastStageKey = null;
let shotCooldownUntil = 0;
let shotsRemaining = 0;
let selfLocked = false;
// Última lista de personajes recibida; se guarda aunque el motor aún no exista (F-01).
let latestCharacters = [];
// Desfase entre el reloj del servidor y el del navegador, para la cuenta atrás (F-05).
let serverClockOffset = 0;

// Pintura (módulo 4).
let paintEngine = null;
let paintScriptPromise = null;
let paintToolbarWired = false;
let eyedropperActive = false;

function setHidden(element, hidden) {
  element.classList.toggle("hidden", hidden);
}

function setMessage(element, message = "", isError = false) {
  element.textContent = message;
  element.classList.toggle("error", isError);
}

function showConnectionPanel() {
  document.body.classList.remove("in-game");
  setHidden(elements.connectionPanel, false);
  setHidden(elements.lobbyPanel, true);
  setHidden(elements.gamePanel, true);
}

function showLobbyPanel() {
  document.body.classList.remove("in-game");
  setHidden(elements.connectionPanel, true);
  setHidden(elements.lobbyPanel, false);
  setHidden(elements.gamePanel, true);
}

function showGamePanel() {
  document.body.classList.add("in-game");
  setHidden(elements.connectionPanel, true);
  setHidden(elements.lobbyPanel, true);
  setHidden(elements.gamePanel, false);
}

/** Carga (una sola vez) la configuración pública de mundo, cámara y mapas. */
function ensureConfig() {
  if (clientConfig) {
    return Promise.resolve(clientConfig);
  }
  if (!configPromise) {
    configPromise = fetch("/api/config")
      .then((response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return response.json();
      })
      .then((config) => {
        clientConfig = config;
        return config;
      })
      .catch((error) => {
        configPromise = null;
        console.error("No se pudo cargar /api/config:", error);
        throw error;
      });
  }
  return configPromise;
}

function getMapById(mapId) {
  if (!clientConfig) {
    return null;
  }
  return clientConfig.maps.find((map) => map.id === mapId) ?? null;
}

function getZoomLimits(role) {
  const roles = clientConfig?.camera?.roles ?? {};
  return roles[role] ?? roles.UNASSIGNED ?? { minZoom: 1, maxZoom: 2.5 };
}

function ensureRenderer() {
  if (!renderer) {
    renderer = new window.GameRenderer(elements.gameCanvas);

    // Envío de la posición propia (escondido) al servidor, ya limitado en frecuencia.
    renderer.onSelfMove = (position) => {
      // F-21: recogemos el acuse. Si el servidor rechaza el movimiento lo
      // registramos en consola; no lo sacamos a la interfaz porque el movimiento
      // es continuo y saturaría el aviso.
      socket.emit("player:move", position, (response) => {
        if (response && !response.ok) {
          console.warn("Movimiento rechazado por el servidor:", response.message);
        }
      });
    };

    // Disparo del cazador (clic en el mapa durante la búsqueda).
    renderer.onShoot = (point) => {
      handleShoot(point);
    };

    // Pintura: el ratón en preparación pinta el monigote (o clona color con el
    // cuentagotas si está activo).
    renderer.onPaint = (type, world, screen) => {
      const anchor = renderer.getPaintAnchor();
      if (!paintEngine || !anchor) {
        return;
      }
      if (eyedropperActive) {
        if (type === "down") {
          const dpr = window.devicePixelRatio || 1;
          const hex = paintEngine.sampleColorFromCanvas(
            renderer.canvas,
            screen.x,
            screen.y,
            dpr
          );
          if (hex) {
            applyPaintColor(hex);
          }
          setEyedropper(false);
        }
        return; // mientras el cuentagotas está activo no se pinta
      }
      if (type === "down") {
        paintEngine.beginStroke(world, anchor.x, anchor.y, anchor.rotation);
      } else if (type === "move") {
        paintEngine.continueStroke(world, anchor.x, anchor.y, anchor.rotation);
      } else if (type === "up") {
        paintEngine.endStroke();
      }
    };

    // Fijar / soltar la posición del escondido con Enter.
    renderer.onLockToggle = (locked, position) => {
      selfLocked = locked;
      if (paintEngine) {
        paintEngine.flush(); // asegura que el servidor tiene la pintura final
      }
      if (roomState) {
        updateRoleTexts();
      }
      // F-21: recogemos el acuse. Si el servidor rechaza el fijado (por ejemplo
      // porque la fase acaba de cambiar), revertimos el estado local para no dejar
      // el cartel "FIJADO" y el cerco puestos sin que el servidor lo haya registrado.
      socket.emit(
        "player:lock",
        { locked, x: position.x, y: position.y, rotation: position.rotation },
        (response) => {
          if (response && !response.ok) {
            selfLocked = !locked;
            if (renderer) {
              renderer.setLocked(!locked);
            }
            if (roomState) {
              updateRoleTexts();
            }
            setMessage(elements.gameMessage, response.message, true);
          }
        }
      );
    };
  }
  if (clientConfig?.character) {
    renderer.setCharacterConfig(clientConfig.character);
  }
  return renderer;
}

async function handleShoot(point) {
  const now = Date.now();
  if (shotsRemaining <= 0) {
    setMessage(elements.gameMessage, "Sin disparos.", true);
    return;
  }
  if (now < shotCooldownUntil) {
    return; // recargando (bloqueo local para no saturar)
  }

  const cooldownMs = clientConfig?.hunter?.shotCooldownMs ?? 800;
  shotCooldownUntil = now + cooldownMs;

  const response = await emitWithAck("hunter:shoot", point);
  if (!response.ok) {
    setMessage(elements.gameMessage, response.message, true);
    return;
  }

  shotsRemaining = response.remaining;
  updateAmmoHud();
}

function updateAmmoHud() {
  elements.ammoCount.textContent = String(shotsRemaining);
}

// --- Pintura (módulo 4) -----------------------------------------------------

/**
 * Carga painting.js una sola vez. Se inyecta desde aquí para no depender de que
 * el <script> esté en index.html (ese archivo es de Diseño).
 */
function loadPaintScript() {
  if (!paintScriptPromise) {
    paintScriptPromise = new Promise((resolve, reject) => {
      if (window.PaintEngine) {
        resolve();
        return;
      }
      const script = document.createElement("script");
      script.src = "/js/painting.js";
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("No se pudo cargar painting.js"));
      document.head.appendChild(script);
    });
  }
  return paintScriptPromise;
}

/** Crea (si hace falta) y configura el motor de pintura. */
async function setupPaint() {
  try {
    await loadPaintScript();
  } catch (error) {
    console.error(error);
    return null;
  }
  if (!window.PaintEngine) {
    return null;
  }
  if (!paintEngine) {
    paintEngine = new window.PaintEngine();
    paintEngine.onSnapshot = (image) => {
      // F-26: recogemos el acuse. Si el servidor rechaza la pintura (pesa
      // demasiado, la fase ya no lo permite, o acaban de encontrarte), avisamos:
      // el jugador creería estar camuflado con algo que el servidor no tiene.
      socket.emit("paint:snapshot", { image }, (response) => {
        if (response && !response.ok) {
          setMessage(elements.gameMessage, response.message, true);
        }
      });
    };
  }
  if (clientConfig?.paint) {
    paintEngine.configure(clientConfig.paint, clientConfig.character);
  }
  if (renderer) {
    renderer.selfTextureCanvas = paintEngine.getCanvas();
  }
  if (!paintToolbarWired) {
    wirePaintToolbar();
    paintToolbarWired = true;
  }
  return paintEngine;
}

function wirePaintToolbar() {
  const brushSizes = clientConfig?.paint?.brushSizes ?? {};
  const brushButtons = document.querySelectorAll(".paint-brush");
  brushButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const radius = brushSizes[button.dataset.brush];
      if (paintEngine && radius) {
        paintEngine.setBrushWorldRadius(radius);
      }
      brushButtons.forEach((other) =>
        other.classList.toggle("is-active", other === button)
      );
    });
  });

  const defaultBrush = clientConfig?.paint?.defaultBrush ?? "s";
  const defaultButton = [...brushButtons].find(
    (button) => button.dataset.brush === defaultBrush
  );
  if (defaultButton) {
    defaultButton.click();
  }

  if (elements.paintEyedropper) {
    elements.paintEyedropper.addEventListener("click", () => {
      setEyedropper(!eyedropperActive);
    });
  }
  if (elements.paintClear) {
    elements.paintClear.addEventListener("click", () => {
      if (paintEngine) {
        paintEngine.clear();
      }
    });
  }

  // Rueda de color: el selector del navegador da cualquier tono, no solo los
  // de la paleta. "input" se dispara mientras se arrastra, así que el color de
  // pintura va cambiando en directo.
  if (elements.paintWheel) {
    elements.paintWheel.addEventListener("input", (event) => {
      applyPaintColor(event.target.value);
    });
  }

  buildPaintPalette();
  applyPaintColor(clientConfig?.paint?.defaultColor ?? "#6b7257");
}

/**
 * Rellena la rueda de colores. Si Diseño no ha puesto un contenedor `#paint-palette`,
 * inyectamos los colores en la barra con estilos en línea (funcional ya; Diseño lo
 * reestiliza cuando quiera).
 */
function buildPaintPalette() {
  const colors = clientConfig?.paint?.palette ?? [];
  let container = document.querySelector("#paint-palette");
  if (!container) {
    container = document.createElement("div");
    container.id = "paint-palette";
    container.className = "paint-palette";
    container.style.display = "flex";
    container.style.flexWrap = "wrap";
    container.style.gap = "0.2rem";
    const anchor = elements.paintColor ?? elements.paintClear;
    if (anchor?.parentNode) {
      anchor.parentNode.insertBefore(container, anchor);
    } else if (elements.paintToolbar) {
      elements.paintToolbar.appendChild(container);
    }
  }
  container.replaceChildren();
  for (const color of colors) {
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = "paint-swatch";
    swatch.dataset.color = color;
    swatch.title = color;
    swatch.style.background = color;
    swatch.style.width = "20px";
    swatch.style.height = "20px";
    swatch.style.minHeight = "20px";
    swatch.style.padding = "0";
    swatch.style.borderRadius = "4px";
    swatch.style.border = "1px solid rgba(255, 255, 255, 0.45)";
    swatch.addEventListener("click", () => applyPaintColor(color));
    container.appendChild(swatch);
  }
}

function applyPaintColor(hex) {
  if (paintEngine) {
    paintEngine.setColor(hex);
  }
  if (elements.paintColor) {
    elements.paintColor.style.background = hex;
  }
  // La rueda sigue al color actual, venga de donde venga (paleta o cuentagotas),
  // para que al abrirla parta de lo que se está usando. Solo admite #rrggbb.
  if (elements.paintWheel && /^#[0-9a-f]{6}$/i.test(hex)) {
    elements.paintWheel.value = hex;
  }
  document.querySelectorAll(".paint-swatch").forEach((swatch) => {
    swatch.classList.toggle("is-active", swatch.dataset.color === hex);
  });
}

function setEyedropper(active) {
  eyedropperActive = active;
  if (elements.paintEyedropper) {
    elements.paintEyedropper.classList.toggle("is-active", active);
  }
  if (renderer) {
    renderer.canvas.style.cursor = active ? "crosshair" : "";
  }
}

function emitWithAck(eventName, payload) {
  return new Promise((resolve) => {
    socket.timeout(5000).emit(eventName, payload, (error, response) => {
      if (error) {
        resolve({
          ok: false,
          message: "El servidor no ha respondido. Revisa la conexión."
        });
        return;
      }
      resolve(response);
    });
  });
}

function getName() {
  return elements.playerName.value.trim();
}

function getRoomCode() {
  return elements.roomCodeInput.value.trim().toUpperCase();
}

async function createRoom() {
  setMessage(elements.connectionError);
  const response = await emitWithAck("room:create", { name: getName() });

  if (!response.ok) {
    setMessage(elements.connectionError, response.message, true);
  }
}

async function joinRoom() {
  setMessage(elements.connectionError);
  const response = await emitWithAck("room:join", {
    name: getName(),
    roomCode: getRoomCode()
  });

  if (!response.ok) {
    setMessage(elements.connectionError, response.message, true);
  }
}

async function toggleReady() {
  if (!roomState) {
    return;
  }

  const me = roomState.players.find(
    (player) => player.id === roomState.viewer.id
  );
  const response = await emitWithAck("player:setReady", {
    ready: !me?.ready
  });

  if (!response.ok) {
    setMessage(elements.lobbyMessage, response.message, true);
  }
}

async function startGame() {
  setMessage(elements.lobbyMessage);
  const response = await emitWithAck("game:start", {});

  if (!response.ok) {
    setMessage(elements.lobbyMessage, response.message, true);
  }
}

async function finishRound() {
  setMessage(elements.gameMessage);
  const response = await emitWithAck("game:finishRound", {});

  if (!response.ok) {
    setMessage(elements.gameMessage, response.message, true);
  }
}

async function returnToLobby() {
  setMessage(elements.gameMessage);
  const response = await emitWithAck("game:returnToLobby", {});

  if (!response.ok) {
    setMessage(elements.gameMessage, response.message, true);
  }
}

async function copyRoomCode() {
  if (!roomState?.code) {
    return;
  }

  try {
    await navigator.clipboard.writeText(roomState.code);
    elements.copyCode.textContent = "Copiado";
    setTimeout(() => {
      elements.copyCode.textContent = "Copiar código";
    }, 1200);
  } catch {
    setMessage(
      elements.lobbyMessage,
      `Código de sala: ${roomState.code}`,
      false
    );
  }
}

function renderPlayers() {
  elements.playerList.replaceChildren();

  for (const player of roomState.players) {
    const item = document.createElement("li");
    item.className = "player-row";

    const meta = document.createElement("div");
    meta.className = "player-meta";

    const name = document.createElement("strong");
    name.textContent =
      player.id === roomState.viewer.id ? `${player.name} (tú)` : player.name;
    meta.append(name);

    if (player.isHost) {
      const hostBadge = document.createElement("span");
      hostBadge.className = "badge";
      hostBadge.textContent = "ANFITRIÓN";
      meta.append(hostBadge);
    }

    const state = document.createElement("span");
    const readyForDisplay = player.isHost || player.ready;
    state.className = readyForDisplay ? "ready" : "not-ready";
    state.textContent = readyForDisplay ? "Preparado" : "Sin preparar";

    item.append(meta, state);
    elements.playerList.append(item);
  }
}

function renderLobby() {
  showLobbyPanel();
  setMessage(elements.lobbyMessage);

  elements.roomCodeTitle.textContent = roomState.code;
  elements.playerCount.textContent = `${roomState.players.length} ${
    roomState.players.length === 1 ? "jugador" : "jugadores"
  }`;

  renderPlayers();

  const me = roomState.players.find(
    (player) => player.id === roomState.viewer.id
  );

  elements.readyButton.textContent = me?.ready
    ? "Ya no estoy preparado"
    : "Estoy preparado";

  setHidden(elements.readyButton, roomState.viewer.isHost);
  setHidden(elements.startButton, !roomState.viewer.isHost);

  const minPlayers = clientConfig?.limits?.minPlayers ?? 2;
  const everyoneReady = roomState.players.every(
    (player) => player.isHost || player.ready
  );
  elements.startButton.disabled =
    roomState.players.length < minPlayers || !everyoneReady;

  if (roomState.viewer.isHost && roomState.players.length < minPlayers) {
    setMessage(
      elements.lobbyMessage,
      "Comparte el código y espera al menos a otro jugador."
    );
  } else if (roomState.viewer.isHost && !everyoneReady) {
    setMessage(
      elements.lobbyMessage,
      "Espera a que todos marquen que están preparados."
    );
  }
}

function getPhaseLabel(phase) {
  const labels = {
    PREPARATION: "Preparación",
    SEARCH: "Búsqueda",
    RESULTS: "Resultados"
  };
  return labels[phase] ?? phase;
}

/**
 * Decide si el jugador actual puede ver el mapa.
 * El cazador NO ve el mapa durante la preparación (solo el telón).
 */
function canViewMap() {
  const isHunter = roomState.viewer.role === "HUNTER";
  if (roomState.phase === "PREPARATION" && isHunter) {
    return false;
  }
  return (
    roomState.phase === "PREPARATION" ||
    roomState.phase === "SEARCH" ||
    roomState.phase === "RESULTS"
  );
}

function updateRoleTexts() {
  const isHunter = roomState.viewer.role === "HUNTER";

  if (roomState.phase === "PREPARATION") {
    if (isHunter) {
      elements.roleTitle.textContent = "Eres el cazador";
      elements.roleHelp.textContent =
        "Tu pantalla permanece tapada mientras los demás se esconden.";
    } else if (selfLocked) {
      elements.roleTitle.textContent = "Posición fijada";
      elements.roleHelp.textContent =
        "Has fijado tu posición. Pulsa Enter para soltarla y volver a moverte.";
    } else {
      elements.roleTitle.textContent = "Escóndete y camúflate";
      elements.roleHelp.textContent =
        "Muévete con las flechas o WASD, gira con R y pulsa Enter para fijar tu posición.";
    }
  } else if (roomState.phase === "SEARCH") {
    if (isHunter) {
      elements.roleTitle.textContent = "¡Encuentra a todos!";
      elements.roleHelp.textContent =
        "Recorre el mapa arrastrando y haz clic sobre un personaje para disparar.";
    } else {
      elements.roleTitle.textContent = "Permanece inmóvil";
      elements.roleHelp.textContent =
        "Observa el mapa mientras el cazador busca.";
    }
  } else {
    elements.roleTitle.textContent = "Ronda terminada";
    elements.roleHelp.textContent =
      "El siguiente módulo añadirá resultados, puntuación y cambio de mapa.";
  }
}

/** Configura el escenario (canvas, telón, personaje, disparo) según fase y rol. */
async function updateStage() {
  const showMap = canViewMap();
  const isHunter = roomState.viewer.role === "HUNTER";
  const phase = roomState.phase;

  setHidden(elements.curtain, showMap);
  setHidden(elements.cameraControls, !showMap);
  setHidden(elements.cameraHint, !showMap);
  setHidden(elements.ammoHud, !(isHunter && phase === "SEARCH"));

  if (!showMap) {
    // El cazador durante la preparación no carga ni dibuja el mapa.
    if (renderer) {
      renderer.stop();
    }
    lastStageKey = null;
    return;
  }

  let config;
  try {
    config = await ensureConfig();
  } catch {
    setMessage(
      elements.gameMessage,
      "No se ha podido cargar la configuración del mapa.",
      true
    );
    return;
  }

  // El estado pudo cambiar mientras se cargaba la configuración.
  if (!roomState || !canViewMap()) {
    return;
  }

  const map = getMapById(roomState.mapId) ?? config.maps[0];
  if (!map) {
    setMessage(elements.gameMessage, "No hay ningún mapa configurado.", true);
    return;
  }

  const engine = ensureRenderer();
  const limits = getZoomLimits(roomState.viewer.role);

  engine.setViewerId(roomState.viewer.id);
  engine.setZoomStep(config.camera?.zoomStep);
  // F-14: aplicar los límites de zoom del rol ANTES de cargar el mapa, que fija
  // el zoom inicial al mínimo.
  engine.setZoomLimits(limits.minZoom, limits.maxZoom);
  engine.loadMap(map);
  elements.gameCanvas.classList.toggle("aiming", isHunter && phase === "SEARCH");

  // Inicialización pesada del modo solo cuando cambia fase / rol / ronda,
  // para no reiniciar la posición del personaje en cada actualización.
  const stageKey = `${phase}:${roomState.viewer.role}:${roomState.round}`;
  const stageChanged = stageKey !== lastStageKey;
  if (stageChanged) {
    lastStageKey = stageKey;
    // F-09: el mensaje de juego solo se limpia al cambiar de fase, no en cada
    // actualización, para que los avisos de disparo no desaparezcan solos.
    setMessage(elements.gameMessage);

    if (phase === "PREPARATION") {
      selfLocked = false;
      latestCharacters = [];
      engine.setModePrepHider(roomState.viewer.position);
    } else if (phase === "SEARCH") {
      engine.setModeSearch({ shoot: isHunter });
    } else {
      engine.setModeSearch({ shoot: false });
    }
  }

  // F-01: vuelca la lista de personajes recibida aunque llegara antes de existir
  // el motor (puede pasar con transporte polling).
  if (phase === "SEARCH" || phase === "RESULTS") {
    engine.setCharacters(latestCharacters);
  }

  engine.start();

  // Pintura: el escondido puede pintar en preparación y también en la búsqueda
  // mientras no lo hayan encontrado (por si no le dio tiempo). Al cazarle, se acabó.
  const canPaint =
    !isHunter &&
    !roomState.viewer.found &&
    (phase === "PREPARATION" || phase === "SEARCH");

  if (elements.paintToolbar) {
    setHidden(elements.paintToolbar, !canPaint);
  }

  if (!canPaint) {
    setEyedropper(false);
    engine.setPaintAnchor(null);
  } else {
    setupPaint().then((paint) => {
      if (!paint) {
        return;
      }
      // Solo se reinicia el lienzo al empezar una preparación nueva, nunca al
      // pasar a búsqueda: allí se sigue con la misma pintura.
      if (stageChanged && phase === "PREPARATION") {
        paint.reset();
        paint.flush();
      }
    });
    if (phase === "SEARCH") {
      refreshPaintAnchor();
    }
  }
}

/** Fija en el motor el punto de pintura en búsqueda: el propio monigote congelado. */
function refreshPaintAnchor() {
  if (!renderer || !roomState) {
    return;
  }
  if (
    roomState.phase !== "SEARCH" ||
    roomState.viewer.role !== "HIDER" ||
    roomState.viewer.found
  ) {
    renderer.setPaintAnchor(null);
    return;
  }
  const own = latestCharacters.find(
    (character) => character.id === roomState.viewer.id
  );
  const position = own ?? roomState.viewer.position;
  if (position) {
    renderer.setPaintAnchor({
      x: position.x,
      y: position.y,
      rotation: own?.rotation ?? 0
    });
  }
}

function renderGame() {
  showGamePanel();

  const isHost = roomState.viewer.isHost;

  elements.roundNumber.textContent = String(roomState.round);
  elements.phaseTitle.textContent = getPhaseLabel(roomState.phase);

  updateRoleTexts();

  if (roomState.viewer.shots) {
    shotsRemaining = roomState.viewer.shots.remaining;
    updateAmmoHud();
  }

  // F-22: el anfitrión puede cortar la ronda tanto en preparación como en búsqueda
  // (el servidor ya lo permite). Útil para abortar una preparación empezada por error,
  // incluso si el anfitrión es el cazador y está tras el telón.
  const canFinishRound =
    isHost &&
    (roomState.phase === "PREPARATION" || roomState.phase === "SEARCH");
  setHidden(elements.finishRound, !canFinishRound);
  setHidden(elements.returnLobby, !(isHost && roomState.phase === "RESULTS"));

  updateStage();
  startCountdown();
}

function startCountdown() {
  clearInterval(countdownInterval);

  const paintTimer = () => {
    if (!roomState?.phaseEndsAt) {
      elements.timer.textContent = "--:--";
      return;
    }

    // F-05: usamos el reloj del servidor (hora local + desfase) en vez del reloj
    // del navegador, que puede ir desincronizado entre dispositivos.
    const estimatedServerNow = Date.now() + serverClockOffset;
    const milliseconds = Math.max(0, roomState.phaseEndsAt - estimatedServerNow);
    const totalSeconds = Math.ceil(milliseconds / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    elements.timer.textContent = `${String(minutes).padStart(2, "0")}:${String(
      seconds
    ).padStart(2, "0")}`;
  };

  paintTimer();
  countdownInterval = setInterval(paintTimer, 250);
}

function render() {
  if (!roomState) {
    if (renderer) {
      renderer.stop();
    }
    showConnectionPanel();
    return;
  }

  if (roomState.phase === "LOBBY") {
    clearInterval(countdownInterval);
    if (renderer) {
      renderer.stop();
    }
    lastStageKey = null;
    renderLobby();
  } else {
    renderGame();
  }
}

elements.createRoom.addEventListener("click", createRoom);
elements.joinRoom.addEventListener("click", joinRoom);
elements.readyButton.addEventListener("click", toggleReady);
elements.startButton.addEventListener("click", startGame);
elements.copyCode.addEventListener("click", copyRoomCode);
elements.finishRound.addEventListener("click", finishRound);
elements.returnLobby.addEventListener("click", returnToLobby);

elements.zoomIn.addEventListener("click", () => {
  renderer?.zoomInCentered();
});
elements.zoomOut.addEventListener("click", () => {
  renderer?.zoomOutCentered();
});

elements.roomCodeInput.addEventListener("input", () => {
  elements.roomCodeInput.value = getRoomCode();
});

socket.on("connect", () => {
  elements.connectionStatus.textContent = "Conectado";

  // F-06: al reconectar, Socket.IO trae un id nuevo y el servidor ya no nos
  // conoce. Si teníamos una partida en marcha, la descartamos y volvemos a la
  // pantalla de entrada en vez de dejar una pantalla que parece correcta pero
  // no responde.
  if (roomState) {
    roomState = null;
    render();
    setMessage(
      elements.connectionError,
      "Se perdió la conexión. Vuelve a entrar en la sala.",
      true
    );
  }
});

socket.on("disconnect", () => {
  elements.connectionStatus.textContent = "Sin conexión";
  setMessage(
    elements.lobbyMessage,
    "Se ha perdido la conexión con el servidor.",
    true
  );
  setMessage(
    elements.gameMessage,
    "Se ha perdido la conexión con el servidor.",
    true
  );
});

socket.on("room:state", (nextState) => {
  // F-05: guardamos el desfase con el reloj del servidor al recibir el estado.
  if (typeof nextState.serverNow === "number") {
    serverClockOffset = nextState.serverNow - Date.now();
  }
  roomState = nextState;
  render();
});

socket.on("game:characters", (payload) => {
  // F-01: guardamos siempre la lista, aunque el motor todavía no exista.
  latestCharacters = payload?.characters ?? [];
  if (renderer) {
    renderer.setCharacters(latestCharacters);
    refreshPaintAnchor();
  }
});

socket.on("game:paint", (payload) => {
  // Pintura en vivo de un escondido durante la búsqueda.
  if (!payload || !renderer) {
    return;
  }
  const character = latestCharacters.find((entry) => entry.id === payload.id);
  if (character) {
    character.paint = payload.paint ?? null;
  }
  renderer.setCharacters(latestCharacters);
});

socket.on("game:shot", (payload) => {
  if (renderer && payload) {
    renderer.spawnShot(payload.x, payload.y, payload.hit);
  }
});

// Precargamos la configuración para que el mapa aparezca sin esperas al entrar en juego.
ensureConfig().catch(() => {
  /* Se reintentará al entrar en la fase de juego. */
});

showConnectionPanel();
