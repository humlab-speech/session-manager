const express = require('express');
const http = require('http');
const bodyParser = require('body-parser');

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

        this.app.sessMan.importRunningContainers().then(() => {
            this.app.addLog("Import of running containers complete");

            this.httpServer = http.createServer(this.expressApp);

            
            this.httpServer.on('request', (req, res) => {
            this.app.addLog("Proxy http req");
            if(!req.headers.hs_api_access_token) {
                this.app.sessMan.routeToApp(req, res);
            }
            else {
                this.app.addLog("Not routing to app: "+req.url);
            }
            
            //proxy.web(req, res);
            });
            
            this.httpServer.on('upgrade', (req, socket, head) => {
            this.app.addLog("Proxy ws req");
            this.app.sessMan.routeToAppWs(req, socket, head);
            //proxy.ws(req, socket, head);
            });

            this.httpServer.listen(this.port);

            /*
            this.server = this.expressApp.listen(this.port, () => {
                this.app.addLog("Session Manager online");
                this.app.addLog("Listening on port "+this.port);
            });
            */
            
        });
    }


    setupEndpoints() {

        /*
        this.expressApp.all('/*', (req, res, next) => {
            this.trafficDivider(req, res, next);
        });
        */
        /*
        this.expressApp.get('/*', (req, res, next) => {
            this.trafficDivider(req, res, next);
        });

        this.expressApp.post('/*', (req, res, next) => {
            this.trafficDivider(req, res, next);
        });

        this.expressApp.put('/*', (req, res, next) => {
            this.trafficDivider(req, res, next);
        });

        this.expressApp.patch('/*', (req, res, next) => {
            this.trafficDivider(req, res, next);
        });

        this.expressApp.delete('/*', (req, res, next) => {
            this.trafficDivider(req, res, next);
        });
        */

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
            this.app.addLog(result);
            res.end(`{ "msg": "Committed ${result}", "level": "info" }`);
            }).catch((e) => {
            this.app.addLog("Error:"+e.toString('utf8'), 'error');
            });
        });

        this.expressApp.get('/api/session/:session_id/delete', (req, res) => {
            this.app.addLog('/api/session/:session_id/delete '+req.params.session_id);
            this.app.sessMan.deleteSession(req.params.session_id).then((ar) => {
            res.status(ar.code).end(JSON.stringify(ar.body));
            });
            
            /*
            let sess = this.app.sessMan.getSessionByCode(req.params.session_id);
            if(sess === false) {
            this.app.addLog("Error on delete: Session not found!", 'error');
            res.end(`{ "msg": "Error on delete: Session not found! Session id:${req.params.session_id}", "level": "error" }`);
            return false;
            }
            sess.delete().then(() => {
            let sessId = sess.accessCode;
            this.app.addLog("Deleting session "+sessId);
            this.app.sessMan.removeSession(sess);
            res.end(`{ "deleted": "${sessId}" }`);
            }).catch((e) => {
            this.app.addLog(e.toString('utf8'));
            });
            */
        });

        this.expressApp.post('/api/session/run', (req, res) => {
            let sessionId = req.body.appSession;
            let runCmd = JSON.parse(req.body.cmd);
            this.app.addLog("req.body.env:"+req.body.env);
            let env = [];
            if(req.body.env) {
                env = JSON.parse(req.body.env);
            }
            let sess = this.app.sessMan.getSessionByCode(sessionId);
            if(sess !== false) {
            this.app.addLog("Running cmd in session "+sess.shortDockerContainerId+": "+runCmd, "debug");
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
                let gitOutput = await session.cloneProjectFromGit();

                return session;
            })().then((session) => {
                this.app.addLog("Creating container complete, sending project access code to api/proxy");
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
            let volumes = JSON.parse(req.body.volumes);
            
            this.app.addLog("Received request access session for user "+user.id+" and project "+project.id+" with session "+req.body.appSession);
            this.app.addLog("Volumes:");
            for(let key in volumes) {
            this.app.addLog("Volumes: "+key+":"+volumes[key]);
            }

            (async () => {
                let session = this.app.sessMan.createSession(user, project, hsApp, volumes);
                let containerId = await session.createContainer();
                let gitOutput = await session.cloneProjectFromGit();
                

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