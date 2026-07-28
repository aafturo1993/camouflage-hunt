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

function clampNumber(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Mantiene el CENTRO del personaje dentro del mapa. */
function clampPosition(position) {
  const halfWidth = CHARACTER.width / 2;
  const halfHeight = CHARACTER.height / 2;
  return {
    x: Math.round(clampNumber(position.x, halfWidth, WORLD.width - halfWidth)),
    y: Math.round(clampNumber(position.y, halfHeight, WORLD.height - halfHeight))
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

/** ¿El punto (x, y) de mundo cae dentro de la caja del personaje? */
function isInsideCharacter(x, y, position) {
  const halfWidth = CHARACTER.width / 2 + HUNTER.hitPaddingX;
  const halfHeight = CHARACTER.height / 2 + HUNTER.hitPaddingY;
  return (
    Math.abs(x - position.x) <= halfWidth &&
    Math.abs(y - position.y) <= halfHeight
  );
}

/** Lista de personajes visible en búsqueda (sin nombres: el cazador no debe verlos). */
function characterList(room) {
  return [...room.players.values()]
    .filter((player) => player.id !== room.hunterId && player.position)
    .map((player) => ({
      id: player.id,
      x: player.position.x,
      y: player.position.y,
      found: player.found
    }));
}

function emitCharacters(room) {
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
    // El cazador no tiene personaje; cada escondido nace en un punto aleatorio
    // separado del resto para que no aparezcan superpuestos.
    if (player.id === room.hunterId) {
      player.position = null;
      continue;
    }
    player.position = spawnAwayFrom(placed, CHARACTER.width);
    placed.push(player.position);
  }

  schedulePhase(room, PREPARATION_SECONDS, beginSearch);
  emitRoomState(room);
}

function beginSearch(room) {
  room.phase = "SEARCH";

  const hiders = [...room.players.values()].filter(
    (player) => player.id !== room.hunterId && player.connected
  );
  // Munición = escondidos + extra. Las posiciones quedan congeladas en este punto.
  room.hunterShotsRemaining = hiders.length + HUNTER.extraShots;
  room.lastShotAt = 0;

  schedulePhase(room, SEARCH_SECONDS, finishRound);
  emitRoomState(room);
  emitCharacters(room);
}

function finishRound(room) {
  clearPhaseTimer(room);
  room.phase = "RESULTS";
  room.phaseEndsAt = null;
  emitRoomState(room);
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
    locked: false
  };

  room.players.set(socket.id, player);
  socket.data.roomCode = room.code;
  socket.join(room.code);
  emitRoomState(room);
}

io.on("connection", (socket) => {
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
        mapId: DEFAULT_MAP_ID,
        phaseEndsAt: null,
        phaseTimer: null
      };

      rooms.set(code, room);
      addPlayerToRoom(socket, room, name);
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

      // El servidor valida: la posición se recorta a los límites del mapa.
      player.position = clampPosition({ x, y });
      callback({ ok: true, position: player.position });
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
          player.position = clampPosition({ x, y });
        }
      }
      player.locked = locked;
      callback({ ok: true, locked, position: player.position });
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

      let hitPlayer = null;
      for (const player of room.players.values()) {
        if (player.id === room.hunterId || player.found || !player.position) {
          continue;
        }
        if (isInsideCharacter(x, y, player.position)) {
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

      if (remainingHiders.length === 0) {
        finishRound(room);
      } else {
        emitRoomState(room);
      }
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on("disconnect", () => {
    const room = getPlayerRoom(socket);
    if (!room) {
      return;
    }

    room.players.delete(socket.id);

    if (room.players.size === 0) {
      clearPhaseTimer(room);
      rooms.delete(room.code);
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

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Camouflage Hunt disponible en http://localhost:${PORT}`);
});
