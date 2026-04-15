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

        return config;
    }
}

module.exports = OperationsSession;
