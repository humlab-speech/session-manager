const fs = require('fs');
const { version } = require('../package.json');
const SessionManager = require('./SessionManager.class.js');
const SessionProxyServer = require('./SessionProxyServer.class');
const ApiServer = require('./ApiServer.class');
const colors = require('colors');


class Application {
  constructor() {
    this.gitlabAddress = process.env.GITLAB_ADDRESS;
    this.hsApiAccessToken = process.env.HS_API_ACCESS_TOKEN;
    this.absRootPath = process.env.ABS_ROOT_PATH;
    this.logLevel = process.env.LOG_LEVEL.toUpperCase();
    this.dockerSocketPath = process.env.DOCKER_SOCKET_PATH || '/run/user/1000/podman/podman.sock';
    colors.enable();

    this.sessMan = new SessionManager(this);
    this.sessProxyServer = new SessionProxyServer(this);
    this.addLog(`Session Manager v${version} starting up`);
    this.addLog("SessionProxyServer started at port "+this.sessProxyServer.port);
    this.apiServer = new ApiServer(this);
    this.addLog("ApiServer started at port "+this.apiServer.port);
    this.addLog("Init complete.");
  }

  addLog(msg, level = 'info') {
    let levelMsg = new String(level).toUpperCase();
    if(levelMsg == "DEBUG" && this.logLevel == "INFO") {
      return;
    }

    let levelMsgColor = levelMsg;

    if(levelMsg == "WARNING") { levelMsg = "WARN"; }

    switch(levelMsg) {
      case "INFO":
        levelMsgColor = colors.green(levelMsg);
      break;
      case "WARN":
        levelMsgColor = colors.yellow(levelMsg);
      break;
      case "ERROR":
        levelMsgColor = colors.red(levelMsg);
      break;
      case "DEBUG":
        levelMsgColor = colors.cyan(levelMsg);
      break;
    }
    
    let logMsg = new Date().toLocaleDateString("sv-SE")+" "+new Date().toLocaleTimeString("sv-SE");
    let printMsg = logMsg+" ["+levelMsgColor+"] "+msg;
    let writeMsg = logMsg+" ["+levelMsg+"] "+msg+"\n";
    
    let logFile = "logs/session-manager.log";
    let debugLogFile = "logs/session-manager.debug.log";
    switch(levelMsg) {
      case 'INFO':
        console.log(printMsg);
        fs.appendFileSync(logFile, writeMsg);
        fs.appendFileSync(debugLogFile, writeMsg);
        break;
      case 'WARN':
        console.warn(printMsg);
        fs.appendFileSync(logFile, writeMsg);
        fs.appendFileSync(debugLogFile, writeMsg);
        break;
      case 'ERROR':
        console.error(printMsg);
        fs.appendFileSync(logFile, writeMsg);
        fs.appendFileSync(debugLogFile, writeMsg);
        break;
      case 'DEBUG':
        console.debug(printMsg);
        fs.appendFileSync(debugLogFile, writeMsg);
    }
  }

  shutdown() {
    
    this.addLog('Shutdown requested. Waiting for submodules...');
    this.sessMan.shutdown();
    this.apiServer.shutdown();
    //this.sessMan.exportRunningSessions();
    
    //disabling this since:
    //1. it doesn't work right without gitlab as it currently is
    //2. it doesn't do much anyway since it doesn't actually save the data to disk, it only does a git commit
    //this.sessMan.commitRunningSessions();
  }
  
}

let application = null;

// The websocket dispatcher fires off its async command handlers without
// awaiting them (ApiServer.handleIncomingWebSocketMessage), so a rejection in
// any one of them would otherwise be an unhandled rejection - fatal under the
// Node >=15 default, i.e. one bad command would take the server down for every
// user. Log it and stay up.
process.on('unhandledRejection', (reason) => {
  const msg = 'Unhandled rejection: ' + (reason && reason.stack ? reason.stack : reason);
  // The safety net must not be fatal itself: addLog is an appendFileSync onto a host
  // bind mount, so a full or read-only disk turns logging the last error into an
  // uncaughtException inside the handler that exists to keep the process alive.
  try {
    if (application) {
      application.addLog(msg, 'error');
    } else {
      console.error(msg);
    }
  } catch (logError) {
    console.error(msg + ' (and logging it failed: ' + logError + ')');
  }
});

process.on('SIGINT', () => {
  console.log("SIGINT received");
  application.shutdown();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log("SIGTERM received");
  application.shutdown();
  process.exit(0);
});

application = new Application();

