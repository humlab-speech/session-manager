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
        let mounts = [];
        for(let key in this.volumes) {
            mounts.push({
                Target: this.volumes[key]['target'],
                Source: this.volumes[key]['source'],
                Type: "bind",
                Mode: "ro,Z",
                RW: false,
                ReadOnly: true
            });
        }

        this.app.addLog("Setting jupyter token:"+this.accessCode);

        return {
            Image: this.imageName,
            name: this.getContainerName(this.user.id, this.project.id),
            Env: [
                "JUPYTER_ENABLE_LAB=yes",
                "JUPYTER_TOKEN="+this.accessCode
            ],
            Labels: {
                "visp.hsApp": this.hsApp.toString(),
                "visp.userId": this.user.id.toString(),
                "visp.projectId": this.project.id.toString(),
                "visp.accessCode": this.accessCode.toString()
            },
            HostConfig: {
                AutoRemove: true,
                NetworkMode: "humlab-speech-deployment_visp-net",
                Mounts: mounts
            }
        };
    }
}

module.exports = JupyterSession