const nanoid = require('nanoid');
const httpProxy = require('http-proxy');
const { Docker } = require('node-docker-api');
const { ApiResponse } = require('../ApiResponse.class');
const Session = require('../Session.class');

class OperationsSession extends Session {
    constructor(app, user, project, port, hsApp, volumes = []) {
        super(app, user, project, port, hsApp, volumes);
        this.imageName = "visp-operations-session";
        this.port = 8787;
        this.rstudioPassword = process.env.RSTUDIO_PASSWORD;
        this.localProjectPath = "/home/rstudio/project";
        this.containerUser = "rstudio";
    }

    getContainerConfig() {
        let config = super.getContainerConfig();

        config.Env = [
            "DISABLE_AUTH=true",
            "PASSWORD="+this.rstudioPassword
        ];

        return config;
    }
}

module.exports = OperationsSession