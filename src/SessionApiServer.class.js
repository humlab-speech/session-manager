/**
 * SessionApiServer — lightweight HTTP server listening on a Unix Domain Socket
 * inside each Jupyter session's shared socket directory (api.sock).
 *
 * Gives notebook code a way to transcribe arbitrary audio files via WhisperVault
 * without any TCP networking or direct WhisperVault access. Model switching and
 * queueing are handled by the existing WhisperService — notebooks go through the
 * same serialized pipeline as UI-triggered transcriptions.
 *
 * Endpoints:
 *   GET  /models              – list available WhisperVault model packages
 *   POST /transcribe          – transcribe a file (path inside the container)
 *   GET  /health              – liveness check
 *
 * File path mapping:
 *   Container path  /home/jovyan/project/...
 *   →  Host path    <absRootPath>/mounts/repositories/<projectId>/...
 *
 * Only paths under /home/jovyan/project/ are accepted to prevent directory
 * traversal into unrelated parts of the container or host filesystem.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const CONTAINER_PROJECT_ROOT = "/home/jovyan/project";

class SessionApiServer {
    /**
     * @param {object} app        - Global app object (logging, whisperService, absRootPath)
     * @param {object} session    - The owning Session instance
     * @param {string} socketPath - Absolute path where api.sock will be created
     */
    constructor(app, session, socketPath) {
        this.app = app;
        this.session = session;
        this.socketPath = socketPath;
        this.server = null;
    }

    start() {
        if (fs.existsSync(this.socketPath)) {
            fs.unlinkSync(this.socketPath);
        }

        this.server = http.createServer((req, res) => {
            this._handleRequest(req, res).catch((err) => {
                this.app.addLog(`SessionApiServer error: ${err.message}`, "error");
                this._sendJson(res, 500, { error: "Internal server error" });
            });
        });

        this.server.listen(this.socketPath, () => {
            fs.chmodSync(this.socketPath, 0o777);
            this.app.addLog(`SessionApiServer listening on ${this.socketPath}`);
        });

        this.server.on("error", (err) => {
            this.app.addLog(`SessionApiServer socket error: ${err.message}`, "error");
        });
    }

    stop() {
        if (this.server) {
            this.server.close();
            this.server = null;
        }
        if (fs.existsSync(this.socketPath)) {
            try { fs.unlinkSync(this.socketPath); } catch (_) {}
        }
    }

    // -------------------------------------------------------------------------

    async _handleRequest(req, res) {
        const url = new URL(req.url, "http://localhost");
        const pathname = url.pathname.replace(/\/$/, "") || "/";

        if (pathname === "/health" && req.method === "GET") {
            return this._sendJson(res, 200, { ok: true });
        }
        if (pathname === "/models" && req.method === "GET") {
            return this._handleModels(res);
        }
        if (pathname === "/transcribe" && req.method === "POST") {
            return this._handleTranscribe(req, res);
        }

        this._sendJson(res, 404, { error: "Not found" });
    }

    async _handleModels(res) {
        const whisperService = this.app.apiServer?.whisperService;
        if (!whisperService) {
            return this._sendJson(res, 503, { error: "Transcription service unavailable" });
        }
        const models = await whisperService.getAvailableModels();
        return this._sendJson(res, 200, models);
    }

    async _handleTranscribe(req, res) {
        let body;
        try {
            body = await this._readJson(req);
        } catch (_) {
            return this._sendJson(res, 400, { error: "Invalid JSON body" });
        }

        const { file, model, language, diarize, formats, advancedOptions } = body;

        if (!file) {
            return this._sendJson(res, 400, {
                error: "'file' is required — provide a path under /home/jovyan/project/ or a relative path",
            });
        }

        // Resolve and validate the file path
        const hostPath = this._containerPathToHost(file);
        this.app.addLog(
            `SessionApiServer: resolved "${file}" → "${hostPath}" (projectId=${this.session.project?.id})`,
            "debug",
        );
        if (!hostPath) {
            return this._sendJson(res, 400, {
                error: `File must be under ${CONTAINER_PROJECT_ROOT}/`,
            });
        }

        if (!fs.existsSync(hostPath)) {
            return this._sendJson(res, 404, { error: `File not found: ${file}` });
        }

        const whisperService = this.app.apiServer?.whisperService;
        if (!whisperService) {
            return this._sendJson(res, 503, { error: "Transcription service unavailable" });
        }
        if (!whisperService.whisperReady) {
            return this._sendJson(res, 503, { error: "WhisperVault is not ready yet" });
        }

        this.app.addLog(
            `SessionApiServer: transcribe ${file} ` +
            `(model=${model || "whisper"}, lang=${language || "auto"}, diarize=${!!diarize})`,
        );

        try {
            const result = await whisperService.transcribeFile(hostPath, {
                model: model || "whisper",
                language: language || "Automatic Detection",
                diarize: !!diarize,
                formats: formats || ["txt"],
                advancedOptions: advancedOptions || {},
            });
            return this._sendJson(res, 200, result);
        } catch (err) {
            this.app.addLog(`SessionApiServer transcribe error: ${err.message}`, "error");
            return this._sendJson(res, 500, { error: err.message });
        }
    }

    /**
     * Map a container-side path under /home/jovyan/project/ to the host
     * filesystem path session-manager can access.
     * Returns null if the path is outside the allowed prefix.
     */
    _containerPathToHost(containerPath) {
        // Accept both absolute (/home/jovyan/project/foo) and relative (foo)
        const absContainer = containerPath.startsWith("/")
            ? containerPath
            : path.join(CONTAINER_PROJECT_ROOT, containerPath);

        // Resolve to prevent traversal (../../etc)
        const resolved = path.resolve(absContainer);
        if (!resolved.startsWith(CONTAINER_PROJECT_ROOT + path.sep) &&
            resolved !== CONTAINER_PROJECT_ROOT) {
            return null;
        }

        const relative = resolved.slice(CONTAINER_PROJECT_ROOT.length + 1);
        // session-manager has mounts/repositories mounted at /repositories
        const hostProjectRoot = path.join("/repositories", this.session.project.id);
        return path.join(hostProjectRoot, relative);
    }

    // -------------------------------------------------------------------------

    _readJson(req) {
        return new Promise((resolve, reject) => {
            let data = "";
            req.on("data", (chunk) => (data += chunk));
            req.on("end", () => {
                try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
            });
            req.on("error", reject);
        });
    }

    _sendJson(res, status, body) {
        const payload = JSON.stringify(body);
        res.writeHead(status, {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
        });
        res.end(payload);
    }
}

module.exports = SessionApiServer;
