const nanoid = require('nanoid');
const httpProxy = require('http-proxy');
const { Docker } = require('node-docker-api');
const { ApiResponse } = require('../ApiResponse.class');
const Session = require('../Session.class');

class JupyterSession extends Session {
    constructor(app, user, project, port, hsApp, volumes = []) {
        super(app, user, project, port, hsApp, volumes);
        this.imageName = "visp-jupyter-session";
        this.port = 8888;
        this.localProjectPath = "/home/jovyan/project";
        this.containerUser = "jovyan";
    }

    getContainerConfig() {
        let config = super.getContainerConfig();

        config.Env = [
            "JUPYTER_ENABLE_LAB=yes",
            "JUPYTER_TOKEN="+this.accessCode
        ];

        return config;
    }
}

module.exports = JupyterSession