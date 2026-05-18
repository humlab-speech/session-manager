const Session = require("../Session.class");

class OperationsSession extends Session {
    constructor(app, user, project, port, hsApp, volumes = []) {
        super(app, user, project, port, hsApp, volumes);
        this.imageName = "localhost/visp-jupyter-session";
        this.port = 8888;
        this.localProjectPath = "/home/jovyan/project";
        this.containerUser = "jovyan";
    }

    getContainerConfig() {
        let config = super.getContainerConfig();

        // Operations sessions are headless — no interactive server needed.
        // Set a minimal env so container-agent can run R + Node scripts.
        config.Env = [];

        // No network access needed — container-agent only runs local R/Node
        // scripts against bind-mounted project directories via podman exec.
        config.HostConfig.NetworkMode = "none";

        return config;
    }

    /**
     * Operations containers expose no HTTP server — session-manager communicates
     * only via `podman exec`. Override the readiness wait to just confirm the
     * container is running rather than polling TCP/UDS.
     */
    async _waitForSessionReady() {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const startTime = Date.now();
        const maxWait = parseInt(
            process.env.SESSION_START_TIMEOUT_MS || "120000",
            10,
        );

        this.app.addLog("Waiting for operations container to start...");

        while (true) {
            const elapsed = Date.now() - startTime;
            if (elapsed > maxWait) {
                throw new Error(
                    `Timeout waiting for operations container to start after ${elapsed} ms`,
                );
            }

            // _checkContainerIsRunning throws if the container crashed; returns
            // normally once State=running — that's all we need for operations.
            try {
                await this._checkContainerIsRunning();
                this.app.addLog(
                    `Operations container is running after ${Date.now() - startTime} ms`,
                );
                return;
            } catch (err) {
                // Not running yet — wait and retry
            }

            await sleep(500);
        }
    }
}

module.exports = OperationsSession;
