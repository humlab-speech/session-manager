const nanoid = require('nanoid');
const Session = require('./Session.class');
const fetch = require('node-fetch');
const { Docker } = require('node-docker-api');
const ApiResponse = require('./ApiResponse.class');
const RstudioSession = require('./Sessions/RstudioSession.class');
const JupyterSession = require('./Sessions/JupyterSession.class');

class SessionManager {
    constructor(app) {
      this.app = app;
      this.sessions = [];
      this.docker = new Docker({ socketPath: '/var/run/docker.sock' });

      /*
      this.app.addLog("Waiting for Gitlab to come up...");
      this.isGitlabReadyInterval = setInterval(async () => {
        if(await this.isGitlabReady()) {
          clearInterval(this.isGitlabReadyInterval);
          this.importSuspendedSessions();
        }
      }, 2000);
      */
      
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
          this.app.addLog("Importing suspended session: "+image.data.Labels['hs.hsApp']+"/"+"u"+image.data.Labels['hs.userId']+"/p"+image.data.Labels['hs.projectId']);

          let fetchPromises = [];
          fetchPromises.push(this.fetchUserById(image.data.Labels['hs.userId']));
          fetchPromises.push(this.fetchProjectById(image.data.Labels['hs.projectId']));
          Promise.all(fetchPromises).then((data) => {
            let user = data[0];
            let project = data[1];
            let sess = this.createSession(user, project, image.data.Labels['hs.hsApp']);
            sess.overrideImage(image);
            sess.createContainer();
          });
          
          
        });
      });
    }

    commitRunningSessions(shutdownWhenDone = true) {
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

    async isGitlabReady() {
      return await fetch(this.app.gitlabAddress+"/api/v4/version?private_token="+this.app.gitlabAccessToken)
      .then((res) => {
        if (res.ok) { // res.status >= 200 && res.status < 300
          this.app.addLog("Gitlab is up");
          return true;
        } else {
          this.app.addLog("Gitlab is down (1)");
          return false;
        }
      })
      .catch(err => {
        this.app.addLog("Gitlab is down (2)");
        return false;
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

    getUserSessions(userId) {
      this.app.addLog("Getting user sessions for user "+userId);
      let userSessions = [];
      for(let key in this.sessions) {
        if(this.sessions[key].user.id == userId) {
          userSessions.push({
            sessionCode: this.sessions[key].accessCode,
            projectId: this.sessions[key].project.id,
            type: this.sessions[key].hsApp
          });
        }
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
        default:
          this.app.addLog("Unknown hsApp type: "+hsApp, "error");
      }
      
      this.sessions.push(sess);
      return sess;
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
          this.app.addLog("Couldn't perform routing to app because we couldn't get a sessionAccessCode from the request!", "warn");
          return false;
        }
        
        let sess = this.getSessionByCode(sessionAccessCode);
        if(sess === false) {
          this.app.addLog("Couldn't find a session with code "+sessionAccessCode, "warn");
          this.app.addLog(this.sessions);
          return false;
        }
        //this.app.addLog("Route-to-app - request: "+req.url, "debug");
        sess.proxyServer.web(req, res);
    }

    routeToAppWs(req, socket, head) {
      let sessionAccessCode = this.getSessionAccessCodeFromRequest(req);
      if(sessionAccessCode === false) {
        this.app.addLog("Couldn't perform routing to app because we couldn't get a sessionAccessCode from the request!", "warn");
        return false;
      }
      
      let sess = this.getSessionByCode(sessionAccessCode);
      if(sess === false) {
        this.app.addLog("Couldn't find a session with code "+sessionAccessCode, "warn");
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

    deleteSession(sessionId) {
      return new Promise((resolve, reject) => {
        let sess = this.getSessionByCode(sessionId);
        if(sess === false) {
          reject(new ApiResponse(200, "Could not find session "+sessionId));
        }

        sess.delete().then(() => {
          this.removeSession(sess);
          resolve(new ApiResponse(200, "Session "+sessionId+" deleted"));
        });
      });
    }

    async fetchUserById(userId) {
      return new Promise((resolve, reject) => {
        fetch(this.app.gitlabAddress+"/api/v4/users?id="+userId+"&private_token="+this.app.gitlabAccessToken)
        .then(response => response.json())
        .then(data => {
          resolve(data[0]);
        });
      });
    }

    async fetchProjectById(projectId) {
      return new Promise((resolve, reject) => {
      fetch(this.app.gitlabAddress+"/api/v4/projects?id="+projectId+"&private_token="+this.app.gitlabAccessToken)
        .then(response => response.json())
        .then(data => {
          resolve(data[0]);
        });
      });
    }

    /**
     * Function: importRunningContainers
     * This is indented to import any existing running sessions, in case the cluster was restarted while sessians were active.
     * However it doesn't work fully since we can only get an instance of the node-docker-api container class at creation time. This is functional in the way that it will re-enter the container into the local registry and allow users to proxy into the container, but there's no possibility of saving/commiting data or deleting the container form the portal site interface.
     */
    async importRunningContainers() {
      this.app.addLog("Importing existing session containers");

      return await new Promise((resolve, reject) => {

        this.docker.container.list().then(containers => {
          let filteredList = containers.filter((container) => {
            return typeof container.data.Labels['hs.hsApp'] != "undefined";
            //return container.data.Image == "hird-rstudio-emu";
          });

          this.app.addLog("Found "+filteredList.length+" session containers");
  
          let userIds = [];
          let users = [];
          let projectIds = [];
          let projects = [];
          let fetchPromises = [];
  
          filteredList.forEach((c) => {
            let hsApp = c.data.Labels['hs.hsApp'];
            let userId = c.data.Labels['hs.userId'];
            let projectId = c.data.Labels['hs.projectId'];
            let accessCode = c.data.Labels['hs.accessCode'];
            
            //Only fetch if we are not already fetching info for this user
            if(userIds.indexOf(userId) == -1) {
              this.app.addLog("Fetching user "+userId);
              userIds.push(userId);
              let p = fetch(this.app.gitlabAddress+"/api/v4/users?id="+userId+"&private_token="+this.app.gitlabAccessToken)
              .then(response => response.json())
              .then(data => {
                users.push(data[0]);
              });
  
              fetchPromises.push(p);
            }
  
            //Only fetch if we are not already fetching info for this project
            if(projectIds.indexOf(projectId) == -1) {
              this.app.addLog("Fetching project "+projectId);
              projectIds.push(projectId);
              let p = fetch(this.app.gitlabAddress+"/api/v4/projects?id="+projectId+"&private_token="+this.app.gitlabAccessToken)
              .then(response => response.json())
              .then(data => {
                projects.push(data[0]);
              });
  
              fetchPromises.push(p);
            }
            
          });
  
          Promise.all(fetchPromises).then(data => {

            filteredList.forEach((c) => {
              let hsApp = c.data.Labels['hs.hsApp'];
              let userId = c.data.Labels['hs.userId'];
              let projectId = c.data.Labels['hs.projectId'];
              let accessCode = c.data.Labels['hs.accessCode'];
  
              let userObj = null;
              users.forEach(user => {
                if(user.id == userId) {
                  userObj = user;
                }
              });
              let projObj = null;
              projects.forEach(project => {
                if(project.id == projectId) {
                  projObj = project;
                }
              });
  
              //this.app.addLog("Importing existing session: App:"+hsApp+" User:"+userObj.id+" Proj:"+projObj.id, "debug");
              
              let session = this.createSession(userObj, projObj, hsApp);
              session.setAccessCode(accessCode);
              let shortDockerContainerId = session.importContainerId(c.id);
              session.setupProxyServerIntoContainer(shortDockerContainerId);
            });

            resolve();
          });
  
        });

        
      });

      
    }

    /**
     * Function: closeOrphanContainers
     * WARNING: This has not been updated to use Docker API
     */

     /*
    closeOrphanContainers() {
      this.app.addLog("Closing any orphan session containers");

      let containers = this.importRunningContainers();
      containers.forEach((c) => {
        deleteContainer = true;
        this.sessions.forEach((s) => {
          if(c.id == s.shortDockerContainerId) {
            deleteContainer = false;
          }
        });
    
        if(deleteContainer) {
          let cmd = "docker stop "+c.id;
          child_process.exec(cmd, {}, () => {
            this.app.addLog("Stopped orphan container", c.id);
          });
        }
      });
    }
    */

};

module.exports = SessionManager
