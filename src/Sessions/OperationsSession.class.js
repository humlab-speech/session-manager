const Session = require("../Session.class");

class OperationsSession extends Session {
    constructor(app, user, project, port, hsApp, volumes = []) {
        super(app, user, project, port, hsApp, volumes);
        this.imageName = "visp-jupyter-session";
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
}

module.exports = OperationsSession;
