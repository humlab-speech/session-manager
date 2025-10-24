const Session = require("../Session.class");

class VscodeSession extends Session {
    constructor(app, user, project, port, hsApp, volumes = []) {
        super(app, user, project, port, hsApp, volumes);
        this.imageName = "visp-vscode-session";
        this.port = 8443;
        this.localProjectPath = "/config/workspace/project";
        this.containerUser = "abc";
    }

    getContainerConfig() {
        let config = super.getContainerConfig();

        config.Env = ["DOCKER_USER=abc"];

        return config;
    }
}

module.exports = VscodeSession;
