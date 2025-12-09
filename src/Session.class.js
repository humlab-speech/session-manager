const nanoid = require('nanoid');
const fs = require('fs');
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
        this.createdAt = Date.now();
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
        let salt = nanoid(4);
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
            let mode = this.volumes[key]['mode'] || "rw,Z";
            mounts.push({
                Target: this.volumes[key]['target'],
                Source: this.volumes[key]['source'],
                Type: "bind",
                Mode: mode,
                RW: mode !== "ro,Z",
                ReadOnly: mode === "ro,Z"
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

        const keepContainers = process.env.SESSION_MANAGER_KEEP_CONTAINERS === 'true';
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
                // Allow disabling AutoRemove during development to keep exited containers for post-mortem
                AutoRemove: !keepContainers,
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
    
    /**
     * [REFACTORED] This is a new helper method to contain the container status check and retry logic.
     * It checks if the container is present and running in the Docker daemon.
     * It will retry a few times to avoid race conditions where the container isn't immediately visible after creation.
     * @throws {Error} if the container disappears or is found in a non-running state.
     */
    async _checkContainerIsRunning() {
        const maxRetries = 5;
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const containers = await this.docker.container.list({ all: true });
                const found = containers.find(c => c.id && c.id.substring(0, 12) === this.shortDockerContainerId);

                if (found) {
                    const state = found.data.State;
                    const status = found.data.Status || '';
                    this.app.addLog(`Container state check: State=${state} Status=${status}`, 'debug');

                    if (state === 'exited' || state === 'dead' || state === 'created') {
                        this.app.addLog(`Container ${this.shortDockerContainerId} is not running (State: ${state}, Status: ${status})`, "error");
                        // You can add log tailing logic here if desired
                        throw new Error(`Container in non-running state: ${status}`);
                    }
                    // If state is 'running', we're good.
                    return; 
                }

                // If not found, log and retry after a short delay
                this.app.addLog(`Container ${this.shortDockerContainerId} not yet visible (attempt ${attempt}/${maxRetries}), retrying...`, 'debug');
                
            } catch (err) {
                // If the error is the one we threw, re-throw it. Otherwise, log and retry.
                if (err.message.startsWith('Container in non-running state')) {
                    throw err;
                }
                this.app.addLog(`Error checking container list (attempt ${attempt}/${maxRetries}): ${err}`, 'warn');
            }
            
            if (attempt < maxRetries) {
                await sleep(200); // Wait before the next retry
            }
        }

        // If the loop finishes without finding the container
        this.app.addLog(`Container ${this.shortDockerContainerId} disappeared from daemon.`, "error");
        throw new Error('Container disappeared before becoming ready');
    }

    /**
     * [REFACTORED] This is a new helper method to encapsulate the entire waiting loop.
     * It polls the container status and readiness endpoint until the session is ready or a timeout occurs.
     */
    async _waitForSessionReady() {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const startTime = Date.now();
        const maxWait = parseInt(process.env.SESSION_START_TIMEOUT_MS || '120000', 10);

        this.app.addLog("Waiting for session to become ready...");

        while (true) {
            // 1. Check for timeout
            const elapsed = Date.now() - startTime;
            if (elapsed > maxWait) {
                throw new Error(`Timeout waiting for session to become ready after ${elapsed} ms`);
            }

            // 2. Check that the container is still running
            // This will throw an error if the container has crashed or disappeared, breaking the loop.
            await this._checkContainerIsRunning();

            // 3. Check if the service inside is ready
            try {
                if (await this.isSessionReady()) {
                    this.app.addLog(`Session is ready after ${Date.now() - startTime} ms`);
                    return; // Success, exit the loop
                }
            } catch (err) {
                this.app.addLog(`isSessionReady threw an error: ${err}`, 'warn');
            }
            
            // 4. Wait before the next poll
            await sleep(500);
        }
    }

    /**
     * [SIMPLIFIED] The main container creation method.
     * The original logic is preserved, but the complex waiting loop has been extracted
     * into the `_waitForSessionReady` method for clarity.
     */
    async createContainer() {
        this.app.addLog("Creating new project container");
        this.app.addLog(`${this.hsApp} ${this.user.username} ${this.project.id}`);

        const containerConfig = this.getContainerConfig();
        this.app.addLog(`containerConfig: ${JSON.stringify(containerConfig)}`, "debug");

        try {
            // Create and start the container
            const container = await this.docker.container.create(containerConfig);
            await container.start();
            this.app.addLog(`Container created and started. ID: ${container.data.Id}`);

            // Get a full container object and set up properties
            this.container = this.docker.container.get(container.data.Id);
            this.importContainerId(container.data.Id);
            
            // Setup log streaming (logic unchanged)
            this.setupLogStreaming();

            // Setup proxy
            this.app.addLog("Setting up proxy server");
            this.setupProxyServerIntoContainer(this.shortDockerContainerId);
            this.app.addLog("Proxy server online");

            // [REFACTORED] Delegate the entire waiting process to the new helper method
            await this._waitForSessionReady();
            
            // If we get here, the session is ready
            return this.shortDockerContainerId;

        } catch (error) {
            // Log stack when available for better diagnostics
            const stack = error && error.stack ? `\n${error.stack}` : '';
            this.app.addLog(`Failed to create or start session container: ${error}${stack}`, "error");
            
            // Re-throw the error to be handled by the caller
            throw error;
        }
    }

    /**
     * Helper to set up container log streaming to a file.
     * This logic was extracted from createContainer for clarity.
     */
    setupLogStreaming() {
        try {
            const logsDir = '/session-manager/logs';
            fs.mkdirSync(logsDir, { recursive: true });
            const logPath = `${logsDir}/${this.accessCode}.log`;
            const ws = fs.createWriteStream(logPath, { flags: 'a' });
            this.logFileWrite = ws;

            this.container.logs({ stdout: true, stderr: true, follow: true, timestamps: true })
                .then(stream => {
                    this.logStream = stream;
                    stream.on('data', chunk => {
                        try {
                            ws.write(chunk.toString());
                        } catch (err) {
                            this.app.addLog(`Error writing container log chunk: ${err}`, 'warn');
                        }
                    });
                    stream.on('end', () => {
                        try { ws.end(); } catch (e) {}
                        this.app.addLog(`Container log stream ended for ${this.shortDockerContainerId}`, 'debug');
                    });
                    stream.on('error', err => {
                        this.app.addLog(`Container log stream error: ${err}`, 'warn');
                    });
                })
                .catch(err => {
                    this.app.addLog(`Failed to start container log stream: ${err}`, 'warn');
                });
        } catch (err) {
            this.app.addLog(`Failed to setup log file: ${err}`, 'warn');
        }
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

        const url = "http://"+this.shortDockerContainerId+":"+this.port;
        this.app.addLog("Checking readiness: "+url, "debug");
        
        await fetch(url, {
            timeout: 1000
        })
        .then(res => {
            this.app.addLog("isSessionReady success: HTTP "+res.status, "debug");
            return res.text();
        })
        .then(body => {
            isSessionReady = true;
        })
        .catch(error => {
            this.app.addLog("isSessionReady failed: "+error.message, "debug");
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

        // Close any open log streams to flush logs to disk
        try {
            if(this.logStream && this.logStream.destroy) {
                try { this.logStream.destroy(); } catch(e) {}
            }
            if(this.logFileWrite) {
                try { this.logFileWrite.end(); } catch(e) {}
            }
        }
        catch(err) {
            this.app.addLog('Error while closing log streams: '+err, 'warn');
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
