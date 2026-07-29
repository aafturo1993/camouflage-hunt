"use strict";

const path = require("node:path");
const http = require("node:http");
const express = require("express");
const { Server } = require("socket.io");

const {
  WORLD,
  CAMERA,
  CHARACTER,
  HUNTER,
  PAINT,
  SCORING,
  TIMERS,
  LIMITS,
  DEFAULT_MAP_ID
} = require("./src/config/gameConfig");
const maps = require("./src/config/maps");

const PORT = Number(process.env.PORT) || 3000;
const PREPARATION_SECONDS = TIMERS.preparationSeconds;
const SEARCH_SECONDS = TIMERS.searchSeconds;
const MAX_PLAYERS = LIMITS.maxPlayers;
const MIN_PLAYERS = LIMITS.minPlayers;

/** Log con marca de tiempo. Simple a propósito: sale por la salida estándar,
 *  que es lo que recogen Docker y el servidor de la empresa. */
function log(message, extra) {
  const stamp = new Date().toISOString();
  if (extra !== undefined) {
    console.log(`[${stamp}] ${message}`, extra);
  } else {
    console.log(`[${stamp}] ${message}`);
  }
}

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  serveClient: true,
  transports: ["websocket", "polling"]
});

app.disable("x-powered-by");
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_request, response) => {
  response.json({
    status: "ok",
    rooms: rooms.size,
    timestamp: new Date().toISOString()
  });
});

/**
 * Configuración pública que necesita el cliente para el motor de mapa y cámara.
 * El cliente la carga una sola vez al arrancar.
 */
app.get("/api/config", (_request, response) => {
  response.json({
    world: WORLD,
    camera: CAMERA,
    character: CHARACTER,
    hunter: { shotCooldownMs: HUNTER.shotCooldownMs, extraShots: HUNTER.extraShots },
    paint: PAINT,
    scoring: SCORING,
    limits: LIMITS,
    maps
  });
});

/**
 * Las salas viven en memoria.
 * Reiniciar el servidor elimina las partidas, algo aceptable para el prototipo.
 *
 * room = {
 *   code,
 *   hostId,
 *   players: Map<socketId, player>,
 *   phase: "LOBBY" | "PREPARATION" | "SEARCH" | "RESULTS",
 *   hunterId,
 *   lastHunterId,        // último cazador, para evitar repeticiones seguidas
 *   hunterHistory,       // historial sencillo de cazadores de la sesión
 *   round,
 *   mapId,
 *   phaseEndsAt,
 *   phaseTimer
 * }
 */
const rooms = new Map();

function normalizeName(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 24);
}

function normalizeRoomCode(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 5);
}

function createRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  for (let attempt = 0; attempt < 100; attempt += 1) {
    let code = "";
    for (let index = 0; index < 5; index += 1) {
      code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    if (!rooms.has(code)) {
      return code;
    }
  }

  throw new Error("No se ha podido generar un código de sala.");
}

function getPlayerRoom(socket) {
  const roomCode = socket.data.roomCode;
  if (!roomCode) {
    return null;
  }
  return rooms.get(roomCode) ?? null;
}

/** Devuelve un mapId válido del catálogo, o el mapa por defecto si no lo es. */
function resolveMapId(value) {
  const exists = maps.some((map) => map.id === value);
  return exists ? value : DEFAULT_MAP_ID;
}

function clampNumber(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Deja el ángulo en un múltiplo exacto del paso de rotación, dentro de [0, 360).
 * Lo que llega del cliente no es de fiar, así que aquí se redondea.
 */
function normalizeRotation(value) {
  const degrees = Number(value);
  if (!Number.isFinite(degrees)) {
    return 0;
  }
  const step = CHARACTER.rotationStepDegrees;
  const snapped = Math.round(degrees / step) * step;
  return ((snapped % 360) + 360) % 360;
}

/**
 * Medio ancho y medio alto que ocupa el personaje medidos sobre los ejes del
 * mapa. De pie ocupa 37 × 66, pero tumbado 45° la diagonal es más larga, así
 * que el sitio que necesita depende del ángulo.
 */
function characterHalfExtent(rotationDegrees, padX = 0, padY = 0) {
  const radians = (rotationDegrees * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  const halfWidth = CHARACTER.width / 2 + padX;
  const halfHeight = CHARACTER.height / 2 + padY;
  return {
    x: cos * halfWidth + sin * halfHeight,
    y: sin * halfWidth + cos * halfHeight
  };
}

/** Mantiene el CENTRO del personaje dentro del mapa. */
function clampPosition(position, rotationDegrees = 0) {
  const half = characterHalfExtent(rotationDegrees);
  return {
    x: Math.round(clampNumber(position.x, half.x, WORLD.width - half.x)),
    y: Math.round(clampNumber(position.y, half.y, WORLD.height - half.y))
  };
}

function randomStartPosition() {
  const halfWidth = CHARACTER.width / 2;
  const halfHeight = CHARACTER.height / 2;
  return {
    x: Math.round(halfWidth + Math.random() * (WORLD.width - CHARACTER.width)),
    y: Math.round(halfHeight + Math.random() * (WORLD.height - CHARACTER.height))
  };
}

/**
 * Genera una posición de salida separada de las ya colocadas.
 * Evita que dos escondidos nazcan uno encima de otro (ver F-07).
 */
function spawnAwayFrom(existing, minGap) {
  let candidate = randomStartPosition();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    candidate = randomStartPosition();
    const tooClose = existing.some(
      (position) => Math.hypot(position.x - candidate.x, position.y - candidate.y) < minGap
    );
    if (!tooClose) {
      return candidate;
    }
  }
  return candidate;
}

/**
 * ¿El punto (x, y) de mundo cae dentro de la caja del personaje?
 *
 * Si el monigote está girado, su caja ya no está alineada con los ejes del
 * mapa. En vez de agrandar la caja (que dejaría dar por acertado un disparo
 * al aire), giramos el disparo al revés hasta el sistema del personaje y ahí
 * la comprobación vuelve a ser un rectángulo recto.
 */
function isInsideCharacter(x, y, position, rotationDegrees = 0) {
  const radians = (-rotationDegrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = x - position.x;
  const dy = y - position.y;
  const localX = dx * cos - dy * sin;
  const localY = dx * sin + dy * cos;
  return (
    Math.abs(localX) <= CHARACTER.width / 2 + HUNTER.hitPaddingX &&
    Math.abs(localY) <= CHARACTER.height / 2 + HUNTER.hitPaddingY
  );
}

/** Lista de personajes visible en búsqueda (sin nombres: el cazador no debe verlos). */
function characterList(room) {
  // En los resultados se revela quién es cada monigote; durante la búsqueda no,
  // para que el cazador no vea los nombres.
  const revealNames = room.phase === "RESULTS";
  return [...room.players.values()]
    .filter((player) => player.id !== room.hunterId && player.position)
    .map((player) => ({
      id: player.id,
      x: player.position.x,
      y: player.position.y,
      rotation: player.rotation ?? 0,
      found: player.found,
      name: revealNames ? player.name : undefined,
      // La pintura del jugador (snapshot). Solo viaja en búsqueda/resultados.
      paint: player.paint ?? null
    }));
}

function emitCharacters(room) {
  if (room.phase === "PREPARATION") {
    // Durante la preparación los escondidos se ven entre ellos, para poder
    // repartirse el mapa y no acabar tres detrás del mismo arbusto. El cazador
    // queda fuera del envío: tiene el telón puesto, pero si las posiciones le
    // llegaran al navegador tendría la partida resuelta antes de empezar.
    io.to(room.code)
      .except(room.hunterId)
      .emit("game:characters", { characters: characterList(room) });
    return;
  }
  if (room.phase !== "SEARCH" && room.phase !== "RESULTS") {
    return;
  }
  io.to(room.code).emit("game:characters", { characters: characterList(room) });
}

function publicRoomState(room, viewerId) {
  const players = [...room.players.values()].map((player) => ({
    id: player.id,
    name: player.name,
    ready: player.ready,
    connected: player.connected,
    isHost: player.id === room.hostId,
    found: player.found
  }));

  const viewer = room.players.get(viewerId);
  const viewerRole =
    room.hunterId === viewerId
      ? "HUNTER"
      : room.phase === "LOBBY"
        ? "UNASSIGNED"
        : "HIDER";

  const isHiderInPlay =
    viewerRole === "HIDER" &&
    (room.phase === "PREPARATION" || room.phase === "SEARCH");

  const isHunterSearching =
    viewerRole === "HUNTER" && room.phase === "SEARCH";

  return {
    code: room.code,
    phase: room.phase,
    round: room.round,
    mapId: room.mapId,
    phaseEndsAt: room.phaseEndsAt,
    // Reloj del servidor: el cliente calcula su desfase y no depende de su propia hora.
    serverNow: Date.now(),
    players,
    viewer: {
      id: viewerId,
      name: viewer?.name ?? "",
      role: viewerRole,
      isHost: room.hostId === viewerId,
      // Si al propio escondido ya lo han encontrado (deja de poder pintar).
      found: Boolean(viewer?.found),
      // Solo el propio escondido recibe su posición (el cazador nunca la ve).
      position: isHiderInPlay && viewer?.position ? viewer.position : null,
      // Munición solo para el cazador durante la búsqueda.
      shots: isHunterSearching
        ? {
            remaining: room.hunterShotsRemaining,
            cooldownMs: HUNTER.shotCooldownMs
          }
        : null
    },
    hunter:
      room.phase === "SEARCH" || room.phase === "RESULTS"
        ? {
            id: room.hunterId,
            name: room.players.get(room.hunterId)?.name ?? "Cazador"
          }
        : null,
    // Resultados de la ronda y clasificación de la sesión (módulo 6).
    results:
      room.phase === "RESULTS"
        ? {
            hunterName: room.players.get(room.hunterId)?.name ?? "Cazador",
            rows: room.roundResults ?? [],
            standings: [...room.players.values()]
              .filter((player) => player.id !== room.hunterId)
              .map((player) => ({
                id: player.id,
                name: player.name,
                sessionScore: player.sessionScore ?? 0
              }))
              .sort((a, b) => b.sessionScore - a.sessionScore)
          }
        : null
  };
}

function emitRoomState(room) {
  for (const player of room.players.values()) {
    io.to(player.id).emit("room:state", publicRoomState(room, player.id));
  }
}

function clearPhaseTimer(room) {
  if (room.phaseTimer) {
    clearTimeout(room.phaseTimer);
    room.phaseTimer = null;
  }
}

function schedulePhase(room, seconds, nextPhase) {
  clearPhaseTimer(room);
  room.phaseEndsAt = Date.now() + seconds * 1000;

  room.phaseTimer = setTimeout(() => {
    if (!rooms.has(room.code)) {
      return;
    }
    nextPhase(room);
  }, seconds * 1000);
}

/**
 * Selecciona un cazador entre los jugadores conectados evitando,
 * cuando es posible, repetir al cazador de la ronda anterior.
 */
function pickHunter(room, connectedPlayers) {
  let candidates = connectedPlayers;

  if (connectedPlayers.length > 1 && room.lastHunterId) {
    const withoutPrevious = connectedPlayers.filter(
      (player) => player.id !== room.lastHunterId
    );
    if (withoutPrevious.length > 0) {
      candidates = withoutPrevious;
    }
  }

  return candidates[Math.floor(Math.random() * candidates.length)];
}

function beginPreparation(room) {
  const connectedPlayers = [...room.players.values()].filter(
    (player) => player.connected
  );

  if (connectedPlayers.length < MIN_PLAYERS) {
    throw new Error(`Se necesitan al menos ${MIN_PLAYERS} jugadores.`);
  }

  room.round += 1;
  room.phase = "PREPARATION";

  // Modo pruebas: con un solo jugador no hay cazador; ese jugador es escondido
  // y puede ver el mapa para validar la cámara. Con 2+ se elige cazador normal.
  if (connectedPlayers.length >= 2) {
    const hunter = pickHunter(room, connectedPlayers);
    room.hunterId = hunter.id;
    room.lastHunterId = hunter.id;
    room.hunterHistory.push(hunter.id);
  } else {
    room.hunterId = null;
  }

  const placed = [];
  for (const player of room.players.values()) {
    player.ready = false;
    player.found = false;
    player.locked = false;
    // Cada ronda se empieza de pie.
    player.rotation = 0;
    // Cada ronda se empieza sin pintura.
    player.paint = null;
    // Datos de puntuación de la ronda (módulo 6).
    player.foundAt = null;
    player.camouflageCount = 0;
    player.roundScore = 0;
    // El cazador no tiene personaje; cada escondido nace en un punto aleatorio
    // separado del resto para que no aparezcan superpuestos.
    if (player.id === room.hunterId) {
      player.position = null;
      continue;
    }
    player.position = spawnAwayFrom(placed, CHARACTER.width);
    placed.push(player.position);
  }

  log(
    `Sala ${room.code}: ronda ${room.round} · preparación · ` +
      `${connectedPlayers.length} jugadores · cazador ${room.hunterId ? room.players.get(room.hunterId)?.name : "—"}`
  );
  schedulePhase(room, PREPARATION_SECONDS, beginSearch);
  emitRoomState(room);
  // Posiciones de salida, para que cada escondido vea desde el principio dónde
  // están los demás. Solo lo reciben ellos.
  emitCharacters(room);
}

function beginSearch(room) {
  room.phase = "SEARCH";

  const hiders = [...room.players.values()].filter(
    (player) => player.id !== room.hunterId && player.connected
  );
  // Munición = escondidos + extra. Las posiciones quedan congeladas en este punto.
  room.hunterShotsRemaining = hiders.length + HUNTER.extraShots;
  room.lastShotAt = 0;
  // Puntuación: desde aquí se cuenta el tiempo de supervivencia.
  room.searchStartedAt = Date.now();
  room.aim = null;

  log(`Sala ${room.code}: ronda ${room.round} · búsqueda · ${room.hunterShotsRemaining} disparos`);
  schedulePhase(room, SEARCH_SECONDS, finishRound);
  emitRoomState(room);
  emitCharacters(room);
}

/**
 * Detecta "apuntar sin disparar": el cursor del cazador se posa sobre un escondido
 * durante SCORING.aimDwellMs y se le concede un bonus de camuflaje (con tope). Cada
 * episodio (entrar el cursor, quedarse y salir) da como mucho un bonus.
 */
function processAim(room, x, y) {
  let target = null;
  for (const player of room.players.values()) {
    if (player.id === room.hunterId || player.found || !player.position) {
      continue;
    }
    if (isInsideCharacter(x, y, player.position, player.rotation ?? 0)) {
      target = player;
      break;
    }
  }

  if (!target) {
    room.aim = null;
    return;
  }

  const now = Date.now();
  if (!room.aim || room.aim.hiderId !== target.id) {
    room.aim = { hiderId: target.id, since: now, credited: false };
    return;
  }

  if (room.aim.credited || now - room.aim.since < SCORING.aimDwellMs) {
    return;
  }

  if ((target.camouflageCount ?? 0) < SCORING.hider.maxCamouflageBonuses) {
    target.camouflageCount = (target.camouflageCount ?? 0) + 1;
    room.aim.credited = true;
    // Aviso solo al escondido: su camuflaje ha funcionado.
    io.to(target.id).emit("game:camouflage", {
      count: target.camouflageCount
    });
  }
}

/**
 * Calcula la puntuación de la ronda (solo escondidos) y la acumula en la sesión.
 * Deja el desglose en room.roundResults para enviarlo en los resultados.
 */
function computeRoundScores(room, endedAt) {
  const rows = [];
  if (!room.searchStartedAt) {
    room.roundResults = rows; // ronda abortada en preparación: sin puntos
    return;
  }

  for (const player of room.players.values()) {
    if (player.id === room.hunterId) {
      continue;
    }
    const untilMs = (player.foundAt ?? endedAt) - room.searchStartedAt;
    const survivalSeconds = Math.max(0, Math.floor(untilMs / 1000));
    const camouflageBonuses = Math.min(
      player.camouflageCount ?? 0,
      SCORING.hider.maxCamouflageBonuses
    );

    const survivalPoints = survivalSeconds * SCORING.hider.perSecondHidden;
    const survivalBonus = player.found ? 0 : SCORING.hider.survivalBonus;
    const camouflagePoints = camouflageBonuses * SCORING.hider.camouflageBonus;
    const roundScore = survivalPoints + survivalBonus + camouflagePoints;

    player.roundScore = roundScore;
    player.sessionScore = (player.sessionScore ?? 0) + roundScore;

    rows.push({
      id: player.id,
      name: player.name,
      found: player.found,
      survivalSeconds,
      camouflageBonuses,
      roundScore
    });
  }

  rows.sort((a, b) => b.roundScore - a.roundScore);
  room.roundResults = rows;
}

function finishRound(room) {
  clearPhaseTimer(room);
  computeRoundScores(room, Date.now());
  room.phase = "RESULTS";
  room.phaseEndsAt = null;
  room.aim = null;
  log(`Sala ${room.code}: ronda ${room.round} · resultados`);
  emitRoomState(room);
  // Revelado: se reenvía la lista con los nombres para que todos vean dónde y
  // cómo se camufló cada monigote, cazados y supervivientes.
  emitCharacters(room);
}

function resetToLobby(room) {
  clearPhaseTimer(room);
  room.phase = "LOBBY";
  room.hunterId = null;
  room.phaseEndsAt = null;

  for (const player of room.players.values()) {
    player.ready = false;
    player.found = false;
  }

  emitRoomState(room);
}

function removeSocketFromPreviousRoom(socket) {
  const previousRoom = getPlayerRoom(socket);
  if (!previousRoom) {
    return;
  }

  previousRoom.players.delete(socket.id);
  socket.leave(previousRoom.code);
  socket.data.roomCode = null;

  if (previousRoom.players.size === 0) {
    clearPhaseTimer(previousRoom);
    rooms.delete(previousRoom.code);
    return;
  }

  if (previousRoom.hostId === socket.id) {
    previousRoom.hostId = previousRoom.players.keys().next().value;
  }

  if (previousRoom.hunterId === socket.id && previousRoom.phase !== "LOBBY") {
    resetToLobby(previousRoom);
    return;
  }

  emitRoomState(previousRoom);
}

function addPlayerToRoom(socket, room, name) {
  const duplicateName = [...room.players.values()].some(
    (player) => player.name.toLocaleLowerCase("es") === name.toLocaleLowerCase("es")
  );

  if (duplicateName) {
    throw new Error("Ese nombre ya está utilizado en la sala.");
  }

  if (room.players.size >= MAX_PLAYERS) {
    throw new Error(`La sala admite un máximo de ${MAX_PLAYERS} jugadores.`);
  }

  const player = {
    id: socket.id,
    name,
    ready: false,
    connected: true,
    found: false,
    position: null,
    locked: false,
    rotation: 0,
    paint: null,
    // Puntuación (módulo 6). El acumulado de sesión persiste entre rondas.
    foundAt: null,
    camouflageCount: 0,
    roundScore: 0,
    sessionScore: 0
  };

  room.players.set(socket.id, player);
  socket.data.roomCode = room.code;
  socket.join(room.code);
  emitRoomState(room);
}

io.on("connection", (socket) => {
  log(`Conexión ${socket.id} · ${io.engine.clientsCount} conectados`);

  // Un error en un socket concreto no debe propagarse ni tumbar el proceso.
  socket.on("error", (error) => {
    log(`Error en el socket ${socket.id}: ${error?.message ?? error}`);
  });

  socket.on("room:create", (payload, callback = () => {}) => {
    try {
      removeSocketFromPreviousRoom(socket);

      const name = normalizeName(payload?.name);
      if (name.length < 2) {
        throw new Error("El nombre debe tener al menos 2 caracteres.");
      }

      const code = createRoomCode();
      const room = {
        code,
        hostId: socket.id,
        players: new Map(),
        phase: "LOBBY",
        hunterId: null,
        lastHunterId: null,
        hunterHistory: [],
        hunterShotsRemaining: 0,
        lastShotAt: 0,
        round: 0,
        mapId: resolveMapId(payload?.mapId),
        phaseEndsAt: null,
        phaseTimer: null
      };

      rooms.set(code, room);
      addPlayerToRoom(socket, room, name);
      log(`Sala ${code} creada por "${name}" · ${rooms.size} salas activas`);
      callback({ ok: true, roomCode: code });
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on("room:join", (payload, callback = () => {}) => {
    try {
      removeSocketFromPreviousRoom(socket);

      const name = normalizeName(payload?.name);
      const roomCode = normalizeRoomCode(payload?.roomCode);

      if (name.length < 2) {
        throw new Error("El nombre debe tener al menos 2 caracteres.");
      }

      const room = rooms.get(roomCode);
      if (!room) {
        throw new Error("La sala no existe.");
      }

      if (room.phase !== "LOBBY") {
        throw new Error("La partida ya ha comenzado.");
      }

      addPlayerToRoom(socket, room, name);
      callback({ ok: true, roomCode });
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on("player:setReady", (payload, callback = () => {}) => {
    try {
      const room = getPlayerRoom(socket);
      const player = room?.players.get(socket.id);

      if (!room || !player) {
        throw new Error("No perteneces a ninguna sala.");
      }

      if (room.phase !== "LOBBY") {
        throw new Error("Solo se puede cambiar el estado en el lobby.");
      }

      player.ready = Boolean(payload?.ready);
      emitRoomState(room);
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on("room:setMap", (payload, callback = () => {}) => {
    try {
      const room = getPlayerRoom(socket);
      if (!room) {
        throw new Error("No perteneces a ninguna sala.");
      }
      if (room.hostId !== socket.id) {
        throw new Error("Solo el anfitrión puede elegir el mapa.");
      }
      if (room.phase !== "LOBBY") {
        throw new Error("El mapa solo se puede cambiar en el lobby.");
      }

      room.mapId = resolveMapId(payload?.mapId);
      emitRoomState(room);
      callback({ ok: true, mapId: room.mapId });
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on("game:start", (_payload, callback = () => {}) => {
    try {
      const room = getPlayerRoom(socket);
      if (!room) {
        throw new Error("No perteneces a ninguna sala.");
      }

      if (room.hostId !== socket.id) {
        throw new Error("Solo el anfitrión puede iniciar.");
      }

      if (room.phase !== "LOBBY") {
        throw new Error("La partida ya está iniciada.");
      }

      const players = [...room.players.values()];
      if (players.length < MIN_PLAYERS) {
        throw new Error(`Se necesitan al menos ${MIN_PLAYERS} jugadores.`);
      }

      const playersNotReady = players.filter(
        (player) => player.id !== room.hostId && !player.ready
      );
      if (playersNotReady.length > 0) {
        throw new Error("Todavía hay jugadores sin preparar.");
      }

      beginPreparation(room);
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on("game:finishRound", (_payload, callback = () => {}) => {
    try {
      const room = getPlayerRoom(socket);
      if (!room) {
        throw new Error("No perteneces a ninguna sala.");
      }

      if (room.hostId !== socket.id) {
        throw new Error("Solo el anfitrión puede finalizar la ronda.");
      }
      if (room.phase !== "SEARCH" && room.phase !== "PREPARATION") {
        throw new Error("No hay ninguna ronda en curso.");
      }

      finishRound(room);
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on("game:returnToLobby", (_payload, callback = () => {}) => {
    try {
      const room = getPlayerRoom(socket);
      if (!room) {
        throw new Error("No perteneces a ninguna sala.");
      }

      if (room.hostId !== socket.id) {
        throw new Error("Solo el anfitrión puede volver al lobby.");
      }
      if (room.phase !== "RESULTS") {
        throw new Error("Solo se puede volver al lobby desde los resultados.");
      }

      resetToLobby(room);
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on("player:move", (payload, callback = () => {}) => {
    try {
      const room = getPlayerRoom(socket);
      const player = room?.players.get(socket.id);

      if (!room || !player) {
        throw new Error("No perteneces a ninguna sala.");
      }
      if (room.phase !== "PREPARATION") {
        throw new Error("Solo puedes moverte durante la preparación.");
      }
      if (room.hunterId === socket.id) {
        throw new Error("El cazador no controla ningún personaje.");
      }
      if (player.locked) {
        throw new Error("Has fijado tu posición; pulsa Enter para soltarla.");
      }

      const x = Number(payload?.x);
      const y = Number(payload?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error("Posición inválida.");
      }

      // El servidor valida: el ángulo se ajusta al paso permitido y la posición
      // se recorta a los límites del mapa, que dependen de ese ángulo.
      player.rotation = normalizeRotation(payload?.rotation ?? player.rotation);
      player.position = clampPosition({ x, y }, player.rotation);

      // Los demás escondidos le ven colocarse. Se manda la posición suelta y no
      // la lista entera porque esto llega muchas veces por segundo y por
      // jugador, y la lista lleva además la pintura, que pesa. El cazador
      // queda fuera.
      socket
        .to(room.code)
        .except(room.hunterId)
        .emit("player:position", {
          id: player.id,
          x: player.position.x,
          y: player.position.y,
          rotation: player.rotation
        });

      callback({ ok: true, position: player.position, rotation: player.rotation });
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on("player:lock", (payload, callback = () => {}) => {
    try {
      const room = getPlayerRoom(socket);
      const player = room?.players.get(socket.id);

      if (!room || !player) {
        throw new Error("No perteneces a ninguna sala.");
      }
      if (room.phase !== "PREPARATION") {
        throw new Error("Solo puedes fijar tu posición durante la preparación.");
      }
      if (room.hunterId === socket.id) {
        throw new Error("El cazador no controla ningún personaje.");
      }

      const locked = Boolean(payload?.locked);
      if (locked) {
        const x = Number(payload?.x);
        const y = Number(payload?.y);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          player.rotation = normalizeRotation(payload?.rotation ?? player.rotation);
          player.position = clampPosition({ x, y }, player.rotation);
        }
      }
      player.locked = locked;

      // Al fijar se manda la posición exacta, así los compañeros ven dónde se
      // ha quedado de verdad y no en el último envío periódico.
      if (player.position) {
        socket
          .to(room.code)
          .except(room.hunterId)
          .emit("player:position", {
            id: player.id,
            x: player.position.x,
            y: player.position.y,
            rotation: player.rotation ?? 0
          });
      }

      callback({
        ok: true,
        locked,
        position: player.position,
        rotation: player.rotation ?? 0
      });
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on("paint:snapshot", (payload, callback = () => {}) => {
    try {
      const room = getPlayerRoom(socket);
      const player = room?.players.get(socket.id);

      if (!room || !player) {
        throw new Error("No perteneces a ninguna sala.");
      }
      // Se puede pintar durante la preparación y también durante la búsqueda
      // (por si no dio tiempo a terminar), pero no una vez encontrado.
      if (room.phase !== "PREPARATION" && room.phase !== "SEARCH") {
        throw new Error("Solo puedes pintar durante la partida.");
      }
      if (room.hunterId === socket.id) {
        throw new Error("El cazador no controla ningún personaje.");
      }
      if (player.found) {
        throw new Error("Ya te han encontrado; no puedes seguir pintando.");
      }

      const image = payload?.image;
      // Lienzo vacío (o borrado): se quita la pintura.
      if (image == null || image === "") {
        player.paint = null;
        if (room.phase === "SEARCH") {
          io.to(room.code).emit("game:paint", { id: player.id, paint: null });
        } else {
          io.to(room.code)
            .except(room.hunterId)
            .emit("game:paint", { id: player.id, paint: null });
        }
        callback({ ok: true });
        return;
      }
      if (
        typeof image !== "string" ||
        !image.startsWith("data:image/png;base64,")
      ) {
        throw new Error("Formato de imagen no válido.");
      }
      if (image.length > PAINT.snapshotMaxBytes) {
        throw new Error("La pintura ocupa demasiado.");
      }

      player.paint = image;
      // En la búsqueda la pintura ya es visible para todos. En la preparación
      // se difunde solo entre escondidos, para que se vean camuflarse unos a
      // otros sin que el cazador reciba nada.
      if (room.phase === "SEARCH") {
        io.to(room.code).emit("game:paint", { id: player.id, paint: player.paint });
      } else {
        io.to(room.code)
          .except(room.hunterId)
          .emit("game:paint", { id: player.id, paint: player.paint });
      }
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on("hunter:shoot", (payload, callback = () => {}) => {
    try {
      const room = getPlayerRoom(socket);
      if (!room) {
        throw new Error("No perteneces a ninguna sala.");
      }
      if (room.phase !== "SEARCH") {
        throw new Error("Solo puedes disparar durante la búsqueda.");
      }
      if (room.hunterId !== socket.id) {
        throw new Error("Solo el cazador puede disparar.");
      }
      if (room.hunterShotsRemaining <= 0) {
        throw new Error("Te has quedado sin disparos.");
      }

      const now = Date.now();
      const sinceLast = now - room.lastShotAt;
      if (sinceLast < HUNTER.shotCooldownMs) {
        throw new Error("Estás recargando.");
      }

      const x = Number(payload?.x);
      const y = Number(payload?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error("Coordenadas inválidas.");
      }
      if (x < 0 || y < 0 || x > WORLD.width || y > WORLD.height) {
        throw new Error("Has disparado fuera del mapa.");
      }

      room.lastShotAt = now;
      room.hunterShotsRemaining -= 1;
      // Disparar cancela el episodio de apuntado en curso (no fue "apuntar sin disparar").
      room.aim = null;

      let hitPlayer = null;
      for (const player of room.players.values()) {
        if (player.id === room.hunterId || player.found || !player.position) {
          continue;
        }
        if (isInsideCharacter(x, y, player.position, player.rotation ?? 0)) {
          hitPlayer = player;
          break;
        }
      }

      if (hitPlayer) {
        hitPlayer.found = true;
        hitPlayer.foundAt = now;
      }

      // Efecto visual para todos (escondidos, cazador y encontrados).
      io.to(room.code).emit("game:shot", {
        x,
        y,
        hit: Boolean(hitPlayer)
      });
      emitCharacters(room);

      const remainingHiders = [...room.players.values()].filter(
        (player) =>
          player.id !== room.hunterId && player.connected && !player.found
      );

      callback({
        ok: true,
        hit: Boolean(hitPlayer),
        remaining: room.hunterShotsRemaining
      });

      // La ronda acaba cuando no queda a quién buscar o cuando el cazador se
      // queda sin munición. Sin esto, gastada la última bala la partida seguía
      // corriendo hasta agotar el reloj sin que nadie pudiera hacer nada.
      if (remainingHiders.length === 0 || room.hunterShotsRemaining <= 0) {
        finishRound(room);
      } else {
        emitRoomState(room);
      }
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on("hunter:aim", (payload) => {
    // Posición del cursor del cazador durante la búsqueda, para el bonus de
    // camuflaje. Llega limitada en frecuencia y no necesita acuse.
    const room = getPlayerRoom(socket);
    if (!room || room.phase !== "SEARCH" || room.hunterId !== socket.id) {
      return;
    }
    const x = Number(payload?.x);
    const y = Number(payload?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return;
    }
    processAim(room, x, y);
  });

  socket.on("disconnect", () => {
    log(`Desconexión ${socket.id} · ${io.engine.clientsCount} conectados`);
    const room = getPlayerRoom(socket);
    if (!room) {
      return;
    }

    room.players.delete(socket.id);

    if (room.players.size === 0) {
      clearPhaseTimer(room);
      rooms.delete(room.code);
      log(`Sala ${room.code} vacía y eliminada · ${rooms.size} salas activas`);
      return;
    }

    if (room.hostId === socket.id) {
      room.hostId = room.players.keys().next().value;
    }

    if (room.hunterId === socket.id && room.phase !== "LOBBY") {
      resetToLobby(room);
      return;
    }

    // F-04: si en plena partida ya no hay jugadores suficientes, volver al lobby.
    const connectedCount = [...room.players.values()].filter(
      (player) => player.connected
    ).length;
    if (room.phase !== "LOBBY" && connectedCount < MIN_PLAYERS) {
      resetToLobby(room);
      return;
    }

    // En preparación los escondidos se ven entre ellos, así que hay que
    // refrescar la lista para que el que se ha ido desaparezca del mapa.
    if (room.phase === "PREPARATION") {
      emitCharacters(room);
    }

    // F-02: en búsqueda hay que refrescar los personajes (el que se fue ya no está)
    // y terminar la ronda si no queda ningún escondido sin encontrar.
    if (room.phase === "SEARCH" || room.phase === "RESULTS") {
      emitCharacters(room);
      const remainingHiders = [...room.players.values()].filter(
        (player) =>
          player.id !== room.hunterId && player.connected && !player.found
      );
      if (room.phase === "SEARCH" && remainingHiders.length === 0) {
        finishRound(room);
        return;
      }
    }

    emitRoomState(room);
  });
});

// Red de seguridad: un fallo inesperado se registra pero no tumba el servidor,
// para no dejar la partida colgada por el error de un cliente.
process.on("uncaughtException", (error) => {
  log(`Excepción no capturada: ${error?.stack ?? error}`);
});
process.on("unhandledRejection", (reason) => {
  log(`Promesa rechazada sin manejar: ${reason}`);
});

httpServer.listen(PORT, "0.0.0.0", () => {
  log(`Camouflage Hunt escuchando en http://0.0.0.0:${PORT}`);
});
