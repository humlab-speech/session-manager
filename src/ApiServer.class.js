const express = require('express');
const http = require('http');
const https = require('https');
const bodyParser = require('body-parser');
const ApiResponse = require('./ApiResponse.class');
const WebSocket = require('ws');
const { Container } = require('node-docker-api/lib/container');
const Modem = require('docker-modem');
const WebSocketMessage = require('./WebSocketMessage.class');
const Rx = require('rxjs');

class ApiServer {
    constructor(app) {
        this.app = app;
        this.port = 8080;
        this.wsPort = 8020;
        this.wsClients = [];

        this.expressApp = express();
        this.expressApp.use(bodyParser.urlencoded({ extended: true }));

        this.setupEndpoints();
        this.startServer();
        this.startWsServer();

        /*
        setInterval(() => {
            this.wsClients.forEach(client => {
                client.socket.send('heartbeat');
            });
        }, 1000);
        */
    }

    startServer() {
        this.httpServer = http.createServer(this.expressApp);
        this.httpServer.on('request', (req, res) => {
            if(!req.headers.hs_api_access_token) {
                this.app.sessMan.routeToApp(req, res);
            }
        });
        
        this.httpServer.on('upgrade', (req, socket, head) => {
            this.app.addLog("Proxy ws req", "debug");
            this.app.sessMan.routeToAppWs(req, socket, head);
        });
        this.httpServer.listen(this.port);
    }

    startWsServer() {
        //We need a regular https-server which then can be 'upgraded' to a websocket server
        this.httpWsServer = http.createServer((req, res) => {
        });

        this.wss = new WebSocket.Server({ noServer: true });

        this.httpWsServer.on('upgrade', (request, socket, head) => {
            this.app.addLog("Client requested WS upgrade - authenticating");
            this.wss.handleUpgrade(request, socket, head, (ws) => {
                this.authenticateWebSocketUser(request).then((authResult) => {
                    if(authResult.authenticated) {
                        this.wss.emit('connection', ws, request);

                        let client = {
                            socket: ws,
                            userSession: authResult.userSession
                        };

                        this.wsClients.push(client);
                        
                        ws.on('message', message => this.handleIncomingWebSocketMessage(ws, message));
                        ws.on('close', () => {
                            this.handleConnectionClosed(client);
                        });

                        ws.send(new WebSocketMessage('0', 'status-update', 'Authenticated '+authResult.userSession.username).toJSON());
                    }
                    else {
                        ws.send(new WebSocketMessage('0', 'status-update', 'Authenticated failed of '+authResult.userSession.username).toJSON());
                        ws.close(1000);
                    }
                });
            });
        });

        this.httpWsServer.listen(this.wsPort);
    }

    handleConnectionClosed(client) {
        //If this client has any active operations-sessions, kill them
        if(client.userSession) {
            this.app.sessMan.getUserSessions(client.userSession.gitlabUser.id).forEach((session) => {
                if(session.type == "operations") {
                    this.shutdownSessionContainer(session.sessionCode);
                }
            });
        }
        
        if(this.deleteWsClient(client)) {
            this.app.addLog("Deleted websocket client");
        }
        else {
            this.app.addLog("Failed deleting websocket client", "error");
        }
    }

    deleteWsClient(client) {
        for(let key in this.wsClients) {
            if(this.wsClients[key] === client) {
                this.wsClients.splice(key, 1);
                return true;
            }
        }
        return false;
    }

    handleIncomingWebSocketMessage(ws, message) {
        //this.app.addLog('received: '+message);
        //received: {"cmd":"fetchOperationsSession","projectId":105}
        let msg = JSON.parse(message);

        if(msg.type == "cmd") {
            switch(msg.message) {
                case "fetchOperationsSession":
                    this.getSessionContainer(msg.params.user, msg.params.project).subscribe(data => {
                        if(data.type == "status-update") {
                            ws.send(new WebSocketMessage(msg.context, 'status-update', data.message).toJSON());
                        }
                        if(data.type == "data") {
                            ws.send(new WebSocketMessage(msg.context, 'data', data.accessCode).toJSON());
                        }
                    });
                    break;
            }
        }

        if(msg.cmd == "fetchOperationsSession") {
            //ws.send("Will totally spawn a new session container for you with "+msg.user.gitlabUsername+" and "+msg.project.id);
            this.getSessionContainer(ws, msg.user, msg.project).then(session => {
                ws.send(new WebSocketMessage(msg.context, 'data', session.accessCode).toJSON());
                //ws.send(JSON.stringify({ type: "data", sessionAccessCode: session.accessCode }));
            });
        }

        if(msg.cmd == "shutdownOperationsSession") {
            this.app.addLog("Shutdown of session "+msg.sessionAccessCode);
            this.shutdownSessionContainer(msg.sessionAccessCode).then((result) => {
                ws.send(JSON.stringify({ type: "status-update", sessionClosed: msg.sessionAccessCode }));
                //ws.close();
            });
        }

        if(msg.cmd == "scanEmuDb") {
            this.app.addLog("Scanning emuDb in session "+msg.sessionAccessCode);
            let session = this.app.sessMan.getSessionByCode(msg.sessionAccessCode);
            session.runCommand("node /container-agent/main.js emudb-scan", []).then((emuDbScanResult) => {
                ws.send(JSON.stringify({ type: "cmd-result", cmd: "scanEmuDb", session: msg.sessionAccessCode, result: emuDbScanResult }));
            });
        }
    }

    getSessionContainer( user, project, hsApp = "operations", volumes  = []) {
        return new Rx.Observable(async (observer) => {
            observer.next({ type: "status-update", message: "Creating session" });
            let session = this.app.sessMan.createSession(user, project, hsApp, volumes);
            observer.next({ type: "status-update", message: "Spawning container" });
            let containerId = await session.createContainer();
            let credentials = user.username+":"+user.personalAccessToken;
            observer.next({ type: "status-update", message: "Cloning project" });
            let gitOutput = await session.cloneProjectFromGit(credentials);
            observer.next({ type: "status-update", message: "Session ready" });
            this.app.addLog("Creating container complete");
            observer.next({ type: "data", accessCode: session.accessCode });
        });
    }

    async shutdownSessionContainer(sessionAccessCode) {
        let session = this.app.sessMan.getSessionByCode(sessionAccessCode);
        if(session) {
            return this.app.sessMan.deleteSession(sessionAccessCode);
        }
        return false;
    }

    async authenticateWebSocketUser(request) {
        let cookies = this.parseCookies(request);
        let phpSessionId = cookies.PHPSESSID;

        this.app.addLog('Validating phpSessionId '+phpSessionId);

        let options = {
            headers: {
                'Cookie': "PHPSESSID="+phpSessionId
            }
        }

        return new Promise((resolve, reject) => {
            http.get("http://edge-router/api/api.php?f=session", options, (incMsg) => {
                let body = "";
                incMsg.on('data', (data) => {
                    body += data;
                });
                incMsg.on('end', () => {
                    let responseBody = JSON.parse(body);
                    if(responseBody.body == "[]") {
                        this.app.addLog("User not identified");
                        resolve({
                            authenticated: false
                        });
                        return;
                    }

                    let userSession = JSON.parse(JSON.parse(body).body);
                    this.app.addLog("Welcome user "+userSession.username);
                    resolve({
                        authenticated: true,
                        userSession: userSession
                    });
                });
            });
        });
    }

    parseCookies (request) {
        var list = {},
            rc = request.headers.cookie;

        rc && rc.split(';').forEach(function( cookie ) {
            var parts = cookie.split('=');
            list[parts.shift().trim()] = decodeURI(parts.join('='));
        });
        return list;
    }

    async importContainerTest() {
        let containerId = "b8e26a40bcc364808d9681ccedae8000bdb35ecabdc6e6c9ade2643110921308";
        let modem = new Modem('/var/run/docker.sock');
        let container = new Container(modem, containerId);
        console.log(container);

        return new ApiResponse(200, JSON.stringify(container));
    }

    setupEndpoints() {
        
        this.expressApp.get('/api/isgitlabready', (req, res) => {
            //this.app.addLog('isGitlabReady');
            this.app.sessMan.isGitlabReady().then((gitlabIsReady) => {
                res.status(200).end(new ApiResponse(200, { gitlabIsReady: gitlabIsReady }).toJSON());
            });
        });

        this.expressApp.get('/api/importtest', (req, res) => {
            this.app.addLog('importtest');
            this.importContainerTest().then((ar) => {
                res.status(ar.code).end("ok");
            });
        });

        this.expressApp.get('/api/sessions/:user_id', (req, res) => {
            this.app.addLog('/api/sessions/:user_id '+req.params.user_id);
            let sessions = this.app.sessMan.getUserSessions(parseInt(req.params.user_id));
            let out = JSON.stringify(sessions);
            res.end(out);
        });

        this.expressApp.get('/api/session/:session_id/commit', (req, res) => {
            let sess = this.app.sessMan.getSessionByCode(req.params.session_id);
            if(sess === false) {
            //Todo: Add error handling here if session doesn't exist
            res.end(`{ "msg": "Session does not exist", "level": "error" }`);
            }
            sess.commit().then((result) => {
                let ar = new ApiResponse(200, result);
                res.status(ar.code);
                res.end(ar.toJSON());
            }).catch((e) => {
                this.app.addLog("Error:"+e.toString('utf8'), 'error');
            });
        });

        this.expressApp.get('/api/session/:session_id/copyuploadedfiles', (req, res) => {
            let sess = this.app.sessMan.getSessionByCode(req.params.session_id);
            if(sess === false) {
            //Todo: Add error handling here if session doesn't exist
            res.end(`{ "msg": "Session does not exist", "level": "error" }`);
            }
            sess.copyUploadedFiles().then((result) => {
                let ar = new ApiResponse(200, result);
                res.status(ar.code);
                res.end(ar.toJSON());
            }).catch((e) => {
                this.app.addLog("Error:"+e.toString('utf8'), 'error');
            });
        });
        

        this.expressApp.get('/api/session/:session_id/delete', (req, res) => {
            this.app.addLog('/api/session/:session_id/delete '+req.params.session_id);
            this.app.sessMan.deleteSession(req.params.session_id).then((ar) => {
                res.status(ar.code).end(JSON.stringify(ar.body));
            });
        });

        this.expressApp.post('/api/session/run', (req, res) => {
            let sessionId = req.body.appSession;
            let runCmd = JSON.parse(req.body.cmd);
            //let runCmd = req.body.cmd;
            this.app.addLog("req.body.env:"+req.body.env);
            
            let env = [];
            if(req.body.env) {
                env = JSON.parse(req.body.env);
            }
            
            let sess = this.app.sessMan.getSessionByCode(sessionId);
            if(sess !== false) {
                sess.runCommand(runCmd, env).then((cmdOutput) => {
                    this.app.addLog("cmd output: "+cmdOutput, "debug");
                    //res.sendStatus(200);
                    res.status(200).send(JSON.parse(cmdOutput).body).end();
                });
            }
        });

        //This asks to create a new session for this user/project
        this.expressApp.post('/api/session/user', (req, res) => {
            let user = JSON.parse(req.body.gitlabUser);
            let project = JSON.parse(req.body.project);
            let hsApp = req.body.hsApp;
            let gitlabPat = req.body.personalAccessToken;
            let volumes = [];
            if(typeof req.body.volumes != "undefined") {
                volumes = JSON.parse(req.body.volumes);
            }
            
            this.app.addLog("Received request access "+hsApp+" session for user "+user.id+" and project "+project.id+" with session "+req.body.appSession);
            this.app.addLog("Volumes:");
            for(let key in volumes) {
                this.app.addLog("Volumes: "+key+":"+volumes[key]);
            }

            //Check for existing sessions
            let session = this.app.sessMan.getSession(user.id, project.id, hsApp);
            if(session === false) {
            this.app.addLog("No existing session was found, creating container");
            
            (async () => {

                let session = this.app.sessMan.createSession(user, project, hsApp);
                let containerId = await session.createContainer();
                let credentials = user.username+":"+gitlabPat;
                let gitOutput = await session.cloneProjectFromGit(credentials);

                return session;
            })().then((session) => {
                this.app.addLog("Creating container complete, sending project access code ("+session.accessCode+") to api/proxy");
                res.end(JSON.stringify({
                    sessionAccessCode: session.accessCode
                }));
            });
            }
            else {
            this.app.addLog("Found existing session for user & project");
            res.end(JSON.stringify({
                sessionAccessCode: session.accessCode
            }));
            }

        });

        //This demands to create a new session for this user/project
        this.expressApp.post('/api/session/new/user', (req, res) => {
            let user = JSON.parse(req.body.gitlabUser);
            let project = JSON.parse(req.body.project);
            let hsApp = req.body.hsApp;
            let gitlabPat = req.body.personalAccessToken;
            let volumes = JSON.parse(req.body.volumes);
            
            this.app.addLog("Received request access session for user "+user.id+" and project "+project.id+" with session "+req.body.appSession);
            this.app.addLog("Volumes:");
            for(let key in volumes) {
                this.app.addLog("Volumes: "+key+":"+volumes[key].source+" => "+volumes[key].target);
            }

            (async () => {

                let session = this.app.sessMan.createSession(user, project, hsApp, volumes);
                let containerId = await session.createContainer();
                let credentials = user.username+":"+gitlabPat;
                let gitOutput = await session.cloneProjectFromGit(credentials);
                

                return session;
            })().then((session) => {
                this.app.addLog("Creating container complete, sending project access code to api/proxy");
                res.end(JSON.stringify({
                    sessionAccessCode: session.accessCode
                }));
            });

        });

        this.expressApp.get('/api/session/commit/user/:user_id/project/:project_id/projectpath/:project_path', (req, res) => {
            this.app.addLog("Received request to commit session for user", req.params.user_id, "and project", req.params.project_id);
        });
    }

    getCookies(req) {
        let cookiesParsed = [];
        let cookies = req.headers.cookie.split("; ");
        cookies.forEach((cookie) => {
            let cparts = cookie.split("=");
            let key = cparts[0];
            let value = cparts[1];
            cookiesParsed[key] = value;
        });
        
        return cookiesParsed;
    }
    
    checkApiAccessCode(req) {
        if(req.headers.hs_api_access_token !== this.hsApiAccessToken || typeof this.hsApiAccessToken == "undefined") {
            this.app.addLog("Error: Invalid hs_api_access_token! Ignoring request.", 'warn');
            return false;
        }
        return true;
    }
}

module.exports = ApiServer