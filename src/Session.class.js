const nanoid = require('nanoid');
const httpProxy = require('http-proxy');
const { Docker } = require('node-docker-api');
const { ApiResponse } = require('./ApiResponse.class');
const fetch = require('node-fetch');
const { PerformanceObserver, performance } = require('perf_hooks');

class Session {
    constructor(app, user, project, port, hsApp, volumes = []) {
        this.app = app;
        this.user = user;
        this.project = project;
        this.port = port;
        this.hsApp = hsApp;
        this.volumes = volumes;
        this.accessCode = this.app.sessMan.getContainerAccessCode();
        this.sessionCode = null; //This is identical to the container ID, thus if it is null, there's no container running for this session
        this.fullDockerContainerId = null;
        this.shortDockerContainerId = null;
        this.imageName = "";
        this.localProjectPath = "/home/project";
        this.containerUser = "";
        this.container = null;
        this.docker = new Docker({ socketPath: '/var/run/docker.sock' });
    }

    overrideImage(image) {
        this.imageName = image.id;
    }

    exportToImage() {
        if(this.container == null) {
            return false;
        }

        let imageTag = new Date().toISOString().substr(0, 10);
        imageTag += "-"+this.hsApp;
        imageTag += "-u-"+this.user.username;
        imageTag += "p-"+this.project.id;

        this.container.commit({
            tag: imageTag,
            comment: "hs suspended session",
            author: "hs",
            repo: "hs-suspended-session",
            pause: true
        }).then((image) => {
            console.log("Committed container "+this.shortDockerContainerId+" as image "+image.id);
        });
    }
    
    setAccessCode(code) {
        this.accessCode = code;
    }

    promisifyStream(stream, expectJsonResponse = true) {
        let streamData = "";
        return new Promise((resolve, reject) => {
          stream.on('data', data => {
            this.app.addLog("Stream data: "+data.toString());
            streamData += data.toString();
          });
          stream.on('end', () => {
            if(expectJsonResponse) {
                streamData = this.reduceToJson(streamData);
            }
            resolve(streamData);
          });
          stream.on('error', (data) => {
            this.app.addLog("Stream data: "+data.toString(), "error");
            reject();
          });
        });
    }

    reduceToJson(data) {
        let startOfJson = data.indexOf("{");
        let endOfJson = data.lastIndexOf("}");

        if(startOfJson == -1 || endOfJson == -1) {
            this.app.addLog("Could not reduce to JSON: "+data);
            return "{ error: \""+data+"\" }";
        }
        else {
            data = data.substring(startOfJson); //Strip leading garbage
            data = data.substring(0, endOfJson+1); //Strip trailing garbage
        }
        return data;
    }

    async runCommand(cmd, env = [], expectJsonResponse = true) {
        if(!Array.isArray(cmd)) {
            cmd = [cmd];
        }

        if(!Array.isArray(env)) {
            env = [env];
        }

        let envFlat = "";
        env.map((value) => {
            envFlat += value+" ";
        });
        
        let cmdFlat = "";
        cmd.map((value) => {
            cmdFlat += value+" ";
        })

        this.app.addLog("Executing command in session container: "+cmdFlat+" with ENV: "+envFlat);

        return this.container.exec.create({
            AttachStdout: true,
            AttachStderr: true,
            Env: env,
            Cmd: cmd,
        })
        .then((exec) => {
            return exec.start({ Detach: false })
        })
        .then(stream => {
            return this.promisifyStream(stream, expectJsonResponse);
        })
        .catch((error) => this.app.addLog(error, "error"));
    }

    getContainerName(userId, projectId) {
        let salt = nanoid.nanoid(4);
        return "hsapp-session-"+projectId+"-"+userId+"-"+salt;
    }

    importContainerId(dockerContainerId) {
        if(dockerContainerId.length == 12) {
            this.app.addLog("importContainerId was fed the short container id, expected full id.", "warn");
            this.shortDockerContainerId = dockerContainerId;
            return this.shortDockerContainerId;
        }
        this.fullDockerContainerId = dockerContainerId.toString('utf8');
        this.shortDockerContainerId = this.fullDockerContainerId.substring(0, 12);
        this.app.addLog("Imported container ID "+this.shortDockerContainerId);
        return this.shortDockerContainerId;
    }

    /**
     * Function: getContainerConfig
     * To be implemented in subclasses
     */
    getContainerConfig() {
        let mounts = [];
        for(let key in this.volumes) {
            mounts.push({
                Target: this.volumes[key]['target'],
                Source: this.volumes[key]['source'],
                Type: "bind",
                Mode: "rw,Z",
                RW: true,
                ReadOnly: false
            });
        }

        let devlopmentMode = process.env.DEVELOPMENT_MODE == "true";
        if(devlopmentMode) {
            this.app.addLog("Development mode enabled, mounting container-agent from local filesystem", "debug");
            mounts.push({
                Source: this.app.absRootPath+"/container-agent/dist",
                Target: '/container-agent',
                Type: "bind",
                Mode: "ro,Z",
                RW: false,
                ReadOnly: true
            });
        }

        let config = {
            Image: this.imageName,
            name: this.getContainerName(this.user.username, this.project.id),
            Env: [
                "DISABLE_AUTH=true",
                "PASSWORD="+this.rstudioPassword
            ],
            Labels: {
                "visp.hsApp": this.hsApp.toString(),
                "visp.username": this.user.username.toString(),
                "visp.projectId": this.project.id.toString(),
                "visp.accessCode": this.accessCode.toString()
            },
            HostConfig: {
                AutoRemove: true,
                NetworkMode: process.env.COMPOSE_PROJECT_NAME+"_visp-net",
                Mounts: mounts,
                Memory: 8*1024*1024*1024, //bytes
                MemorySwap: 16*1024*1024*1024,
                CpuShares: 512,
            },
            //User: `1000:1000`
        };
        /*
        config.Env = [
            "DISABLE_AUTH=true",
            "PASSWORD="+this.rstudioPassword
        ];
        */
        
        config.Labels = {
            "visp.hsApp": this.hsApp.toString(),
            "visp.username": this.user.username.toString(),
            "visp.projectId": this.project.id.toString(),
            "visp.accessCode": this.accessCode.toString()
        };

        return config;
    }
    

    async createContainer() {
        this.app.addLog("Creating new project container");
        this.app.addLog(this.hsApp+" "+this.user.username+" "+this.project.id);

        let dockerContainerId = null;
        let containerConfig = this.getContainerConfig();

        this.app.addLog("containerConfig: "+JSON.stringify(containerConfig), "debug");

        return new Promise(async (resolve, reject) => {
            this.docker.container.create(containerConfig)
            .then(container => {
                this.app.addLog("Container created - starting");
                return container.start();
            })
            .then(async (container) => {
                this.app.addLog("Container id:"+container.data.Id);
                dockerContainerId = container.data.Id;
                this.container = container;
                this.importContainerId(dockerContainerId);
                this.app.addLog("Container ID is "+this.shortDockerContainerId);
                this.app.addLog("Setting up proxy server");
                this.setupProxyServerIntoContainer(this.shortDockerContainerId);
                this.app.addLog("Proxy server online");
                return this.shortDockerContainerId;
            })
            .catch(error => {
                this.app.addLog("Docker container failed to start: "+error, "error");
                reject(error);
            });

            this.app.addLog("Waiting for session to become ready");
            let isSessionReady = false;
            let t0 = performance.now();
            while(!isSessionReady) {
                isSessionReady = await this.isSessionReady();
            }
            let t1 = performance.now()
            this.app.addLog("Session is ready after "+Math.round(t1 - t0)+" ms");

            resolve(this.shortDockerContainerId);
        });
    }

    /**
     * Function: isSessionReady
     * 
     * This will perform a standard "HTTP GET /" towards the container attached to this session to see if the service inside it is ready to accept requests
     * 
     * @returns 
     */
    async isSessionReady() {
        let isSessionReady = false;

        await fetch("http://"+this.shortDockerContainerId+":"+this.port, {
            timeout: 1000
        })
        .then(res => res.text())
        .then(body => {
            //this.app.addLog("isSessionReady response: "+body, "DEBUG")
            isSessionReady = true;
        })
        .catch(error => {
            //this.app.addLog("isSessionReady error: "+error, "ERROR");
            isSessionReady = false;
        });
            
        return isSessionReady;
    }

    setupProxyServerIntoContainer(shortDockerContainerId) {
        this.proxyServer = httpProxy.createProxyServer({
            target: {
                host: shortDockerContainerId,
                port: this.port
            }
        });

        this.proxyServer.on('error', (err, req, res) => {
            this.app.addLog("Proxy error: "+err, "error");
        });

        this.proxyServer.on('proxyReq', (err, req, res) => {
            //this.app.addLog("Rstudio-router session proxy received request!", "debug");
        });

        this.proxyServer.on('open', (proxySocket) => {
            this.app.addLog("Proxy open", "debug");
            //proxySocket.on('data', hybiParseAndLogMessage);
        });

        this.proxyServer.on('proxyReqWs', (err, req, res) => {
            this.app.addLog("Rstudio-router session proxy received ws request!", "debug");
            this.app.addLog(req.url);
        });

        this.proxyServer.on('upgrade', function (req, socket, head) {
            this.app.addLog("Rstudio-router session proxy received upgrade!", "debug");
            //this.proxyServer.proxy.ws(req, socket, head);
        });

    }

    async commit(branch = "master") {
        this.app.addLog("Committing project");
        this.app.addLog("GIT_USER_NAME="+this.user.firstName+" "+this.user.lastName);
        this.app.addLog("GIT_USER_EMAIL="+this.user.email);
        this.app.addLog("GIT_BRANCH="+branch);
        this.app.addLog("PROJECT_PATH="+this.localProjectPath);

        return new Promise((resolve, reject) => {
            this.runCommand(["node", "/container-agent/main.js", "save"], [
                "GIT_USER_NAME="+this.user.firstName+" "+this.user.lastName,
                "GIT_USER_EMAIL="+this.user.email,
                "GIT_BRANCH="+branch,
                "PROJECT_PATH="+this.localProjectPath
            ]).then(cmdResultString => {
                //Strip everything preceding the first { since it will just be garbage
                cmdResultString = cmdResultString.substring(cmdResultString.indexOf("{"));
                let cmdResult = null;
                try {
                    cmdResult = JSON.parse(cmdResultString);
                }
                catch(error) {
                    this.app.addLog(error, "error");
                    cmdResult = {
                        body: "error"
                    };
                }
                resolve(cmdResult.body);
            });
        });
    }

    async copyUploadedDocs() {
        this.app.addLog("Copying uploaded files");
        this.app.addLog("PROJECT_PATH="+this.localProjectPath);
        return await this.runCommand(["node", "/container-agent/main.js", "copy-docs"], [
            "PROJECT_PATH="+this.localProjectPath
        ]).then(cmdResultString => {
            //Strip everything preceding the first '{' since it will just be garbage
            cmdResultString = cmdResultString.substring(cmdResultString.indexOf("{"));
            return cmdResultString;
        });
    }

    /**
     * getGitResultBasedOnOutput
     * 
     * This method just tries to figure out the return status of the git operation based on the text output, it's primitive and fragile and should
     * be replaced by a better method at some point.
     * 
     * @param {*} msg 
     * @returns 
     */
    getGitResultBasedOnOutput(msg) {
        if(msg.indexOf("Nothing added to commit") != -1) {
            return "nothing-to-commit";
        }
        if(msg.indexOf("cannot push because a reference that you are trying to update on the remote contains commits that are not present locally") != -1) {
            return "conflict-on-commit";
        }

        return "no-error";
    }

    getGitFriendlyDateString() {
        let dateString = new Date().toISOString();
        dateString = dateString.replace(/:/g, "");
        dateString = dateString.substr(0, dateString.indexOf("."));
        return dateString;
    }


    async delete() {
        this.app.addLog("Shuttting down container session "+this.accessCode);
        
        //This will stop new connections but not close existing ones
        try {
            if(this.proxyServer) {
                this.proxyServer.off("open");
                this.proxyServer.off("error");
                this.proxyServer.off("proxyReq");
                this.proxyServer.off("proxyReqWs");
                this.proxyServer.off("upgrade");
                this.proxyServer.close();
            }
        }
        catch(error) {
            this.app.addLog("Session error at proxy-server delete: "+error, "error");
        }

        if(!this.container) {
            this.app.addLog("Session has no container reference.", "error");
            return {
                status: "error"
            };
        }

        try {
            await this.container.stop();
        }
        catch(error) {
            this.app.addLog("Session error at container stop: "+error, "error");
        }

        //notify the session manager that this session is now deleted
        this.app.sessMan.sessionDeletionCleanup(this.sessionCode);
        
        return {
            status: "ok"
        };
    }
};

module.exports = Session
