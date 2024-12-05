const fs = require('fs');
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
    colors.enable();

    this.sessMan = new SessionManager(this);
    this.sessProxyServer = new SessionProxyServer(this);
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

