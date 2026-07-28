# Camouflage Hunt — Módulo 1

Prototipo multijugador para un juego de camuflaje de team building.

## Qué funciona ya

- Crear una sala con código de cinco caracteres.
- Entrar desde varios navegadores u ordenadores.
- Elegir un nombre único.
- Ver la lista de jugadores conectados.
- Marcarse como preparado.
- Iniciar la partida desde el usuario anfitrión.
- Elegir un cazador aleatorio.
- Mostrar un telón al cazador durante 120 segundos.
- Pasar automáticamente a una fase de búsqueda de 180 segundos.
- Finalizar una ronda y regresar al lobby.
- Continuar con cualquier número de jugadores a partir de dos.

## Requisitos

- Node.js 24 LTS o posterior.
- npm, incluido con Node.js.
- Eclipse IDE con soporte para JavaScript/Node, o cualquier editor de texto.

## Ejecutarlo desde Eclipse

1. Descomprime o importa la carpeta `camouflage-hunt`.
2. En Eclipse, abre **File > Open Projects from File System**.
3. Selecciona esta carpeta.
4. Abre una terminal situada en la raíz del proyecto.
5. Ejecuta:

```bash
npm install
npm start
```

6. Abre en el navegador:

```text
http://localhost:3000
```

7. Para una prueba local multijugador, abre varias pestañas o ventanas privadas.

## Ejecutarlo durante el desarrollo

```bash
npm run dev
```

Node reiniciará el servidor cuando guardes cambios en `server.js`.

## Comprobar el servidor

Abre:

```text
http://localhost:3000/health
```

Debe responder con un JSON cuyo estado sea `ok`.

## Estructura

```text
camouflage-hunt/
├── package.json
├── server.js
├── Dockerfile
├── .dockerignore
├── .gitignore
├── README.md
└── public/
    ├── index.html
    ├── css/
    │   └── styles.css
    ├── js/
    │   └── app.js
    └── assets/
        ├── maps/
        └── players/
```

## Siguiente módulo

1. Añadir una imagen estandarizada como mapa.
2. Crear una cámara con desplazamiento y zoom.
3. Dibujar un personaje independiente para cada jugador.
4. Sincronizar la posición con Socket.IO.
5. Bloquear al cazador y congelar a los jugadores al acabar la preparación.

## Limitaciones deliberadas del prototipo

- Las salas se almacenan en memoria.
- Si se reinicia el servidor, se borran las partidas.
- No hay cuentas ni contraseñas.
- No hay movimiento, pintura ni puntuación todavía.
- No se permite entrar en una ronda ya iniciada.

Estas decisiones reducen riesgo y permiten terminar una versión demostrable antes del jueves.
