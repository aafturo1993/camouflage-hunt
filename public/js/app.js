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
  }
  return renderer;
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
    } else {
      elements.roleTitle.textContent = "Escóndete y camúflate";
      elements.roleHelp.textContent =
        "Explora el mapa con arrastre y zoom. El movimiento y la pintura llegan en los próximos módulos.";
    }
  } else if (roomState.phase === "SEARCH") {
    if (isHunter) {
      elements.roleTitle.textContent = "¡Encuentra a todos!";
      elements.roleHelp.textContent =
        "El telón se ha abierto. Recorre el mapa con arrastre y zoom limitado.";
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

/** Configura el escenario (canvas + telón) según fase y rol. */
async function updateStage() {
  const showMap = canViewMap();

  setHidden(elements.curtain, showMap);
  setHidden(elements.cameraControls, !showMap);
  setHidden(elements.cameraHint, !showMap);

  if (!showMap) {
    // El cazador durante la preparación no carga ni dibuja el mapa.
    if (renderer) {
      renderer.stop();
    }
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

  engine.loadMap(map);
  engine.setZoomLimits(limits.minZoom, limits.maxZoom);
  engine.start();
}

function renderGame() {
  showGamePanel();
  setMessage(elements.gameMessage);

  const isHost = roomState.viewer.isHost;

  elements.roundNumber.textContent = String(roomState.round);
  elements.phaseTitle.textContent = getPhaseLabel(roomState.phase);

  updateRoleTexts();

  setHidden(elements.finishRound, !(isHost && roomState.phase === "SEARCH"));
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

    const milliseconds = Math.max(0, roomState.phaseEndsAt - Date.now());
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
  roomState = nextState;
  render();
});

// Precargamos la configuración para que el mapa aparezca sin esperas al entrar en juego.
ensureConfig().catch(() => {
  /* Se reintentará al entrar en la fase de juego. */
});

showConnectionPanel();
