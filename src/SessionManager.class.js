const nanoid = require('nanoid');
const Session = require('./Session.class');
const fetch = require('node-fetch');
const { Docker } = require('node-docker-api');
const ApiResponse = require('./ApiResponse.class');
const RstudioSession = require('./Sessions/RstudioSession.class');
const JupyterSession = require('./Sessions/JupyterSession.class');
const VscodeSession = require('./Sessions/VscodeSession.class');
const OperationsSession = require('./Sessions/OperationsSession.class');

class SessionManager {
    constructor(app) {
      this.app = app;
      this.sessions = [];
      this.docker = new Docker({ socketPath: '/var/run/docker.sock' });
    }

    importSuspendedSessions() {
      this.app.addLog('Importing suspended sessions');
      this.docker.image.list().then(sessionImages => {
        let imageShortList = [];
        sessionImages.forEach(si => {
          si.data.RepoTags.forEach((tag) => {
            let tagParts = tag.split(":");
            let tagName = tagParts[0];
            let tagVersion = tagParts[1];

            if(tagName == "hs-suspended-session") {
              imageShortList.push(si);
            }
          });
        });

        imageShortList.forEach((image) => {
          this.app.addLog("Importing suspended session: "+image.data.Labels['visp.hsApp']+"/"+"u"+image.data.Labels['visp.userId']+"/p"+image.data.Labels['visp.projectId']);

          let fetchPromises = [];
          fetchPromises.push(this.fetchUserById(image.data.Labels['visp.userId']));
          fetchPromises.push(this.fetchProjectById(image.data.Labels['visp.projectId']));
          Promise.all(fetchPromises).then((data) => {
            let user = data[0];
            let project = data[1];
            let sess = this.createSession(user, project, image.data.Labels['visp.hsApp']);
            sess.overrideImage(image);
            sess.createContainer();
          });
          
          
        });
      });
    }

    commitRunningSessions(shutdownWhenDone = true) {
      this.app.addLog('Committing all running sessions');
      let promises = [];
      this.sessions.forEach(session => {
        promises.push(session.commit());
      });

      Promise.all(promises).then(() => {
        this.app.addLog('All running sessions committed');
        if(shutdownWhenDone) {
          promises = [];
          this.sessions.forEach(session => {
            promises.push(session.delete());
          });

          Promise.all(promises).then(() => {
            this.app.addLog('All running sessions shutdown');
          });

        }
      });
    }

    exportRunningSessions() {
      this.sessions.forEach(session => {
        session.exportToImage();
      });
    }
    
    getContainerAccessCode() {
      let code = nanoid.nanoid(32);
      while(this.checkIfCodeIsUsed(code)) {
        code = nanoid.nanoid(32);
      }
      return code;
    }

    checkIfCodeIsUsed(code) {
      for(let key in this.sessions) {
        if(this.sessions[key].accessCode == code) {
          return true;
        }
      }
      return false;
    }

    getSessionsByProjectId(projectId) {
      this.refreshSessions();

      let sessions = [];
      this.sessions.forEach(session => {
        if(session.project.id == projectId) {
          sessions.push({
            projectId: session.project.id,
            username: session.user.username,
            type: session.hsApp,
            sessionAccessCode: session.accessCode
          });
        }
      });
      return sessions;
    }

    getUserSessions(username) {
      this.app.addLog("Getting user sessions for user "+username);
      let userSessions = [];
      for(let key in this.sessions) {
        if(this.sessions[key].user.username == username) {
          userSessions.push({
            sessionCode: this.sessions[key].accessCode,
            projectId: this.sessions[key].project.id,
            type: this.sessions[key].hsApp
          });
        }
      }
      if(userSessions.length == 0) {
        this.app.addLog("No container sessions found for user "+username);
      }
      return userSessions;
    }

    createSession(user, project, hsApp = 'rstudio', volumes = []) {
      let sess = null;
      switch(hsApp) {
        case "rstudio":
          sess = new RstudioSession(this.app, user, project, this.getAvailableSessionProxyPort(), hsApp, volumes);
        break;
        case "jupyter":
          sess = new JupyterSession(this.app, user, project, this.getAvailableSessionProxyPort(), hsApp, volumes);
        break;
        case "operations":
          sess = new OperationsSession(this.app, user, project, this.getAvailableSessionProxyPort(), hsApp, volumes);
          break;
        case "vscode":
          sess = new VscodeSession(this.app, user, project, this.getAvailableSessionProxyPort(), hsApp, volumes);
          break;
        default:
          this.app.addLog("Unknown hsApp type: "+hsApp, "error");
      }
      
      if(sess != null) {
        this.sessions.push(sess);
      }
      
      return sess;
    }

    refreshSessions() {
      //check with the docker daemon for running containers
      //if we find any that are not in the sessions array, add them
      //if we find any in the sessions array that are not in the docker daemon, remove them
      this.docker.container.list().then(containers => {
        let containerIds = [];
        containers.forEach(container => {
          let shortId = container.id.substring(0, 12);
          containerIds.push(shortId);
        });

        this.sessions.forEach(session => {
          if(containerIds.indexOf(session.shortDockerContainerId) == -1) {
            this.app.addLog("Session "+session.accessCode+" not found in docker daemon, removing", "debug");
            session.delete();
          }
        });
      });
    }

    getSessionAccessCodeFromRequest(req) {
        let sessionAccessCode = false;
        if(typeof req.headers.cookie != "undefined") {
            let cookies = req.headers.cookie.split("; ");
            cookies.forEach((cookie) => {
            let cparts = cookie.split("=");
            let key = cparts[0];
            let value = cparts[1];
            switch(key) {
                case "SessionAccessCode":
                sessionAccessCode = value;
                break;
            }
            });
        }
        return sessionAccessCode;
      }

    

    routeToApp(req, res = null, socket = null, ws = false, head = null) {
        let sessionAccessCode = this.getSessionAccessCodeFromRequest(req);
        if(sessionAccessCode === false) {
          this.app.addLog("Couldn't perform routing to app ("+req.url+") because we couldn't get a sessionAccessCode from the request! (1)", "warn");
          return false;
        }
        
        let sess = this.getSessionByCode(sessionAccessCode);
        if(sess === false) {
          this.app.addLog("Couldn't find a container session with code "+sessionAccessCode+" (1)", "warn");
          this.app.addLog(this.sessions);
          return false;
        }
        //this.app.addLog("Route-to-app - request: "+req.url, "debug");
        sess.proxyServer.web(req, res);
    }

    routeToAppWs(req, socket, head) {
      let sessionAccessCode = this.getSessionAccessCodeFromRequest(req);
      if(sessionAccessCode === false) {
        this.app.addLog("Couldn't perform routing to app ("+req.url+") because we couldn't get a sessionAccessCode from the request! (2)", "warn");
        return false;
      }
      
      let sess = this.getSessionByCode(sessionAccessCode);
      if(sess === false) {
        this.app.addLog("Couldn't find a container session with code "+sessionAccessCode+" (2)", "warn");
        this.app.addLog(this.sessions);
        return false;
      }
      
      this.app.addLog("Route-to-app ws - request: "+req.url, "debug");

      //socket.on('message', message => this.addLog("routeToAppWs - ws msg: "+message, "debug"));

      sess.proxyServer.ws(req, socket, head);
    }

    /*
    getSessionName(userId, projectId) {
        return "rstudio-session-p"+projectId+"u"+userId;
    }
    */

    stopContainer(containerId) {

    }

    fetchActiveSessionsOLD() {
        let containers = this.getRunningSessions();
        return containers;
    }
      
    /**
     * Function: getSession
     * 
     * Gets any session which may exist that matches this user, project & hsApp
     * 
     * @param {*} userId 
     * @param {*} projectId 
     * @param {*} hsApp 
     */
    getSession(userId, projectId, hsApp) {
      for(let key in this.sessions) {
        if(this.sessions[key].user.id == userId && this.sessions[key].project.id == projectId && this.sessions[key].hsApp == hsApp) {
          return this.sessions[key];
        }
      }
      return false;
    }
    
    getRunningContainers() {
      //This needs to be implemented using docker API
    }

    getSessionByCode(code) {
      if(typeof code != "string") {
        this.app.addLog("getSessionByCode received non-string argument: "+code, "error");
        return false;
      }
      code = code.toString('utf8');
      for(let key in this.sessions) {
        if(this.sessions[key].accessCode == code) {
          return this.sessions[key];
        }
      }
      return false;
    }

    getAvailableSessionProxyPort() {
        let portMin = 30000;
        let portMax = 35000;
        let selectedPort = portMin;
        let selectedPortInUse = true;
        while(selectedPortInUse) {
          selectedPortInUse = false;
          for(let key in this.sessions) {
            if(this.sessions[key].port == selectedPort) {
              selectedPortInUse = true;
            }
          }
          if(selectedPortInUse) {
            if(selectedPort < portMax) {
              selectedPort++;
            }
            else {
              return false;
            }
          }
          else {
            return selectedPort;
          }
        }
        
        return false;
      }

    removeSession(session) {
        for(let i = this.sessions.length-1; i > -1; i--) {
            if(this.sessions[i].accessCode == session.accessCode) {
              this.sessions.splice(i, 1);
            }
        }
    }

    sessionDeletionCleanup(sessionId) {
      //delete from the sessions array
      for(let key in this.sessions) {
        if(this.sessions[key].accessCode == sessionId) {
          this.sessions.splice(key, 1);
          return false;
        }
      }
    }

    deleteSession(sessionId) {
      return new Promise((resolve, reject) => {
        let sess = this.getSessionByCode(sessionId);
        if(sess === false) {
          reject("Could not find session "+sessionId);
        }

        sess.delete().then(() => {
          this.removeSession(sess);
          resolve("Session deleted");
        });
      });
    }

};

module.exports = SessionManager
