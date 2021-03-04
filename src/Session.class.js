const nanoid = require('nanoid');
const httpProxy = require('http-proxy');
const { Docker } = require('node-docker-api');
const { ApiResponse } = require('./ApiResponse.class');

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
        this.docker = new Docker({ socketPath: '/var/run/docker.sock' });
    }

    setAccessCode(code) {
        this.accessCode = code;
    }

    promisifyStream(stream) {
        let streamData = "";
        return new Promise((resolve, reject) => {
          stream.on('data', data => {
            this.app.addLog("Stream data:"+data.toString());
            streamData += data.toString();
          });
          stream.on('end', resolve);
          stream.on('error', reject);
        });
    }

    async runCommand(cmd) {
        if(!Array.isArray(cmd)) {
            cmd = [cmd];
        }
        
        let cmdFlat = "";
        cmd.map((value) => {
            cmdFlat += value+" ";
        })

        this.app.addLog("Executing command in session container: "+cmdFlat);

        return new Promise((resolve, reject) => {
            return this.container.exec.create({
                AttachStdout: true,
                AttachStderr: true,
                Cmd: cmd
            })
            .then((exec) => {
                return exec.start({ Detach: false })
            })
            .then(stream => {
                this.promisifyStream(stream).then((data) => {
                    resolve(data);
                });
            })
            .catch((error) => this.app.addLog(error, "error"));
        });
    }

    /**
     * Function: loadContainerId
     * This is used to lookup/load the container ID during import of a running session/container, in which case only the userId, projectId and hsApp is known.
     */
    /*
    async loadContainerId() {
        await new Promise((resolve, reject) => {
            this.docker.container.list().then(containers => {
                let filteredList = containers.filter((container) => {
                    return container.data.Image == "hird-rstudio-emu";
                });
    
                let containerId = false;
                filteredList.forEach((c) => {
                    let hsApp = c.data.Labels['hs.hsApp'];
                    let userId = c.data.Labels['hs.userId'];
                    let projectId = c.data.Labels['hs.projectId'];
                    if(this.hsApp == hsApp && userId == this.user.id && projectId == this.project.id) {
                            containerId = c.id;
                    }
                });
                if(containerId !== false) {
                    this.importContainerId(containerId);
                }
                else {
                    this.app.addLog("Failed to find session container!", "error");
                }
                resolve();
            });
        });

        return this.shortDockerContainerId;
    }
    */

    getContainerName(userId, projectId) {
        let salt = nanoid.nanoid(4);
        return "rstudio-session-p"+projectId+"u"+userId+"-"+salt;
    }

    importContainerId(dockerContainerId) {
        this.fullDockerContainerId = dockerContainerId.toString('utf8');
        this.shortDockerContainerId = this.fullDockerContainerId.substring(0, 12);
        //this.accessCode = this.shortDockerContainerId;
        this.app.addLog("Imported container ID "+this.shortDockerContainerId);
    }

    /**
     * Function: getContainerConfig
     * To be implemented in subclasses
     */
    getContainerConfig() {
        return {};
    }

    async createContainer() {
        this.app.addLog("Creating new project container");
        this.app.addLog(this.hsApp+" "+this.user.id+" "+this.project.id);

        let dockerContainerId = null;

        let containerConfig = this.getContainerConfig();

        this.app.addLog("containerConfig: "+JSON.stringify(containerConfig), "debug");

        return await this.docker.container.create(containerConfig)
            .then(container => container.start())
            .then(async (container) => {
                dockerContainerId = container.data.Id;
                this.container = container;
                this.importContainerId(dockerContainerId);
                this.app.addLog("Container ID is "+this.shortDockerContainerId);
                this.app.addLog("Setting up proxy server");
                await this.setupProxyServerIntoContainer(this.shortDockerContainerId);
                this.app.addLog("Proxy server online");
                return this.shortDockerContainerId;
            })
            .catch(error => this.app.addLog("Docker container failed to start: "+error, "error"));
        
    }

    async setupProxyServerIntoContainer(shortDockerContainerId) {
        //Setting up proxy server
        /*
        this.proxyServer = httpProxy.createProxyServer({
            target: "http://"+shortDockerContainerId+':'+this.port
        });
        */

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

        this.proxyServer.on('proxyReqWs', (err, req, res) => {
            this.app.addLog("Rstudio-router session proxy received ws request!", "debug");
            this.app.addLog(req.url);
            //Can we redirect this request to the 17890 port here?
        });

        this.proxyServer.on('upgrade', function (req, socket, head) {
            this.app.addLog("Rstudio-router session proxy received upgrade!", "debug");
            //this.proxyServer.proxy.ws(req, socket, head);
        });
    }

    async cloneProjectFromGit() {
        this.app.addLog("Cloning project into container");
        let crendentials = "root:"+process.env.GIT_API_ACCESS_TOKEN;
        let gitRepoUrl = "http://"+crendentials+"@gitlab:80/"+this.project.path_with_namespace+".git";
        await this.runCommand(["git", "clone", gitRepoUrl, this.localProjectPath]);
        await this.runCommand(["chown", "-R", this.containerUser+":", this.localProjectPath]);
        this.app.addLog("Project cloned into container");
    }

    async commit() {
        this.app.addLog("Committing project");
        await this.runCommand(["git", "config", "--global", "user.email", this.user.email]);
        await this.runCommand(["git", "config", "--global", "user.name", this.user.name]);
        await this.runCommand(["bash", "-c", "cd "+this.localProjectPath+" && git add ."]);
        await this.runCommand(["bash", "-c", "cd "+this.localProjectPath+" && git commit -m 'system-auto-commit'"]);
        await this.runCommand(["bash", "-c", "cd "+this.localProjectPath+" && git push"]).then((cmdOutput) => {
            this.app.addLog("Commit cmd output: "+cmdOutput, "debug");
        });
        return this.accessCode;
    }

    async delete() {
        this.app.addLog("Deleting session "+this.accessCode);
        
        //This will stop new connections but not close existing ones
        try {
            this.proxyServer.off("error");
            this.proxyServer.off("proxyReq");
            this.proxyServer.off("proxyReqWs");
            this.proxyServer.off("upgrade");
            this.proxyServer.close();
        }
        catch(error) {
            this.app.addLog("Session error at proxy-server delete: "+error, "error");
        }

        try {
            await this.container.stop();
        }
        catch(error) {
            this.app.addLog("Session error at container stop: "+error, "error");
        }
        /*
        try {
            await this.container.delete();
        }
        catch(error) {
            this.app.addLog("Session error at container delete: "+error, "error");
        }
        */
        
        return this.accessCode;
    }
};

module.exports = Session
