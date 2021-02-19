const http = require('http');
const httpProxy = require('http-proxy');
const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const fs = require('fs');
const SessionManager = require('./SessionManager.class.js');

class Application {
  constructor() {
    this.webServerPort = process.env.WEBSERVER_PORT;
    this.gitlabAddress = process.env.GITLAB_ADDRESS;
    this.hsApiAccessToken = process.env.HS_API_ACCESS_TOKEN;
    this.gitlabAccessToken = process.env.GIT_API_ACCESS_TOKEN;
    this.logLevel = process.env.LOG_LEVEL.toUpperCase();
    this.expressApp = express();
    this.expressApp.use(bodyParser.urlencoded({ extended: true }));
    this.wsServer = new WebSocket.Server({ noServer: true });
    this.wsServer.on('connection', socket => {
      socket.on('message', message => this.addLog("ws msg:", message));
    });
    const proxyServer = httpProxy.createProxyServer({
      ws: true
    });

    this.setupEndpoints();
    this.sessMan = new SessionManager(this);
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
      this.addLog("Error: Invalid hs_api_access_token! Ignoring request.", 'warn');
      return false;
    }
    return true;
  }

  startServer() {

    this.sessMan.importRunningContainers().then(() => {
      this.addLog("Import of running containers complete");
      this.server = this.expressApp.listen(this.webServerPort, () => {
        this.addLog("Session Manager online");
        this.addLog("Listening on port "+this.webServerPort);
      });
      
      this.server.on('upgrade', (request, socket, head) => {
        this.addLog("http upgrade received");
        this.wsServer.handleUpgrade(request, socket, head, (webSocket) => {
          this.wsServer.emit('connection', webSocket, request);
          this.sessMan.routeToApp(request, null, socket, true, head);
        });
      });
    });
    
  }

  setupEndpoints() {
    this.expressApp.get('/*', (req, res, next) => {
      let parts = req.url.split("/");
      this.addLog(req.url);
      if(parts[1] != "api") {
        this.sessMan.routeToApp(req, res);
      }
      else {
        if(!this.checkApiAccessCode(req)) { //Requests to the approuter API must always include the API access code, which should be held by the webapi service
          res.sendStatus(401);
          return false;
        }
        else {
          next();
        }
      }
    });

    this.expressApp.post('/*', (req, res, next) => {
      let parts = req.url.split("/");
      if(parts[1] != "api") {
        this.sessMan.routeToApp(req, res);
      }
      else {
        if(!this.checkApiAccessCode(req)) { //Requests to the approuter API must always include the API access code, which should be held by the webapi service
          res.sendStatus(401);
          return false;
        }
        else {
          next();
        }
      }
    });
    
   this.expressApp.get('/api/sessions/:user_id', (req, res) => {
      this.addLog('/api/sessions/:user_id '+req.params.user_id);
      let sessions = this.sessMan.getUserSessions(parseInt(req.params.user_id));
      let out = JSON.stringify(sessions);
      res.end(out);
    });

    this.expressApp.get('/api/session/:session_id/commit', (req, res) => {
      let sess = this.sessMan.getSessionByCode(req.params.session_id);
      if(sess === false) {
        //Todo: Add error handling here if session doesn't exist
        res.end(`{ "msg": "Session does not exist", "level": "error" }`);
      }
      sess.commit().then((result) => {
        this.addLog(result);
        res.end(`{ "msg": "Committed ${result}", "level": "info" }`);
      }).catch((e) => {
        this.addLog("Error:"+e.toString('utf8'), 'error');
      });
    });

    this.expressApp.get('/api/session/:session_id/delete', (req, res) => {
      this.addLog('/api/session/:session_id/delete '+req.params.session_id);
      this.sessMan.deleteSession(req.params.session_id).then((ar) => {
        res.status(ar.code).end(JSON.stringify(ar.body));
      });
      
      /*
      let sess = this.sessMan.getSessionByCode(req.params.session_id);
      if(sess === false) {
        this.addLog("Error on delete: Session not found!", 'error');
        res.end(`{ "msg": "Error on delete: Session not found! Session id:${req.params.session_id}", "level": "error" }`);
        return false;
      }
      sess.delete().then(() => {
        let sessId = sess.accessCode;
        this.addLog("Deleting session "+sessId);
        this.sessMan.removeSession(sess);
        res.end(`{ "deleted": "${sessId}" }`);
      }).catch((e) => {
        this.addLog(e.toString('utf8'));
      });
      */
    });

    this.expressApp.post('/api/session/run', (req, res) => {
      let sessionId = req.body.appSession;
      let runCmd = JSON.parse(req.body.cmd);
      let sess = this.sessMan.getSessionByCode(sessionId);
      if(sess !== false) {
        this.addLog("Running cmd in session "+sess.shortDockerContainerId+": "+runCmd, "debug");
        sess.runCommand(runCmd).then((cmdOutput) => {
          this.addLog("cmd output: "+cmdOutput, "debug");
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
      
      this.addLog("Received request access session for user "+user.id+" and project "+project.id+" with session "+req.body.appSession);
      this.addLog("Volumes:");
      for(let key in volumes) {
        this.addLog("Volumes: "+key+":"+volumes[key]);
      }

      //Check for existing sessions
      let session = this.sessMan.getSession(user.id, project.id, hsApp);
      if(session === false) {
        this.addLog("No existing session was found, creating container");
        (async () => {

          let session = this.sessMan.createSession(user, project, hsApp);
          let containerId = await session.createContainer();
          let gitOutput = await session.cloneProjectFromGit();

          return session;
        })().then((session) => {
          this.addLog("Creating container complete, sending project access code to api/proxy");
          res.end(JSON.stringify({
            sessionAccessCode: session.accessCode
          }));
        });
      }
      else {
        this.addLog("Found existing session for user & project");
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
      
      this.addLog("Received request access session for user "+user.id+" and project "+project.id+" with session "+req.body.appSession);
      this.addLog("Volumes:");
      for(let key in volumes) {
        this.addLog("Volumes: "+key+":"+volumes[key]);
      }

      (async () => {
        let session = this.sessMan.createSession(user, project, hsApp, volumes);
        let containerId = await session.createContainer();
        let gitOutput = await session.cloneProjectFromGit();
        

        return session;
      })().then((session) => {
        this.addLog("Creating container complete, sending project access code to api/proxy");
        res.end(JSON.stringify({
          sessionAccessCode: session.accessCode
        }));
      });

    });

    this.expressApp.get('/api/session/commit/user/:user_id/project/:project_id/projectpath/:project_path', (req, res) => {
      this.addLog("Received request to commit session for user", req.params.user_id, "and project", req.params.project_id);
    });
  }

  addLog(msg, level = 'info') {
    let levelMsg = new String(level).toUpperCase();
    if(level == "DEBUG" && this.logLevel == "INFO") {
      return;
    }
    let printMsg = new Date().toLocaleDateString("sv-SE")+" "+new Date().toLocaleTimeString("sv-SE")+" ["+levelMsg+"] "+msg;
    let logMsg = printMsg+"\n";
    let logFile = "./session-manager.log";
    switch(level) {
      case 'info':
        console.log(printMsg);
        fs.appendFileSync(logFile, logMsg);
        break;
      case 'warn':
        console.warn(printMsg);
        fs.appendFileSync(logFile, logMsg);
        break;
      case 'error':
        console.error(printMsg);
        fs.appendFileSync(logFile, logMsg);
        break;
      default:
        console.error(printMsg);
        fs.appendFileSync(logFile, logMsg);
    }
  }
}

const application = new Application();
application.startServer();