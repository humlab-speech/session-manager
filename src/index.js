const fs = require('fs');
const SessionManager = require('./SessionManager.class.js');
const SessionProxyServer = require('./SessionProxyServer.class');
const ApiServer = require('./ApiServer.class');


class Application {
  constructor() {
    this.gitlabAddress = process.env.GITLAB_ADDRESS;
    this.hsApiAccessToken = process.env.HS_API_ACCESS_TOKEN;
    this.gitlabAccessToken = process.env.GIT_API_ACCESS_TOKEN;
    this.absRootPath = process.env.ABS_ROOT_PATH;
    this.logLevel = process.env.LOG_LEVEL.toUpperCase();
    
    this.sessMan = new SessionManager(this);

    this.sessProxyServer = new SessionProxyServer(this);
    this.addLog("SessionProxyServer started at port "+this.sessProxyServer.port);
    this.apiServer = new ApiServer(this);
    this.addLog("ApiServer started at port "+this.apiServer.port);
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

  shutdown() {
    this.addLog('Shutdown requested. Committing live sessions...');
    //this.sessMan.exportRunningSessions();
    this.sessMan.commitRunningSessions();
  }
  
}

let application = null;

process.on('SIGINT', () => {
  console.log("SIGINT received");
  application.shutdown();
});

process.on('SIGTERM', () => {
  console.log("SIGTERM received");
  application.shutdown();
});

application = new Application();

