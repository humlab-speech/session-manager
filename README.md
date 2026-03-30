# session-manager

The session-manager is the central backend service of the VISP (Visible Speech) platform. It
runs as a standalone Node.js container and acts as the hub between the Angular webclient, the
Apache/PHP webapi, MongoDB, and the dynamically spawned per-user session containers (RStudio,
Jupyter, operations).

## Role in the VISP architecture

```
┌─────────────┐  WebSocket (wss://)   ┌──────────────────┐  Podman API   ┌─────────────────────┐
│  Webclient   │◄─────────────────────►│  session-manager  │◄────────────►│  Per-user containers │
│  (Angular)   │                       │  :8020 ws / :8080 │              │  visp-rstudio-session │
└──────┬───────┘                       └──────┬───────────┘              │  visp-jupyter-session │
       │ HTTP                                 │                          │  visp-operations-sess │
       ▼                                      ▼                          └─────────────────────┘
┌─────────────┐  HTTP (auth check)    ┌───────────┐
│   Apache     │◄─────────────────────│  MongoDB   │
│  + webapi    │                      │  (visp db) │
└─────────────┘                       └───────────┘
```

- **Apache** proxies WebSocket upgrade requests on the main domain to session-manager port 8020.
- The webclient communicates with session-manager **exclusively over WebSocket** for all
  interactive operations (project CRUD, session spawning, file upload, transcription, etc.).
- A secondary **REST API on port 8080** is used for internal service-to-service calls
  (e.g. SPR recording imports from wsrng-server, session management from webapi).
- Session-manager talks directly to **Podman** (via the socket at
  `/run/user/1000/podman/podman.sock`) to create, start, stop, and exec into containers
  using the libpod native API.

## Core responsibilities

### 1. User authentication & authorization

Every WebSocket message (except the initial `getUser` lookup) triggers an authentication
round-trip to the Apache/webapi PHP session endpoint. The user's PHP session cookie is
forwarded, and if valid, the user object is fetched from MongoDB and cached for the
connection. Authorization checks verify that `loginAllowed` is set and the user has the
required privileges (e.g. `createProjects`).

### 2. Project lifecycle

The `saveProject` WebSocket command is the main entry point for creating and updating
projects. For **new projects**, the flow is:

1. Copy the repository template to create a new project directory
2. Initialize a git repository in the project folder
3. Store the project document in MongoDB (name, sessions, annotation levels, members, etc.)
4. Convert any non-WAV audio files to 16 kHz mono WAV using ffmpeg
5. Spawn a short-lived **operations container** and run container-agent commands to:
   - Create the EMU-DB structure (`emudb-create`)
   - Add audio sessions (`emudb-add-sessions`)
   - Create bundle lists, annotation levels, links, perspectives, and track definitions
6. Git-commit all changes inside the operations container
7. Tear down the operations container

Progress updates are streamed back to the client via WebSocket at each step.

For **existing projects**, the update flow syncs annotation levels and sessions with the
stored EMU-DB, running the same container-agent pipeline.

### 3. Container session management

Users interact with their project data through spawned containers:

| Session type | Image | Use case |
|:---|:---|:---|
| `rstudio` | `visp-rstudio-session` | RStudio IDE for statistical analysis |
| `jupyter` | `visp-jupyter-session` | JupyterLab with Whisper models mounted |
| `operations` | `visp-operations-session` | Short-lived, runs container-agent for EMU-DB ops |
| `vscode` | `visp-vscode-session` | VS Code Server (experimental) |

Container lifecycle:

- **Spawn** — `spawnSession` validates the user's role on the project, mounts the project
  repository volume, and creates the container via the Podman libpod API. Each container gets
  a unique access code and is assigned an internal proxy port (30000–35000).
- **Proxy** — An `http-proxy` instance forwards HTTP and WebSocket traffic from
  session-manager into the container, keyed by the `SessionAccessCode` cookie.
  `SessionProxyServer` (port 80) handles this routing.
- **Readiness** — After starting a container, session-manager polls its HTTP endpoint until
  the service inside is ready (up to 120 s by default, configurable via
  `SESSION_START_TIMEOUT_MS`).
- **Cleanup** — `refreshSessions` periodically reconciles in-memory sessions with the actual
  Podman container list, removing sessions whose containers have exited or disappeared.
- **Delete** — Stops the container, closes the proxy, and cleans up log streams.

Containers are named `visp-session-<projectId>-<userId>-<salt>` and labelled with
`visp.hsApp`, `visp.username`, `visp.projectId`, and `visp.accessCode` for identification.

### 4. Transcription (WhisperX integration)

The `WhisperService` class manages an async transcription queue backed by MongoDB
(`transcriptionqueueitems` collection). Users submit audio files for transcription via the
`transcribe` WebSocket command. The service supports 99+ languages via WhisperX and
communicates with the WhisperVault/WhisperX container. Transcription results are stored in
MongoDB and retrieved via `getTranscription`.

### 5. SPR (Speech Recording) integration

Session-manager manages the metadata side of speech recording projects that use the
wsrng-server. SPR data lives in a separate `wsrng` MongoDB database:

- **Scripts** — Recording prompts stored in `scripts` collection, converted from a simplified
  format to the full WSR specification.
- **Sessions** — Recording sessions in `sessions` collection, linked to scripts and projects.
- **Import queue** — Completed recordings are imported back into EMU-DB via an async queue
  (`wsrngimportqueueitems`), processed every 15 seconds by `importQueueProcessor`.

### 6. File management

- **Upload** — Files are uploaded as base64-encoded WebSocket messages and written to the
  project's upload directory.
- **Download** — Bundles can be zipped and sent back to the client as base64.
- **Audio conversion** — Non-WAV files are automatically converted to 16 kHz mono PCM WAV
  using ffmpeg during project save.

### 7. Octra annotation tasks

Session-manager can create and save Octra virtual annotation tasks, stored in MongoDB
(`octravirtualtasks` collection) and linked to specific project sessions and bundles.

## WebSocket protocol

Messages are JSON objects with the following structure:

```json
{
  "type": "cmd",
  "cmd": "<command-name>",
  "requestId": "<unique-id>",
  "data": { ... }
}
```

Responses use the `WebSocketMessage` format:

```json
{
  "requestId": "<echoed-request-id>",
  "cmd": "<command-name>",
  "data": { ... },
  "message": "Human-readable status",
  "progress": "step description",
  "result": true
}
```

See the `handleIncomingWebSocketMessage` method in `ApiServer.class.js` for the full list
of ~45 supported commands.

## REST API (port 8080)

Internal endpoints used by other VISP services:

| Method | Path | Purpose |
|:---|:---|:---|
| `POST` | `/api/importaudiofiles` | Queue SPR recordings for EMU-DB import |
| `GET` | `/api/sessions/:user_id` | List running sessions for a user |
| `POST` | `/api/session/user` | Create or reuse a session for a user+project |
| `POST` | `/api/session/new/user` | Force-create a new session |
| `GET` | `/api/session/:id/commit` | Git-commit inside a session container |
| `GET` | `/api/session/:id/delete` | Stop and remove a session container |
| `POST` | `/api/session/run` | Execute a command inside a session container |

## Environment variables

| Variable | Default | Description |
|:---|:---|:---|
| `ABS_ROOT_PATH` | — | Absolute path to the deployment root on the host |
| `DOCKER_SOCKET_PATH` | `/run/user/1000/podman/podman.sock` | Path to the Podman socket |
| `LOG_LEVEL` | — | `info` or `debug` |
| `DEVELOPMENT_MODE` | `false` | Mounts container-agent from local filesystem when `true` |
| `MONGO_CONNECTION_STRING` | — | MongoDB connection URI |
| `GITLAB_ACTIVATED` | `false` | Enable GitLab integration (legacy) |
| `EMUDB_INTEGRATION_ENABLED` | — | Enable EMU-DB pipeline |
| `RSTUDIO_PASSWORD` | — | Password injected into RStudio containers |
| `SESSION_START_TIMEOUT_MS` | `120000` | Max wait for container readiness (ms) |
| `SESSION_MANAGER_KEEP_CONTAINERS` | `false` | Disable AutoRemove for debugging |
| `VISP_NETWORK_NAME` | — | Podman network name for spawned containers |

## Source layout

```
src/
├── index.js                     # Entry point — creates Application, wires components
├── ApiServer.class.js           # WebSocket server, REST API, all business logic (~5900 lines)
├── Session.class.js             # Base session — container create/start/stop/exec/proxy
├── SessionManager.class.js      # Session registry, routing, container reconciliation
├── SessionProxyServer.class.js  # HTTP proxy server (port 80) routing into session containers
├── WebSocketMessage.class.js    # WebSocket response message format
├── WhisperService.class.js      # Transcription queue & WhisperX integration
├── ApiResponse.class.js         # HTTP response helper
├── Sessions/
│   ├── RstudioSession.class.js  # RStudio session config (port 8787)
│   ├── JupyterSession.class.js  # Jupyter session config (port 8888)
│   ├── OperationsSession.class.js # Operations session config (port 8787)
│   └── VscodeSession.class.js   # VS Code session config (port 8443, experimental)
└── models/
    └── UserSession.class.js     # User session data model
```
