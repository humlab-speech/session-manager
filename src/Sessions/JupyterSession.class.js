const Session = require("../Session.class");

class JupyterSession extends Session {
    constructor(app, user, project, port, hsApp, volumes = []) {
        super(app, user, project, port, hsApp, volumes);
        this.imageName = "localhost/visp-jupyter-session";
        this.port = 8888;
        this.localProjectPath = "/home/jovyan/project";
        this.containerUser = "jovyan";

        // Enable UDS-based network isolation: --network=none + Unix socket
        this.useUDS = true;
    }

    getContainerConfig() {
        let config = super.getContainerConfig();

        config.Env = [
            "JUPYTER_ENABLE_LAB=yes",
            "JUPYTER_TOKEN=" + this.accessCode,
        ];

        // When using UDS, tell Jupyter to bind to a Unix socket instead of TCP.
        // The wrapper script starts a socat proxy bridge before exec'ing Jupyter.
        if (this.useUDS) {
            config.udsCommand = [
                "jupyter-uds-wrapper.sh",
                "--ServerApp.sock=/run/session/ui.sock",
                "--ServerApp.sock_mode=0o777",
            ];

            // Enable the proxy bridge inside the wrapper script and set
            // standard proxy env vars so pip/conda/CRAN use it automatically.
            config.Env.push("VISP_PROXY_ENABLED=1");
            config.Env.push("HTTP_PROXY=http://127.0.0.1:3128");
            config.Env.push("HTTPS_PROXY=http://127.0.0.1:3128");
            config.Env.push("http_proxy=http://127.0.0.1:3128");
            config.Env.push("https_proxy=http://127.0.0.1:3128");
            config.Env.push("NO_PROXY=localhost,127.0.0.1");
            config.Env.push("no_proxy=localhost,127.0.0.1");
        }

        return config;
    }
}

module.exports = JupyterSession;
