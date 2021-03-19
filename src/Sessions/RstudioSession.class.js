const nanoid = require('nanoid');
const httpProxy = require('http-proxy');
const { Docker } = require('node-docker-api');
const { ApiResponse } = require('../ApiResponse.class');
const Session = require('../Session.class');

class RstudioSession extends Session {
    constructor(app, user, project, port, hsApp, volumes = []) {
        super(app, user, project, port, hsApp, volumes);
        this.imageName = "hs-rstudio-session";
        this.port = 8787;
        this.rstudioPassword = process.env.RSTUDIO_PASSWORD;
        this.localProjectPath = "/home/rstudio/humlabspeech";
        this.containerUser = "rstudio";
    }

    getContainerConfig() {
        let mounts = [];
        for(let key in this.volumes) {
            mounts.push({
                Target: this.volumes[key]['target'],
                Source: this.volumes[key]['source'],
                Type: "bind",
                ReadOnly: false
            });
        }
        
        return {
            Image: this.imageName,
            name: this.getContainerName(this.user.id, this.project.id),
            Env: [
                "DISABLE_AUTH=true",
                "PASSWORD="+this.rstudioPassword
            ],
            Labels: {
                "hs.hsApp": this.hsApp.toString(),
                "hs.userId": this.user.id.toString(),
                "hs.projectId": this.project.id.toString(),
                "hs.accessCode": this.accessCode.toString()
            },
            HostConfig: {
                AutoRemove: true,
                NetworkMode: "humlab-speech-deployment_hs-net",
                Mounts: mounts
            }
        };
    }
}

module.exports = RstudioSession