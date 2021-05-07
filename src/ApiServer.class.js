const express = require('express');
const http = require('http');
const bodyParser = require('body-parser');
const ApiResponse = require('./ApiResponse.class');

const { Container } = require('node-docker-api/lib/container');
const Modem = require('docker-modem');

class ApiServer {
    constructor(app) {
        this.app = app;
        this.port = 8080;

        this.expressApp = express();
        this.expressApp.use(bodyParser.urlencoded({ extended: true }));

        this.setupEndpoints();
        this.startServer();
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

    async importContainerTest() {
        let containerId = "b8e26a40bcc364808d9681ccedae8000bdb35ecabdc6e6c9ade2643110921308";
        let modem = new Modem('/var/run/docker.sock');
        let container = new Container(modem, containerId);
        console.log(container);

        return new ApiResponse(200, JSON.stringify(container));
    }

    setupEndpoints() {
        
        this.expressApp.get('/api/isgitlabready', (req, res) => {
            this.app.addLog('isGitlabReady');
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
                    res.sendStatus(200);
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