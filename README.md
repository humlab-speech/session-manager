# session-manager

The session-manager is the central backend service of the VISP (Visible Speech) platform. It
runs as a standalone Node.js container and acts as the hub between the Angular webclient, the
Apache/PHP webapi, MongoDB, and the dynamically spawned per-user session containers (Jupyter,
operations).

## Role in the VISP architecture

```
┌─────────────┐  WebSocket (wss://)   ┌──────────────────┐  HTTP (auth check)  ┌───────────┐
│  Webclient   │◄─────────────────────►│  session-manager  │◄───────────────────│  MongoDB   │
│  (Angular)   │                       │  :8020 ws / :8080 │                    │  (visp db) │
└──────┬───────┘                       └────────┬─────────┘                    └───────────┘
        │ HTTP                                  │ Podman API
        ▼                                       ▼
┌─────────────┐                    ┌──────────────────┐
│   Apache     │                    │ podman-socket-   │
│  + webapi    │                    │ proxy            │
└─────────────┘                    └────────┬─────────┘
                                            │
                                   ┌────────▼──────────┐   ┌─────────────────────┐
                                   │ rootless Podman    │   │  Per-user containers │
                                   │ daemon (host)      │──►│  visp-jupyter-session │
                                   └───────────────────┘   └─────────────────────┘
```

- **Apache** proxies WebSocket upgrade requests on the main domain to session-manager port 8020.
- The webclient communicates with session-manager **over WebSocket** for interactive
  operations (project CRUD, session spawning, transcription, etc.); file uploads and a few
  helpers go through the Apache PHP API instead.
- A secondary **REST API on port 8080** is used for internal service-to-service calls
  (e.g. SPR recording-import hints from wsrng-server, session management from webapi).
- Session-manager talks to **Podman** through the `visp-podman-socket-proxy` (a security
  proxy that validates `containers/create` requests against a policy: image allowlist,
  no privileged mode, mount allowlist, capability allowlist, no host networking). The
  proxy binds to `/run/podman-proxy/podman.sock` and forwards to the real rootless Podman
  socket at `/run/user/1000/podman/podman.sock`.

## Core responsibilities

### 1. User authentication & authorization

Every WebSocket message triggers an authentication round-trip to the Apache/webapi PHP
session endpoint, keyed by the user's PHP session cookie (`getSession` is the exception:
it is the unauthenticated lookup that starts the flow). On success the user is identified
from MongoDB, and authorization follows the two-tier role model:

- **System roles** (`system_roles`): `sys_admin` may reach the admin panel and create
  projects; plain `user` may not. Re-seeded from `ApiServer.class.js` on every boot.
- **Project roles** (`project_roles`): `project_admin` (may issue invite codes, manage
  members, edit project files) and `researcher` (may manage members and edit files, but
  not issue invite codes). Sysadmins implicitly hold every project permission.
- Bundle deletion is not a seeded flag: it is derived server-side from `canDeleteProject`
  (ProjectAdmin or SysAdmin).
- Demoting the **last `project_admin` of a project is refused** by the project-scoped
  role-change path (`setProjectMemberRole`); the sysadmin override path
  (`adminUpdateProjectMemberRole`) deliberately permits it. The last-`sys_admin` guard
  lives in the deployment repo's vispctl, not in this service.

`loginAllowed` (with the access-list verdict folded in when `ACCESS_LIST_ENABLED` is on)
is sent to the client so it can show the right UI.

### 2. Project lifecycle

The `saveProject` WebSocket command is the main entry point for creating and updating
projects. For **new projects**, the flow is:

1. Copy the repository template to create a new project directory
2. Initialize a git repository in the project folder
3. Store the project document in MongoDB (name, sessions, annotation levels, members, etc.)
4. Convert any non-WAV audio files to 16 kHz mono WAV using ffmpeg
5. Spawn a short-lived **operations container** and run container-agent commands to:
   - Create the EMU-DB structure (`emudb-create`)
   - Import audio sessions (`emudb-create-sessions`)
   - Create bundle lists, annotation levels, links, perspectives, and track definitions
     (`emudb-create-bundlelist`, `emudb-create-annotlevels`, `emudb-track-definitions`, …)
   - Copy uploaded documents (`copy-docs`) — see container-agent's README for semantics
6. Git-commit the result — executed by session-manager itself (`simple-git`) against the
   bind-mounted repository, not inside the operations container
7. Tear down the operations container

Progress updates are streamed back to the client at each step, and **every `saveProject`
answers exactly once with a terminal `progress: "end"` frame** — `result: false` on
failure, never a "Done" for a save that failed. Terminal frames are latched per
`requestId`, so a second answer for the same request cannot be emitted.

For **existing projects**, the update flow syncs annotation levels and sessions with the
stored EMU-DB, running the same container-agent pipeline.

A session that already holds recordings cannot change its recording script
(`validateSessionScriptChanges`); the refusal names the blocked session.

### 3. Container session management

Users interact with their project data through spawned containers:

| Session type | Image | Use case |
|:---|:---|:---|
| `jupyter` | `visp-jupyter-session` | JupyterLab; reaches WhisperVault through the session's UDS `api.sock` |
| `operations` | `visp-jupyter-session` | Short-lived, runs container-agent for EMU-DB ops |

Container lifecycle:

- **Spawn** — the `launchContainerSession` command validates the user's role on the
  project, mounts the project repository volume, and creates the container via the Podman
  libpod API. Each container gets a unique access code and is assigned an internal proxy
  port (30000–35000).
- **Proxy** — An `http-proxy` instance forwards HTTP and WebSocket traffic from
  session-manager into the container, keyed by the `SessionAccessCode` cookie.
  `SessionProxyServer` (port 80) handles this routing.
- **Network isolation** — interactive Jupyter sessions run with `--network=none` and
  reach the internet only through a `visp-session-proxy` (tinyproxy) sidecar over Unix
  Domain Sockets (`ui.sock` / `api.sock` under `mounts/sessions/<name>`). Operations
  sessions also run with `NetworkMode = "none"` — they need no network, only `podman exec`.
- **Readiness** — After starting a container, session-manager polls its HTTP endpoint until
  the service inside is ready (up to 120 s by default, configurable via
  `SESSION_START_TIMEOUT_MS`).
- **Cleanup** — `refreshSessions` reconciles in-memory sessions with the actual Podman
  container list (pruning exited/missing ones); it runs on demand whenever a session list
  is requested, not on a timer.
- **Delete** — Stops the container, closes the proxy, and cleans up log streams.

Containers are named `visp-session-<projectId>-<userId>-<salt>` and labelled with
`visp.hsApp`, `visp.username`, `visp.projectId`, and `visp.accessCode` for identification.

### 4. Transcription (WhisperX integration)

The `WhisperService` class manages an async transcription queue backed by MongoDB
(`transcriptionqueueitems` collection). Users submit audio files for transcription via the
`transcribe` WebSocket command; results are retrieved via `fetchTranscription`. The service
supports 99+ languages and talks to the WhisperVault container over a Unix Domain Socket.

Key parameter split: `beam_size` (clamped 5–10), `repetition_penalty`,
`condition_on_previous_text`, `vad_method` and `vad_onset` are **reload-time** — sent with
`POST /reload` and skipped when neither the package nor the override set changed
(`currentPackage` + `currentOverridesKey`). `language` (full name → ISO 639-1 via
`languageToIso`) and `diarize` are **per-request** parameters.

### 5. SPR (Speech Recording) integration

Session-manager manages the metadata side of speech recording projects that use the
wsrng-server. SPR data lives in a separate `wsrng` MongoDB database:

- **Scripts** — Recording prompts stored in `scripts` collection, converted from a simplified
  format to the full WSR specification.
- **Sessions** — Recording sessions in `sessions` collection, linked to scripts and projects.
- **Import** — `SprImportService` scans the recording upload directory every 30 s and
  compares it against the fingerprint it last imported. A completed session is imported
  once its uploads have been unchanged for 10 s, or after 30 min of silence; failures retry
  at 1/5/30 min. `POST /api/importaudiofiles` from wsrng-server only accelerates that scan —
  the upload directory is the source of truth, so a lost hint never loses an import.
  Progress items live in `wsrngimportqueueitems`.

### 6. File management

- **Upload** — Files are uploaded through Apache's PHP API (`api.php`), not over WebSocket;
  session-manager reads them from the shared uploads directory during a project save. File
  names are sanitized by `sanitizeFileName`, which mirrors PHP `sanitize()` byte-wise
  (including whitespace trim/collapse) so the two services agree on the final name. A legacy
  base64 `uploadFile` WebSocket command still exists but the live pipeline is the PHP one.
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

Responses follow the `WebSocketMessage` format:

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

Two protocol rules clients rely on:

- **Denials** are answered with a `type: "cmd-result"` frame (plain `WebSocketMessage`-shaped
  denials are parsed and discarded by the webclient's command handlers).
- **Malformed frames** (non-JSON, truncated, wrong-typed `cmd`, binary) are logged and
  ignored — they never kill the connection or the service.

See the `handleIncomingWebSocketMessage` method in `ApiServer.class.js` for the full list of
supported commands (63 as of writing).

## REST API (port 8080)

Internal endpoints used by other VISP services. **Most session-management endpoints require
the `hs_api_access_token` header** (`HS_API_ACCESS_TOKEN`). Deliberate exception:
`/api/importaudiofiles` (wsrng-server calls it without a token). `/api/debug/sessions`
requires no token but is loopback-only. Note that `/api/importtest`, `/api/spr`,
`/api/accesslist/:user` and the `commit/user` route do **not** enforce the token today
(several are stubs) — never expose port 8080 beyond `visp-net`.

| Method | Path | Purpose |
|:---|:---|:---|
| `POST` | `/api/importaudiofiles` | Hint session-manager to scan for new SPR recordings |
| `GET` | `/api/importtest` | Import-pipeline test hook (stub) |
| `GET` | `/api/sessions/:user_id` | List running sessions for a user |
| `POST` | `/api/session/user` | Create or reuse a session for a user+project |
| `POST` | `/api/session/new/user` | Force-create a new session |
| `GET` | `/api/session/:id/commit` | Git-commit inside a session container |
| `GET` | `/api/session/:id/delete` | Stop and remove a session container |
| `POST` | `/api/session/run` | Execute a command inside a session container |
| `GET` | `/api/session/commit/user/:user_id/project/:project_id/projectpath/:project_path` | Commit by user+project (stub) |
| `GET` | `/api/debug/sessions` | Dump session registry (loopback only) |
| `GET` | `/api/accesslist/:user` | Access-list query (stub — currently never responds) |
| `POST` | `/api/spr` | SPR metadata (stub) |

## Environment variables

| Variable | Default | Description |
|:---|:---|:---|
| `ABS_ROOT_PATH` | — | Absolute path to the deployment root on the host |
| `DOCKER_SOCKET_PATH` | `/run/user/1000/podman/podman.sock` | Podman socket to use; the deployment quadlets inject the proxy path `/run/podman-proxy/podman.sock` |
| `MONGO_ROOT_PASSWORD` | — | Root password; the URI is built as `mongodb://root:<pw>@mongo:27017` |
| `HS_API_ACCESS_TOKEN` | — | Bearer token required on the internal REST API |
| `LOG_LEVEL` | — | `info` or `debug` |
| `DEVELOPMENT_MODE` | `false` | Mounts container-agent from local filesystem when `true` |
| `ACCESS_LIST_ENABLED` | — | Fold the access-list check into `loginAllowed` |
| `GITLAB_ADDRESS` | — | Git remote host used for project repositories |
| `GITLAB_ACTIVATED` | `false` | Enable GitLab integration (legacy) |
| `EMUDB_INTEGRATION_ENABLED` | — | Enable EMU-DB pipeline |
| `SESSION_START_TIMEOUT_MS` | `120000` | Max wait for container readiness (ms) |
| `SESSION_MANAGER_KEEP_CONTAINERS` | `false` | Disable AutoRemove for debugging |
| `SESSION_PROXY_IMAGE` | — | Tinyproxy sidecar image for UDS-isolated Jupyter sessions |
| `PROXY_BLOCKED_NETWORKS` / `PROXY_BLOCKED_CIDRS` | — | Networks/CIDRs the session proxy must refuse |
| `VISP_NETWORK_NAME` | — | Podman network name for spawned containers |
| `WHISPERX_SOCKET_PATH` / `WHISPERX_PACKAGES_PATH` | — | WhisperVault UDS socket / packages.json |
| `TRANSCRIPTION_DEBUG` | — | Verbose transcription logging |

## Source layout

```
src/
├── index.js                     # Entry point — creates Application, wires components
├── ApiServer.class.js           # WebSocket server, REST API, all business logic (~10k lines)
├── Session.class.js             # Base session — container create/start/stop/exec/proxy
├── SessionManager.class.js      # Session registry, routing, container reconciliation
├── SessionApiServer.class.js    # Per-session UDS API (file resolution inside sessions)
├── SessionProxyServer.class.js  # HTTP proxy server (port 80) routing into session containers
├── SprImportService.class.js    # SPR recording → EMU-DB import scanner
├── WebSocketMessage.class.js    # WebSocket response message format
├── WhisperService.class.js      # Transcription queue & WhisperX integration
├── ApiResponse.class.js         # HTTP response helper
├── pathSecurity.js              # Shared path-traversal guard
├── sessionFiles.js              # Session file-origin rules (upload vs recording)
├── vispMetadata.js              # EMU metadata helpers
├── Sessions/
│   ├── JupyterSession.class.js  # Jupyter session config (port 8888, UDS-isolated)
│   └── OperationsSession.class.js # Operations session config (short-lived, no server)
└── models/
    └── UserSession.class.js     # User session data model
```

## Development & tests

Unit tests use the built-in Node test runner. **Run them inside the runtime container:**

```bash
podman exec session-manager node --test test/
```

(Use the directory form, not the quoted glob in `npm test`: Node < 22 does not expand
globs for `--test`, and older deployed images run Node 20 where the glob form silently
matches nothing. The directory form skips `src/pathSecurity.test.js`. nodemon hot-reloads
`src/` in dev mode — a test run needs no rebuild.)
