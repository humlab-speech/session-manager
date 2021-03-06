const express = require('express');
const http = require('http');
const ws = require('ws');
const httpProxy = require('http-proxy');
const bodyParser = require('body-parser');

class SessionProxyServer {
    constructor(app) {
        this.app = app;
        this.port = 80;

        //Outwards server
        this.httpServer = http.createServer();

        this.httpServer.on('request', (req, res) => {
            this.app.sessMan.routeToApp(req, res);
        });
        this.httpServer.on('upgrade', (req, socket, head) => {
            this.app.sessMan.routeToAppWs(req, socket, head);
        });

        this.httpServer.listen(this.port);
    }
}

module.exports = SessionProxyServer