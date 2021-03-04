const http = require('http');
const httpProxy = require('http-proxy');
const express = require('express');
const bodyParser = require('body-parser');
//const WebSocket = require('ws');
const fs = require('fs');
const SessionManager = require('./SessionManager.class.js');
const SessionProxyServer = require('./SessionProxyServer.class');
const ApiServer = require('./ApiServer.class');


class Application {
  constructor() {
    this.gitlabAddress = process.env.GITLAB_ADDRESS;
    this.hsApiAccessToken = process.env.HS_API_ACCESS_TOKEN;
    this.gitlabAccessToken = process.env.GIT_API_ACCESS_TOKEN;
    this.logLevel = process.env.LOG_LEVEL.toUpperCase();
    //this.expressApp = express();
    //this.expressApp.use(bodyParser.urlencoded({ extended: true }));
    
    this.sessMan = new SessionManager(this);

    //this.simpleTestServer();
    this.sessProxyServer = new SessionProxyServer(this);
    this.addLog("SessionProxyServer started at port "+this.sessProxyServer.port);
    this.apiServer = new ApiServer(this);
    this.addLog("ApiServer started at port "+this.apiServer.port);
    
  }

  /*
  simpleTestServer() {
    this.addLog("Starting simple test server");
    var proxy = new httpProxy.createProxyServer({
      target: {
        host: 'jupyter',
        port: 8888
      }
    });
    
    let app = express();
    app.use(bodyParser.urlencoded({ extended: true }));
    //let proxyServer = app.listen(80);
    
    app.all('/*', (req, res) => {
      proxy.web(req, res);
    });
    
    var proxyServer = http.createServer(app);
    
    proxyServer.on('request', (req, res) => {
      console.log("Proxy http req");
      proxy.web(req, res);
    });
    proxyServer.on('upgrade', (req, socket, head) => {
      console.log("Proxy ws req");
      proxy.ws(req, socket, head);
    });
    
    let s = proxyServer.listen(80);
    
    this.addLog("Proxy online");
  }
  */

  /*
  trafficDivider(req, res, next) {
      this.addLog("Request: "+req.url);
      if(req.headers.hs_api_access_token) {
        if(!this.checkApiAccessCode(req)) { //Requests to the approuter API must always include the API access code, which should be held by the webapi service
          res.sendStatus(401);
          return false;
        }
        else {
          next();
        }
      }
      else {
        this.sessMan.routeToApp(req, res);
      }
  }

  trafficDividerWs(req, socket, head) {
    this.addLog("WS Request: "+req.url);
    if(req.headers.hs_api_access_token) {
      if(!this.checkApiAccessCode(req)) { //Requests to the approuter API must always include the API access code, which should be held by the webapi service
        res.sendStatus(401);
        return false;
      }
      else {
        next();
      }
    }
    else {
      this.sessMan.routeToAppWs(req, socket, head);
    }
  }
  */

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
//application.startServer();