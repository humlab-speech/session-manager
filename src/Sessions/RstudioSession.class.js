const Session = require("../Session.class");

class RstudioSession extends Session {
    constructor(app, user, project, port, hsApp, volumes = []) {
        super(app, user, project, port, hsApp, volumes);
        this.imageName = "visp-rstudio-session";
        this.port = 8787;
        this.rstudioPassword = process.env.RSTUDIO_PASSWORD;
        this.localProjectPath = "/home/rstudio/project";
        this.containerUser = "rstudio";
    }

    getContainerConfig() {
        let config = super.getContainerConfig();

        config.Env = [
            "DISABLE_AUTH=true",
            "PASSWORD=" + this.rstudioPassword,
            //"RSP_LICENSE=None"
        ];

        return config;
    }
}

module.exports = RstudioSession;
