const express = require('express');
const http = require('http');
const https = require('https');
const bodyParser = require('body-parser');
const ApiResponse = require('./ApiResponse.class');
const WebSocket = require('ws');
const { Container } = require('node-docker-api/lib/container');
const Modem = require('docker-modem');
const WebSocketMessage = require('./WebSocketMessage.class');
const Rx = require('rxjs');
const validator = require('validator');
const mongodb = require('mongodb');
const UserSession = require('./models/UserSession.class');
const nanoid = require("nanoid");
const mongoose = require('mongoose');
const fs = require('fs-extra');
const simpleGit = require('simple-git');
const path = require('path');
const { exec } = require('child_process');
const { nativeSync } = require('rimraf');
const mime = require('mime-types');
const { execSync } = require('child_process');
const WhisperService = require('./WhisperService.class');
const AdmZip = require('adm-zip');

class ApiServer {
    constructor(app) {
        this.app = app;
        this.gitLabActivated = new String(process.env.GITLAB_ACTIVATED).toLowerCase() == "true";
        this.port = 8080;
        this.wsPort = 8020;
        this.wsClients = [];
        this.mongoClient = null;
        this.emuDbIntegrationEnabled = new String(process.env.EMUDB_INTEGRATION_ENABLED).toLowerCase() == "true";
        this.expressApp = express();
        this.expressApp.use(bodyParser.urlencoded({ extended: true }));
        this.expressApp.use(bodyParser.json());
        this.transcriptionQueue = [];
        this.whisperService = new WhisperService(this.app);

        this.setupEndpoints();
        this.startServer();
        this.startWsServer();
        this.talkToMeGoose().then((mongoose) => {
            this.mongoose = mongoose;
            this.defineModels();
            this.whisperService.init();
        });
        
    }

    defineModels() {
        this.app.addLog("Defining mongoose models", "debug");
        this.models = {};
        this.models.User = new mongoose.Schema({
            id: String,
            firstName: String,
            lastName: String,
            email: String,
            username: String,
            eppn: String,
            slug: String,
            phpSessionId: String,
            loginAllowed: Boolean,
            privileges: Object,
        });
        mongoose.model('User', this.models.User);

        this.models.Project = new mongoose.Schema({
            id: String,
            name: String,
            slug: String,
            sessions: Array,
            annotationLevels: Array,
            annotationLinks: Array,
            members: Array,
            docs: Array
        });
        mongoose.model('Project', this.models.Project);

        this.models.BundleList = new mongoose.Schema({
            owner: String,
            projectId: String,
            bundles: Array,
        });
        mongoose.model('BundleList', this.models.BundleList);
        
        this.models.TranscriptionQueueItem = new mongoose.Schema({
            id: String,
            project: String,
            session: String,
            bundle: String,
            initiatedByUser: String,
            language: String,
            status: String,
            error: String,
            log: String,
            createdAt: Date,
            updatedAt: Date,
            finishedAt: Date,
            transcriptionData: Object,
            preProcessing: String,
            preProcessingRuns: Number,
            userNotified: Boolean,
            queuePosition: Number
        });
        mongoose.model('TranscriptionQueueItem', this.models.TranscriptionQueueItem);
    }

    async fetchMongoUser(eppn) {
        const db = await this.connectToMongo();
        const usersCollection = db.collection("users");
        let user = await usersCollection.findOne({ eppn: eppn });
        return user;
    }

    startServer() {
        this.httpServer = http.createServer(this.expressApp);
        this.httpServer.on('request', (req, res) => {
            console.log("request: "+req.url);
            if(req.url == "/api/importaudiofiles") {
                //special case for this
                return;
            }

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

    async talkToMeGoose() { //also known as 'connectMongoose'
        const mongoUrl = 'mongodb://root:'+process.env.MONGO_ROOT_PASSWORD+'@mongo:27017/visp?authSource=admin';
        await mongoose.connect(mongoUrl, { useNewUrlParser: true, useUnifiedTopology: true });
        return mongoose;
    }
    connectMongoose = this.talkToMeGoose.bind(this);

    disconnectMongoose() {
        mongoose.disconnect();
    }

    async connectToMongo(database = "visp") {
        //check if this.mongoClient is already an active mongodb connection
        if(this.mongoClient != null && this.mongoClient.topology && this.mongoClient.topology.isConnected()) {
            //this.app.addLog("Reusing existing mongo connection", "debug");
            return this.mongoClient.db(database);
        }

        this.app.addLog("Connecting to mongo", "debug");
        const mongodbUrl = 'mongodb://root:'+process.env.MONGO_ROOT_PASSWORD+'@mongo:27017';
        this.mongoClient = new mongodb.MongoClient(mongodbUrl);
        let db = null;
        try {
            await this.mongoClient.connect()
            db = this.mongoClient.db(database);
        } catch(error) {
            console.error(error);
        }
        return db;
    }

    async disconnectFromMongo() {
        //are you sure you wish to call this? it closes the entire connection pool
        if(this.mongoClient != null) {
            await this.mongoClient.close();
            this.mongoClient = null;
        }
    }

    startWsServer() {
        //We need a regular https-server which then can be 'upgraded' to a websocket server
        this.httpWsServer = http.createServer((req, res) => {
        });

        this.wss = new WebSocket.Server({ noServer: true });

        this.httpWsServer.on('upgrade', (request, socket, head) => {
            this.wss.handleUpgrade(request, socket, head, (ws) => {
                let client = {
                    socket: ws,
                    authenticated: false,
                    userSession: null,
                    originalRequest: request
                };
                this.wsClients.push(client);

                ws.on('message', message => this.handleIncomingWebSocketMessage(ws, message));
                ws.on('close', (evt) => {
                    this.app.addLog("Websocket connection closed.");
                    this.handleConnectionClosed(client, evt);
                });

                ws.on('error', (error) => {
                    this.app.addLog("WebSocket error: "+error, "error");
                });
            });

            /*
            this.wss.handleUpgrade(request, socket, head, (ws) => {
                this.authenticateWebSocketUser(request).then(async (authResult) => {
                    if(authResult.authenticated) {
                        this.wss.emit('connection', ws, request);
                        let userSess = new UserSession(authResult.userSession);
                        //If we didn't receive a complete dataset, that's bad
                        if(userSess.isDataValidAndComplete() === false) {
                            this.app.addLog("WebSocket init failed due to incomplete user session data", "warn");
                            userSess.warnings.forEach(warning => {
                                this.app.addLog(warning, "WARN");
                            });
                            ws.send(new WebSocketMessage('0', 'status-update', 'Authentication failed - incomplete data').toJSON());
                            ws.close(1000);
                        }
                        let client = {
                            socket: ws,
                            userSession: userSess
                        };
                        //If all is well this far, then the user has authenticated via SWAMID and now has a valid session
                        //but we still need to check if this user is also included in the access list or not
                        
                        //if(await this.authorizeWebSocketUser(client) == false) {
                        //    ws.send(new WebSocketMessage('0', 'authorization-status', {
                        //        result: false,
                        //        reason: authResult.reason
                        //    }).toJSON());
                        //    return;
                        //}

                        this.wsClients.push(client);
                        
                        ws.on('message', message => this.handleIncomingWebSocketMessage(ws, message));
                        ws.on('close', () => {
                            this.app.addLog("Client closed connection.");
                            this.handleConnectionClosed(client);
                        });

                        ws.send(new WebSocketMessage('0', 'authentication-status', {
                            result: true
                        }).toJSON());
                    }
                    else {
                        //this.app.addLog("Authentication failed", "warn");
                        ws.send(new WebSocketMessage('0', 'authentication-status', {
                            result: false,
                            reason: authResult.reason
                        }).toJSON());
                        ws.close(1000);
                    }
                });
            });
            */
        });

        this.httpWsServer.listen(this.wsPort);
    }

    getClientBySocket(ws) {
        for(let key in this.wsClients) {
            if(this.wsClients[key].socket === ws) {
                return this.wsClients[key];
            }
        }
        return false
    }

    getUserSessionBySocket(ws) {
        for(let key in this.wsClients) {
            if(this.wsClients[key].socket === ws) {
                return this.wsClients[key].userSession;
            }
        }
        return false;
    }


    handleConnectionClosed(client, event) {

        if (event.wasClean) {
            this.app.addLog(`WebSocket closed cleanly, code=${event.code}, reason=${event.reason}`, "debug");
        } else {
            this.app.addLog(`WebSocket disconnected unexpectedly, code=${event.code}`, "warn");
        }
    
        // Determine who closed the connection
        if (event.code === 1000) {
            this.app.addLog("Client or server closed the connection normally.", "debug");
        } else if (event.code === 1006) {
            this.app.addLog("Connection lost.", "warn");
        } else {
            this.app.addLog("Closed with code:", event.code);
        }

        //If this client has any active operations-sessions, kill them
        if(client.userSession) {
            this.app.sessMan.getUserSessions(client.userSession.username).forEach((session) => {
                if(session.type == "operations") {
                    this.shutdownSessionContainer(session.sessionCode);
                }
            });
        }
        
        if(this.deleteWsClient(client)) {
            //this.app.addLog("Deleted websocket client");
        }
        else {
            this.app.addLog("Failed deleting websocket client", "error");
        }
    }

    deleteWsClient(client) {
        for(let key in this.wsClients) {
            if(this.wsClients[key] === client) {
                this.wsClients.splice(key, 1);
                return true;
            }
        }
        return false;
    }

    async fetchUser(userSession) {
        const User = this.mongoose.model('User');
        let user = await User.findOne({ eppn: userSession.eppn });
        return user;
    }

    denyAccess(ws, msg) {
        ws.send(new WebSocketMessage(msg.requestId, msg.cmd ? msg.cmd : 'unauthorized', {
            result: 400,
            msg: 'You are not authorized to use this functionality'
        }).toJSON());
    }

    async handleIncomingWebSocketMessage(ws, message) {
        this.app.addLog("Received: "+message, "debug");

        let msg = null;
        try {
            msg = JSON.parse(message);
        }
        catch(err) {
            this.app.addLog("Failed parsing incoming websocket message as JSON. Message was: "+message, "error");
        }

        let client = this.getClientBySocket(ws); 

        if(msg.cmd == "getSession") {
            this.getUserByPhpSessionId(msg.data.phpSessId).then((user) => {
                ws.send(new WebSocketMessage(msg.requestId, msg.cmd, user).toJSON());
            });
            return;
        }

        //FROM THIS POINT ON, ALL COMMANDS REQUIRE AUTHENTICATION
        let authResult = await this.authenticateWebSocketUser(client.originalRequest);
        if(!authResult.authenticated) {
            this.app.addLog("Failed to authenticate user, reason: "+authResult.reason, "warn");
            this.denyAccess(ws, msg);
            return;
        }
        else {
            //this.app.addLog("User "+authResult.userSession.eppn+" authenticated", "debug");
            client.userSession = authResult.userSession;
        }

        if(msg.cmd == "authenticateUser") {
            //msg.data might contain some userInfo, let's store it in the userSession
            if(msg.data && msg.data.eppn) {
                client.userSession = msg.data;
            }

            //since we are already authenticated, we can just send a success message
            ws.send(new WebSocketMessage(msg.requestId, msg.cmd, {
                result: 200,
                msg: 'Authenticated'
            }).toJSON());
            return;
        }

        if(msg.cmd == "signOut") {
            try {
                // Update the database to remove the PHP session ID
                const user = await this.mongoose.model('User').findOne({ eppn: client.userSession.eppn });

                if (user) {
                    user.phpSessionId = null;
                    await user.save(); // Save the updated document back to the database
                    this.app.addLog("User "+client.userSession.eppn+" signed out successfully");
                    ws.send(new WebSocketMessage(msg.requestId, msg.cmd, {
                        result: 200,
                        msg: 'Signed out'
                    }).toJSON());
                } else {
                    this.app.addLog("User "+client.userSession.eppn+" not found", "error");
                    ws.send(new WebSocketMessage(msg.requestId, msg.cmd, {
                        result: 400,
                        msg: 'User not found'
                    }).toJSON());
                }
            } catch (error) {
                this.app.addLog("Error signing out: "+error, "error");
                ws.send(new WebSocketMessage(msg.requestId, msg.cmd, {
                    result: 400,
                    msg: 'Error signing out'
                }).toJSON());
            }
            return;
        }

        let user = this.getUserSessionBySocket(ws);
        
        if(msg.cmd == "validateInviteCode") {
            this.validateInviteCode(ws, msg, user);
            return;
        }

        if(msg == null) {
            this.app.addLog("Received unparsable websocket message, ignoring.", "warning");
            return;
        }

        //FROM THIS POINT ON, ALL COMMANDS REQUIRE AUTHORIZATION (not to be confused with authentication)
        //here we perform authorization, so all command callbacks below this point are only executed if the user is authorized
        //if you wish to have a command that does not require authorization, place it above this point
        if(await this.authorizeWebSocketUser(user) == false) {
            this.denyAccess(ws, msg);
            return;
        }
        else {
            //this.app.addLog("User "+user.eppn+" authorized", "debug");
        }

        if(msg.cmd == "authorizeUser") {
            //since we are already authorized, we can just send a success message
            ws.send(new WebSocketMessage(msg.requestId, msg.cmd, {
                result: 200,
                msg: 'Authorized'
            }).toJSON());
            return;
        }

        if(msg.cmd == "transcribe") {
            this.whisperService.addFileToTranscriptionQueue(ws, user, msg);
            return;
        }

        if(msg.cmd == "removeTranscriptionFromQueue") {
            this.whisperService.removeTranscriptionFromQueue(ws, user, msg);
            return;
        }

        if(msg.cmd == "fetchTranscriptionQueueItems") {
            this.whisperService.fetchTranscriptionQueueItems(ws, user, msg);
            return;
        }

        if(msg.cmd == "fetchTranscription") {
            this.whisperService.fetchTranscription(ws, user, msg);
            return;
        }

        if(msg.cmd == "fetchMembers") {
            this.fetchMembers(ws, user, msg);
        }

        if(msg.cmd == "fetchProjects") {
            this.fetchProjects(ws, user, msg);
        }

        if(msg.cmd == "validateProjectName") {
            this.validateProjectName(ws, msg);
        }

        if(msg.cmd == "fetchSprScripts") {
            this.fetchSprScripts(ws, msg);
        }

        if(msg.cmd == "saveSprScripts") {
            this.saveSprScripts(ws, msg);
        }

        if(msg.cmd == "deleteSprScript") {
            this.deleteSprScript(ws, msg);
        }

        if(msg.cmd == "fetchSprData") {
            this.fetchSprData(ws, msg);
        }

        if(msg.cmd == "fetchSprSession") {
            this.fetchSprSession(msg.data.sprSessionId).then(result => {
                ws.send(new WebSocketMessage(msg.requestId, msg.cmd, result).toJSON());
                //ws.send(JSON.stringify({ type: "cmd-result", cmd: msg.cmd, result: result, requestId: msg.requestId }));
            });
        }

        if(msg.cmd == "fetchSprScriptBySessionId") {
            this.fetchSprScriptBySessionId(msg.data.sprSessionId).then(result => {
                ws.send(new WebSocketMessage(msg.requestId, msg.cmd, result).toJSON());
                //ws.send(JSON.stringify({ type: "cmd-result", cmd: msg.cmd, result: result, requestId: msg.requestId }));
            });
        }

        if(msg.cmd == "createSprSessions") {
            this.createSprSessions(ws, msg);
        }

        if(msg.cmd == "emuWebappSession") {
            this.app.addLog("emuWebappSession", "debug");
            //check that this user has authorization to access this project
            let userSession = this.getUserSessionBySocket(ws);
            let userSess = new UserSession(userSession);
            console.log(userSess);
            //ws.send(JSON.stringify({ type: "cmd-result", cmd: "emuWebappSession", progress: "end", result: "OK" }));
        }

        if(msg.cmd == "route-to-ca") {
            this.app.addLog("route-to-ca "+msg.caCmd+" "+msg.appSession, "debug");
            let session = this.app.sessMan.getSessionByCode(msg.appSession);
            if(!session) {
                ws.send(new WebSocketMessage(msg.requestId, msg.caCmd, { session: msg.appSession }, "Error - no such session", "end", false).toJSON());
                //ws.send(JSON.stringify({ type: "cmd-result", cmd: msg.caCmd, session: msg.appSession, result: "Error - no such session" }));
                return;
            }
            
            let envVars = [];
            msg.env.forEach(pair => {
                envVars.push(pair.key+"="+pair.value);
            });

            session.runCommand(["/usr/local/bin/node", "/container-agent/main.js", msg.caCmd], envVars).then((result) => {
                ws.send(JSON.stringify({ type: "cmd-result", cmd: msg.caCmd, session: msg.appSession, result: result }));
            });
        }

        if(msg.cmd == "save") {
            this.app.addLog("save", "debug");
            let session = this.app.sessMan.getSessionByCode(msg.appSession);
            if(!session) {
                ws.send(JSON.stringify({ type: "cmd-result", cmd: msg.caCmd, session: msg.appSession, result: "Error - no such session" }));
                return;
            }
            session.commit().then(result => {
                ws.send(JSON.stringify({ type: "cmd-result", cmd: msg.cmd, session: msg.appSession, result: result }));
            });
        }

        if(msg.cmd == "updateBundleLists") {
            this.updateBundleLists(ws, msg);
        }

        if(msg.cmd == "accessListCheck") {
            fs.readFile("/access-list.json", (error, data) => {
                if (error) throw error;
                console.log(data);
                const accessList = JSON.parse(data);
                console.log(accessList);
                ws.send(JSON.stringify({ type: "cmd-result", cmd: "accessListCheck", result: accessList.includes(msg.username) }));
            });
        }

        if(msg.cmd == "shutdownOperationsSession") {
            try {
                this.app.addLog("Shutdown of session "+msg.sessionAccessCode);
                this.shutdownSessionContainer(msg.sessionAccessCode).then((result) => {
                    ws.send(JSON.stringify({ type: "status-update", sessionClosed: msg.sessionAccessCode }));
                    //ws.close();
                });
            }
            catch(error) {
                this.app.addLog(error, "error")
            }            
        }

        if(msg.cmd == "scanEmudb") {
            try {
                this.app.addLog("Scanning emuDb in session "+msg.sessionAccessCode);
                let session = this.app.sessMan.getSessionByCode(msg.sessionAccessCode);
                let envVars = [
                    "PROJECT_PATH=/home/rstudio/project",
                    "UPLOAD_PATH=/home/uploads"
                ];
                session.runCommand(["/usr/local/bin/node", "/container-agent/main.js", "emudb-scan"], envVars).then((emuDbScanResult) => {
                    ws.send(JSON.stringify({ type: "cmd-result", cmd: "scanEmuDb", session: msg.sessionAccessCode, result: emuDbScanResult }));
                });
            }
            catch(error) {
                this.app.addLog(error, "error")
            }
        }

        if(msg.cmd == "uploadFile") {
            try {
                this.receiveFileUpload(ws, msg);
            }
            catch(error) {
                this.app.addLog(error, "error")
            }
        }

        if(msg.cmd == "saveProject") {
            try {
                this.saveProject(ws, user, msg);
            }
            catch(error) {
                this.app.addLog(error, "error")
            }
        }

        if(msg.cmd == "searchUsers") {
            try {
                this.searchUsers(ws, user, msg);
            }
            catch(error) {
                this.app.addLog(error, "error")
            }
        }

        if(msg.cmd == "addProjectMember") {
            try {
                this.addProjectMember(ws, user, msg);
            }
            catch(error) {
                this.app.addLog(error, "error")
            }
        }

        if(msg.cmd == "updateProjectMemberRole") {
            try {
                this.updateProjectMemberRole(ws, user, msg);
            }
            catch(error) {
                this.app.addLog(error, "error")
            }
        }

        if(msg.cmd == "removeProjectMember") {
            try {
                this.removeProjectMember(ws, user, msg);
            }
            catch(error) {
                this.app.addLog(error, "error")
            }
        }

        if(msg.cmd == "fetchBundleList") {
            try {
                this.fetchBundleList(ws, user, msg);
            }
            catch(error) {
                this.app.addLog(error, "error")
            }
        }

        if(msg.cmd == "saveBundleLists") {
            try {
                this.saveBundleLists(ws, user, msg);
            }
            catch(error) {
                this.app.addLog(error, "error")
            }
        }

        if(msg.cmd == "deleteProject") {
            try {
                this.deleteProject(ws, user, msg);
            }
            catch(error) {
                this.app.addLog(error, "error")
            }
        }

        if(msg.cmd == "deleteBundle") {
            try {
                this.deleteBundle(ws, user, msg);
            }
            catch(error) {
                this.app.addLog(error, "error")
            }
        }

        if(msg.cmd == "downloadBundle") {
            try {
                this.downloadBundle(ws, user, msg);
            }
            catch(error) {
                this.app.addLog(error, "error")
            }
        }

        if(msg.cmd == "closeSession") {
            try {
                this.closeContainerSession(ws, user, msg);
            }
            catch(error) {
                this.app.addLog(error, "error")
            }
        }

        if(msg.cmd == "launchContainerSession") {
            try {
                this.launchContainerSession(ws, user, msg);
            }
            catch(error) {
                this.app.addLog(error, "error")
            }
        }

        if(msg.cmd == "addSessions") {
            try {
                this.addSessions(ws, msg);
            }
            catch(error) {
                this.app.addLog(error, "error")
            }
        }

        if(msg.cmd == "shutdownSession") {
            try {
                this.shutdownSession(ws, msg);
            }
            catch(error) {
                this.app.addLog(error, "error")
            }
        }

        if(msg.cmd == "createSprProject") {
            this.app.addLog("Received cmd to createSprProject "+msg.project.name);
            this.createSprProject(msg.project.name, ws);
        }

        if(msg.cmd == "createEmuDb") {
            this.app.addLog("createEmuDb", "debug");
            this.createEmuDb(ws, msg);
        }

        if(msg.cmd == "generateInviteCode") {
            this.app.addLog("generateInviteCode", "debug");
            this.generateInviteCode(ws, msg);
        }
        if(msg.cmd == "updateInviteCodes") {
            this.app.addLog("updateInviteCodes", "debug");
            this.updateInviteCodes(ws, msg);
        }
        if(msg.cmd == "getInviteCodesByUser") {
            this.app.addLog("getInviteCodesByUser", "debug");
            this.getInviteCodesByUser(ws, msg);
        }
        if(msg.cmd == "deleteInviteCode") {
            this.app.addLog("deleteInviteCode", "debug");
            this.deleteInviteCode(ws, msg);
        }
        /*
        if(msg.cmd == "importEmuDbSessions") {
            this.app.addLog("createEmuDb", "debug");
            this.importEmuDbSessions(ws, msg.appSession);
        }
        */
    }

    async getUserByPhpSessionId(phpSessId) {
        const User = this.mongoose.model('User');
        let user = await User.findOne({ phpSessionId : phpSessId });
        return user;
    }

    async closeContainerSession(ws, user, msg) {
        let session = this.app.sessMan.getSessionByCode(msg.sessionAccessCode);
        if(!session) {
            ws.send(JSON.stringify({ type: "cmd-result", cmd: "closeSession", progress: "end", message: "Error - no such session", result: false, requestId: msg.requestId }));
            return;
        }

        if(session.user.username != user.username) {
            ws.send(JSON.stringify({ type: "cmd-result", cmd: "closeSession", progress: "end", message: "Error - you are not the owner of this session", result: false, requestId: msg.requestId }));
            return;
        }

        this.app.sessMan.deleteSession(msg.sessionAccessCode).then((result) => {
            ws.send(JSON.stringify({ type: "cmd-result", cmd: "closeSession", message: result, progress: "end", result: true, requestId: msg.requestId }));
        });
    }

    async launchContainerSession(ws, user, msg) {
        //check that this user has the authority to launch a session in this project (they need to have the project role 'admin')
        let project = await this.fetchProject(msg.projectId);
        if(!project) {
            ws.send(JSON.stringify({ type: "cmd-result", cmd: "launchContainerSession", progress: "end", message: "Error - no such project", result: false, requestId: msg.requestId }));
            return;
        }

        let userIsAuthorized = project.members.find(m => m.username == user.username && ( m.role == "admin" || m.role == "analyzer" ));
        if(!userIsAuthorized) {
            this.app.addLog("User "+user.username+" tried to launch a session in project "+msg.projectId+", but is not of an authorized role", "warning");
            ws.send(JSON.stringify({ type: "cmd-result", cmd: "launchContainerSession", progress: "end", message: "Error - user is not authorized", result: false, requestId: msg.requestId }));
            return;
        }

        //check if this user already has a running session, if so, route into that instead of spawning a new one
        let sessions = this.app.sessMan.getUserSessions(user.username);
        for(let key in sessions) {
            if(sessions[key].type == msg.appName && sessions[key].projectId == msg.projectId) {
                ws.send(JSON.stringify({ type: "cmd-result", cmd: "launchContainerSession", progress: "end", message: sessions[key].sessionCode, result: true, requestId: msg.requestId }));
                return;
            }
        }
        

        let volumes = [];

        let containerUser = null;
        switch(msg.appName) {
            case "operations":
            case "rstudio":
                containerUser = "rstudio";
                break;
            case "jupyter":
                containerUser = "jovyan";
                break;
        };

        if(containerUser == null) {
            ws.send(JSON.stringify({ type: "cmd-result", cmd: "launchContainerSession", progress: "end", message: "Error - unknown app name", result: false, requestId: msg.requestId }));
            return;
        }

        volumes.push({
            source: this.app.absRootPath+"/mounts/repositories/"+project.id,
            target: '/home/'+containerUser+'/project'
        });

        //if we are in development mode, mount the container-agent folder from the local filesystem
        //so that changes can easily be tested without having to rebuild the container
        let devlopmentMode = process.env.DEVELOPMENT_MODE == "true";
        if(devlopmentMode) {
            volumes.push({
                source: this.app.absRootPath+"/container-agent/dist",
                target: '/container-agent'
            });
        }
        
        this.getSessionContainer(user.username, msg.projectId, msg.appName, volumes).subscribe(status => {
            if(status.type == "status-update") {
                ws.send(JSON.stringify({ type: "cmd-result", cmd: "launchContainerSession", progress: "update", message: status.message, result: true, requestId: msg.requestId }));
            }
            if(status.type == "data") {
                ws.send(JSON.stringify({ type: "cmd-result", cmd: "launchContainerSession", progress: "end", message: status.accessCode,  result: true, requestId: msg.requestId }));
            }
        });
    }

    async updateProjectMemberRole(ws, user, msg) {
        const Project = this.mongoose.model('Project');
        let project = await Project.findOne({ id: msg.projectId });

        if (!project) {
            ws.send(JSON.stringify({ type: "cmd-result", requestId: msg.requestId, progress: 'end', cmd: msg.cmd, result: false, message: "Project not found" }));
            return;
        }

        //check that this user has the authority to update members in this project, project.members should contain this user with the role 'admin'
        let userIsAdmin = project.members.find(m => m.username == user.username && m.role == "admin");
        if(!userIsAdmin) {
            this.app.addLog("User "+user.username+" tried to update a member in project "+msg.projectId+", but is not an admin of this project", "warning");
            ws.send(JSON.stringify({ type: "cmd-result", requestId: msg.requestId, progress: 'end', cmd: msg.cmd, result: false, message: "User is not an admin of this project" }));
            return;
        }

        //check if user to update is a member
        let existingMember = project.members.find(m => m.username == msg.username);
        if(!existingMember) {
            ws.send(JSON.stringify({ type: "cmd-result", requestId: msg.requestId, progress: 'end', cmd: msg.cmd, result: false, message: "User is not a member of this project" }));
            return;
        }

        project.members.forEach(m => {
            if(m.username == msg.username) {
                m.role = msg.role;
            }
        });

        project.markModified('members');
        project.save();

        ws.send(JSON.stringify({ type: "cmd-result", requestId: msg.requestId, progress: 'end', cmd: msg.cmd, result: true }));
    }

    async addProjectMember(ws, user, msg) {
        const Project = this.mongoose.model('Project');
        let project = await Project.findOne({ id: msg.projectId });

        if (!project) {
            ws.send(new WebSocketMessage(msg.requestId, msg.cmd, {}, "Project not found", "end", false).toJSON());
            //ws.send(JSON.stringify({ type: "cmd-result", requestId: msg.requestId, progress: 'end', cmd: msg.cmd, result: false, message: "Project not found" }));
            return;
        }

        //get user info
        const User = this.mongoose.model('User');
        let userInfo = await User.findOne({ username: msg.username }).select('username email eppn firstName lastName fullName');

        if(!userInfo) {
            ws.send(new WebSocketMessage(msg.requestId, msg.cmd, {}, "User not found", "end", false).toJSON());
            //ws.send(JSON.stringify({ type: "cmd-result", requestId: msg.requestId, progress: 'end', cmd: msg.cmd, result: false, message: "User not found" }));
            return;
        }

        if(!project.members) {
            project.members = [];
        }

        //check that this user has the authority to add members to this project, project.members should contain this user with the role 'admin'
        let userIsAdmin = project.members.find(m => m.username == user.username && m.role == "admin");
        if(!userIsAdmin) {
            this.app.addLog("User "+user.username+" tried to add a member to project "+msg.projectId+", but is not an admin of this project", "warning");
            ws.send(new WebSocketMessage(msg.requestId, msg.cmd, {}, "User is not an admin of this project", "end", false).toJSON());
            //ws.send(JSON.stringify({ type: "cmd-result", requestId: msg.requestId, progress: 'end', cmd: msg.cmd, result: false, message: "User is not an admin of this project" }));
            return;
        }

        //check if user is already a member
        let existingMember = project.members.find(m => m.username == msg.username);
        if(existingMember) {
            ws.send(new WebSocketMessage(msg.requestId, msg.cmd, { result: false }, "User is already a member of this project", "end", false).toJSON());
            //ws.send(JSON.stringify({ type: "cmd-result", requestId: msg.requestId, progress: 'end', cmd: msg.cmd, result: false, message: "User is already a member of this project" }));
            return;
        }

        //add user to project
        project.members.push({
            username: msg.username,
            role: "member"
        });
        project.save();

        ws.send(new WebSocketMessage(msg.requestId, msg.cmd, { user: userInfo }, "User added to project", "end", true).toJSON());
        //ws.send(JSON.stringify({ type: "cmd-result", requestId: msg.requestId, progress: 'end', cmd: msg.cmd, result: true, user: userInfo }));
    }

    async removeProjectMember(ws, user, msg) {
        const Project = this.mongoose.model('Project');
        let project = await Project.findOne({ id: msg.projectId });

        if (!project) {
            ws.send(JSON.stringify({ type: "cmd-result", requestId: msg.requestId, progress: 'end', cmd: msg.cmd, result: false, message: "Project not found" }));
            return;
        }

        if(!project.members) {
            project.members = [];
        }

        //check that this user has the authority to remove members from this project, project.members should contain this user with the role 'admin'
        let userIsAdmin = project.members.find(m => m.username == user.username && m.role == "admin");
        if(!userIsAdmin) {
            this.app.addLog("User "+user.username+" tried to remove a member from project "+msg.projectId+", but is not an admin of this project", "warning");
            ws.send(JSON.stringify({ type: "cmd-result", requestId: msg.requestId, progress: 'end', cmd: msg.cmd, result: false, message: "User is not an admin of this project" }));
            return;
        }

        //check if user to remove is a member
        let existingMember = project.members.find(m => m.username == msg.username);
        if(!existingMember) {
            ws.send(JSON.stringify({ type: "cmd-result", requestId: msg.requestId, progress: 'end', cmd: msg.cmd, result: false, message: "User is not a member of this project" }));
            return;
        }

        //remove user from project
        project.members = project.members.filter(m => m.username != msg.username);
        project.save();

        ws.send(JSON.stringify({ type: "cmd-result", requestId: msg.requestId, progress: 'end', cmd: msg.cmd, result: true }));
    }

    async searchUsersOLD(ws, user, msg) {
        const User = this.mongoose.model('User');
        let users = [];
        User.find({ username: { $regex: msg.searchValue, $options: 'i' } }).then((result) => {
            result.forEach((user) => {
                users.push({
                    username: user.username,
                    eppn: user.eppn,
                    fullName: user.fullName ? user.fullName : user.firstName+" "+user.lastName,
                    email: user.email,
                });
            });

            ws.send(JSON.stringify({ type: "cmd-result", cmd: "searchUsers", result: users, requestId: msg.requestId }));
        });
    }

    async searchUsers(ws, user, msg) {
        const User = this.mongoose.model('User');
        let users = [];
    
        // Update the query to search in multiple fields
        User.find({
            $or: [
                { username: { $regex: msg.searchValue, $options: 'i' } },
                { fullName: { $regex: msg.searchValue, $options: 'i' } },
                { firstName: { $regex: msg.searchValue, $options: 'i' } },
                { lastName: { $regex: msg.searchValue, $options: 'i' } }
            ]
        }).then((result) => {
            result.forEach((user) => {
                users.push({
                    username: user.username,
                    eppn: user.eppn,
                    fullName: user.fullName ? user.fullName : user.firstName + " " + user.lastName,
                    email: user.email,
                });
            });
    

            ws.send(new WebSocketMessage(msg.requestId, msg.cmd, {
                data: users
            }).toJSON());

            //ws.send(JSON.stringify({ type: "cmd-result", cmd: "searchUsers", result: users, requestId: msg.requestId }));            

        }).catch((error) => {
            console.error('Error searching users:', error);
            ws.send(new WebSocketMessage(msg.requestId, msg.cmd, {}, "Failed to search users").toJSON());
            //ws.send(JSON.stringify({ type: "error", message: "Failed to search users", requestId: msg.requestId }));
        });
    }
    

    async fetchBundleList(ws, user, msg) {
        const User = this.mongoose.model('User');
        let selectedUser = await User.findOne({ username: msg.username });

        const Project = this.mongoose.model('Project');
        let project = await Project.findOne({ id: msg.projectId });

        //find via mongoose
        const BundleList = this.mongoose.model('BundleList');
        let bundleListResult = await BundleList.findOne({ owner: selectedUser.username, projectId: project.id });

        if(!bundleListResult) {
            //insert a new bundlelist
            bundleListResult = new BundleList({
                owner: selectedUser.username,
                projectId: project.id,
                bundles: []
            });
            bundleListResult.save();
        }

        ws.send(new WebSocketMessage(msg.requestId, msg.cmd, {
            data: bundleListResult
        }).toJSON());
        
        //ws.send(JSON.stringify({ type: "cmd-result", cmd: "fetchBundleList", result: bundleListResult, requestId: msg.requestId }));
    }

    async saveBundleLists(ws, user, msg) {

        for(let key in msg.bundleLists) {
            let bundleListDef = msg.bundleLists[key];

            const User = this.mongoose.model('User');
            let userResult = await User.find({ username: bundleListDef.username });
            let selectedUser = userResult[0];

            const Project = this.mongoose.model('Project');
            let projectResult = await Project.find({ id: msg.projectId });
            let project = projectResult[0];

            //find via mongoose
            const BundleList = this.mongoose.model('BundleList');
            let bundleListResult = await BundleList.find({ owner: selectedUser.username, projectId: project.id });

            let bundleList = null;
            if(bundleListResult.length > 0) {
                //update
                bundleList = bundleListResult[0];
                bundleList.bundles = bundleListDef.bundles;
            }
            else {
                //create
                bundleList = new BundleList({
                    owner: selectedUser.username,
                    projectId: project.id,
                    bundles: bundleListDef.bundles
                });
            }
            bundleList.save();
        }

        ws.send(JSON.stringify({ type: "cmd-result", cmd: "saveBundleLists", result: "OK", requestId: msg.requestId }));
    }

    async validateProjectName(ws, msg) {
        const Project = this.mongoose.model('Project');

        //Check that project name is valid, allow spaces, numbers and letters, and dash and underscore
        let validationRegex = /^[a-zA-Z0-9\s-_]+$/;
        if(!validationRegex.test(msg.projectName)) {
            ws.send(JSON.stringify({ type: "cmd-result", requestId: msg.requestId, progress: 'end', cmd: msg.cmd, result: false, message: "Project name must be alphanumeric" }));
            return;
        }

        //try to find projects with this name
        let projects = await Project.find({ name: { $regex: msg.projectName.trim(), $options: 'i' } });
        if(projects.length > 0) {
            ws.send(JSON.stringify({ type: "cmd-result", requestId: msg.requestId, progress: 'end', cmd: msg.cmd, result: false, message: "Project name already exists" }));
            return
        }

        ws.send(JSON.stringify({ type: "cmd-result", requestId: msg.requestId, progress: 'end', cmd: msg.cmd, result: true }));
    }

    /**
     * fetchMembers
     * 
     * This will fetch all the members in a project. It will return an array of users.
     * 
     * @param {*} ws 
     * @param {*} msg 
     * @returns 
     */
    async fetchMembers(ws, msg) {
        const Project = this.mongoose.model('Project');
        let project = await Project.findOne({ id: msg.projectId });

        if (!project) {
            ws.send(JSON.stringify({ type: "cmd-result", requestId: msg.requestId, progress: 'end', cmd: msg.cmd, result: [] }));
            return;
        }

        const User = this.mongoose.model('User');
        let userPromises = [];
        if (project.members) {
            project.members.forEach(m => {
                let p = User.findOne({ username: m.username }).lean();
                userPromises.push(p);
            });
        }

        let users = await Promise.all(userPromises);
        for(let key in users) {
            delete users[key].phpSessionId;
            delete users[key]._id;
            delete users[key].loggedIn;
        }

        ws.send(JSON.stringify({ type: "cmd-result", requestId: msg.requestId, progress: 'end', cmd: msg.cmd, result: users }));
    }

    async fetchProjects(ws, user, msg) {
        const Project = this.mongoose.model('Project');

        //get all projects where user is a member
        let projects = await Project.find({ "members.username": user.username }).lean();

        for(let key in projects) {
            let project = projects[key];
            for(let key2 in project.members) {
                const user = new this.mongoose.model('User');
                let userInfo = await user.findOne({ username: project.members[key2].username });
                if(userInfo) {
                    project.members[key2].fullName = typeof userInfo.fullName != "undefined" ? userInfo.fullName : " ";
                    project.members[key2].firstName = typeof userInfo.firstName != "undefined" ? userInfo.firstName : " ";
                    project.members[key2].lastName = typeof userInfo.lastName != "undefined" ? userInfo.lastName : " ";
                    project.members[key2].email = typeof userInfo.email != "undefined" ? userInfo.email : " ";
                    project.members[key2].eppn = userInfo.eppn;
                }
                else {
                    this.app.addLog("Failed fetching user info for "+project.members[key2].username, "error");
                }
            }

            //also return information about any running containers for this project
            projects[key].liveAppSessions = this.app.sessMan.getContainerSessionsByProjectId(project.id);
        }
    
        //ws.send(JSON.stringify({ type: "cmd-result", requestId: msg.requestId, progress: 'end', cmd: msg.cmd, result: projects }));
        
        ws.send(new WebSocketMessage(msg.requestId, msg.cmd, {
            result: 200,
            projects: projects
        }).toJSON());
    }
    
    async fetchProject(projectId) {
        const Project = this.mongoose.model('Project');

        return await Project.findOne({ "id": projectId });
    }

    createSprProject(projectName, ws = null) {
        //insert the project into the database
        let project = {
            projectId: nanoid.nanoid(),
            name: projectName,
            description: 'No description',
            audioFormat: {
                channels: 1
            },
            speakerWindowShowStopRecordAction: true,
            recordingDeviceWakeLock: true
        };
        
        this.connectToMongo("wsrng").then((db) => {
            //First, check if the project already exists
            db.collection("projects").find({ name: parseInt(project.name) }).toArray().then((result) => {
                if(result.length > 0) {
                    this.app.addLog("Project "+project.name+" already exists in database. Ignoring request.", "info");
                    if(ws != null) {
                        ws.send(JSON.stringify({ type: "cmd-result", cmd: "createSprProject", result: "ERROR", message: "Project already exists in database" }));
                    }
                }
                else {
                    this.app.addLog("Project "+project.name+" does not exist in database", "debug");
                    this.connectToMongo("wsrng").then((db) => {
                        db.collection("projects").insertOne(project).then((result) => {
                            this.app.addLog("Inserted project "+project.name+" into spr database", "debug");
                            if(ws != null) {
                                ws.send(JSON.stringify({ type: "cmd-result", cmd: "createSprProject", result: "OK" }));
                            }
                        });
                    });
                }
            });
        });

        return project;
    }

    async fetchSprScripts(ws, msg) {
        const db = await this.connectToMongo("wsrng");

        let query = {};
        if(msg.data.username != null) {
            query = { owner: msg.data.username };
        }
        //fetch all with this user OR with sharing set to 'all'
        query = { $or: [ { owner: msg.data.username }, { sharing: 'all' } ] }

        let scripts = await db.collection("scripts").find(query).toArray();
        ws.send(JSON.stringify({ type: "cmd-result", cmd: "fetchSprScripts", requestId: msg.requestId, result: scripts }));
    }

    async fetchSprData(ws, msg) {
        //fetch speech recorder project data from mongodb
        this.app.addLog("fetchSprData "+msg.projectId, "debug");
        const db = await this.connectToMongo("wsrng");
        let sprProject = await db.collection("projects").findOne({ name: parseInt(msg.projectId) });

        if(typeof sprProject == "undefined") {
            //Couldn't find the project in the database
            this.app.addLog("SPR project ("+msg.projectId+") not found in database", "warning");
            ws.send(JSON.stringify({ type: "cmd-result", cmd: msg.cmd, result: "ERROR: Project not found in database" }));
            return;
        }

        sprProject.sessions = await db.collection("sessions").find({ project: parseInt(msg.projectId) }).toArray();
        ws.send(JSON.stringify({ type: "cmd-result", cmd: msg.cmd, result: "OK", data: sprProject }));
    }

    async createSprSessions(ws, msg) {
        this.app.addLog("createSprSessions", "debug");

        let db = await this.connectToMongo("wsrng");
        let collection = db.collection("sessions");

        for(let key in msg.sessions) {
            let session = msg.sessions[key];
            let result = await collection.findOne({ project: session.projectId, sessionId: session.sessionId });
            if(!result) {
                this.app.addLog("Did not find spr session "+session.sessionId+" in mongodb, creating it.", "debug");
                await collection.insertOne({
                    project: session.projectId,
                    sessionId: session.sessionId,
                    sessionName: session.sessionName,
                    script: session.sessionScript,
                    debugMode: false,
                    type: 'NORM',
                    status: 'CREATED',
                    sealed: false
                });
            }
            else {
                this.app.addLog("Found spr session "+session.sessionId+" in mongodb, skipping.", "debug");
            }
        }

        ws.send(JSON.stringify({ type: "cmd-result", cmd: msg.cmd, result: "OK" }));
    }

    async saveSprScripts(ws, msg) {
        let scripts = msg.data.scripts;
        let owner = msg.data.owner;

        //convert scripts to spr format
        let sprScripts = [];
        for(let key in scripts) {
            let script = scripts[key];

            let sprScript = {
                name: script.name,
                type: "script",
                scriptId: script.scriptId,
                owner: owner,
                sharing: script.sharing, //'none' or 'all', perhaps more in the future, such as 'project'
                sections: [{
                    name: "Recording Session",
                    order: "SEQUENTIAL",
                    training: false,
                    speakerDisplay: true,
                    groups: [{
                        promptItems: []
                    }]
                }]
            };

            for(let promptKey in script.prompts) {
                let prompt = script.prompts[promptKey];
                let promptItem = {
                    itemcode: prompt.itemcode,
                    recinstructions: {
                        recinstructions: "Say the following"
                    },
                    mediaitems: [
                        {
                            annotationTemplate: false,
                            autoplay: false,
                            mimetype: 'text/plain',
                            text: prompt.value
                        }
                    ]
                };
                if(prompt.value != "") { //ignore empty prompts
                    sprScript.sections[0].groups[0].promptItems.push(promptItem);
                }
            }

            sprScripts.push(sprScript);
        }

        //save scripts to mongodb
        this.app.addLog("Saving SPR scripts", "info");
        this.connectToMongo("wsrng").then(async (db) => {
            for(let key in sprScripts) {
                let script = sprScripts[key];
                //replace if exists
                let found = await db.collection("scripts").findOne({scriptId: script.scriptId });
                if(found) {
                    await db.collection("scripts").replaceOne({ scriptId: script.scriptId }, script);
                }
                else {
                    await db.collection("scripts").insertOne(script);
                }
            }
            
            ws.send(JSON.stringify({ type: "cmd-result", cmd: "saveSprScripts", result: "OK", requestId: msg.requestId }));
        });
    }

    async deleteSprScript(ws, msg) {
        this.connectToMongo("wsrng").then(async (db) => {
            await db.collection("scripts").deleteOne({ scriptId: msg.data.scriptId });
            ws.send(JSON.stringify({ type: "cmd-result", cmd: "deleteSprScript", result: "OK", requestId: msg.requestId }));
        });
    }

    async updateBundleLists(ws, msg) {
        try {
            this.app.addLog("Updating bundle lists in emuDb");
            let session = this.app.sessMan.getSessionByCode(msg.sessionAccessCode);
            let envVars = [
                "PROJECT_PATH=/home/rstudio/project",
                "UPLOAD_PATH=/home/uploads",
                "BUNDLE_LISTS="+new Buffer.from(JSON.stringify(msg.data)).toString("base64")
            ];
            
            await session.runCommand(["/usr/local/bin/node", "/container-agent/main.js", "emudb-update-bundle-lists"], envVars).then((result) => {
                ws.send(JSON.stringify({ type: "cmd-result", cmd: "updateBundleLists", progress: "1/2", session: msg.sessionAccessCode, result: result }));
            });
            await session.commit().then((result) => {
                ws.send(JSON.stringify({ type: "cmd-result", cmd: "updateBundleLists", progress: "2", session: msg.sessionAccessCode, result: result }));
            });
        }
        catch(error) {
            this.app.addLog(error, "error")
        }
    }

    async addSessions(ws, msg) {
        ws.send(JSON.stringify({
            type: "cmd-result", 
            cmd: "addSessions", 
            progress: "1/5", 
            result: "Initiating"
        }));
        let context = msg.data.context;
        let form = msg.data.form;
        let sessionAccessCode = msg.data.sessionAccessCode;
        let containerSession = this.app.sessMan.getSessionByCode(sessionAccessCode);
        if(!containerSession) {
            this.app.addLog("Couldn't find session for "+sessionAccessCode, "error");
            return;
        }

        //Check that names are ok
        for(let key in msg.data.form.sessions) {
            msg.data.form.sessions[key].name = validator.escape(msg.data.form.sessions[key].name);
            msg.data.form.sessions[key].name = msg.data.form.sessions[key].name.replace(/ /g, "_");
        }

        //Make sure that age is a number, not a string
        for(let sessionKey in msg.data.form.sessions) {
            msg.data.form.sessions[sessionKey].speakerAge = parseInt(msg.data.form.sessions[sessionKey].speakerAge);
        }

        this.app.addLog("Will add emudb-session to container-session "+sessionAccessCode);

        let userSession = this.getUserSessionBySocket(ws);

        let envVars = [];
        envVars.push("PROJECT_PATH=/home/rstudio/project");
        let sessionsJsonB64 = Buffer.from(JSON.stringify(form.sessions)).toString("base64");
        envVars.push("EMUDB_SESSIONS="+sessionsJsonB64);
        envVars.push("UPLOAD_PATH=/home/uploads/"+context);
        envVars.push("BUNDLE_LIST_NAME="+userSession.getBundleListName());

        ws.send(JSON.stringify({
            type: "cmd-result", 
            cmd: "addSessions", 
            progress: "2", 
            result: "Creating sessions"
        }));
        await containerSession.runCommand(["/usr/local/bin/node", "/container-agent/main.js", "emudb-create-sessions"], envVars);

        ws.send(JSON.stringify({
            type: "cmd-result", 
            cmd: "addSessions", 
            progress: "3", 
            result: "Creating bundle lists"
        }));
        await containerSession.runCommand(["/usr/local/bin/node", "/container-agent/main.js", "emudb-create-bundlelist"], envVars);

        
        ws.send(JSON.stringify({
            type: "cmd-result", 
            cmd: "addSessions", 
            progress: "4", 
            result: "Adding track definitions" 
        }));
        await containerSession.runCommand(["/usr/local/bin/node", "/container-agent/main.js", "emudb-track-definitions"], envVars);

        ws.send(JSON.stringify({
            type: "cmd-result", 
            cmd: "addSessions", 
            progress: "5", 
            result: "Pushing to Git"
        }));
        await containerSession.commit();
        ws.send(JSON.stringify({
            type: "cmd-result", 
            cmd: "addSessions", 
            progress: "end", 
            result: "Shutting down session"
        }));
    }

    async shutdownSession(ws, msg) {
        this.app.sessMan.deleteSession(msg.sessionAccessCode).then(() => {
            ws.send(JSON.stringify({ type: "cmd-result", cmd: "shutdownSession", progress: "end", result: "Shutdown completed" }));
        }).catch(() => {
            ws.send(JSON.stringify({ type: "cmd-result", cmd: "shutdownSession", progress: "end", result: "Shutdown failed" }));
        });
        
    }

    async createAnnotationLevels(ws, msg) {
        //emudb-create-annotlevels
        let envVars = [];
        
        for(let key in msg.data.form.emuDb.annotLevels) {
            let env = [];
            let annotLevel = msg.data.form.emuDb.annotLevels[key];
            env.push("ANNOT_LEVEL_DEF_NAME="+annotLevel.name);
            env.push("ANNOT_LEVEL_DEF_TYPE="+annotLevel.type);
            await session.runCommand(["/usr/local/bin/node", "/container-agent/main.js", "emudb-create-annotlevels"], env.concat(envVars));
        }

        ws.send(JSON.stringify({ type: "cmd-result", cmd: "createAnnotationLevels", progress: "done" }));
    }

    async createAnnotationLevelLinks(ws, msg) {
         //emudb-create-annotlevellinks
         for(let key in msg.data.form.emuDb.annotLevelLinks) {
             let env = [];
             let annotLevelLink = msg.data.form.emuDb.annotLevelLinks[key];
             env.push("ANNOT_LEVEL_LINK_SUPER="+annotLevelLink.superLevel);
             env.push("ANNOT_LEVEL_LINK_SUB="+annotLevelLink.subLevel);
             env.push("ANNOT_LEVEL_LINK_DEF_TYPE="+annotLevelLink.type);
             await session.runCommand(["/usr/local/bin/node", "/container-agent/main.js", "emudb-create-annotlevellink"], env.concat(envVars));
         }

         ws.send(JSON.stringify({ type: "cmd-result", cmd: "createAnnotationLevelLinks", progress: "done" }));
    }

    async createEmuDbDefaultPerspectives(ws, msg) {
        let env = [];
        env.push("ANNOT_LEVELS="+Buffer.from(JSON.stringify(msg.data.form.emuDb.annotLevels)).toString('base64'));
        //emudb-add-default-perspectives
        
        await session.runCommand(["/usr/local/bin/node", "/container-agent/main.js", "emudb-add-default-perspectives"], env.concat(envVars));

        ws.send(JSON.stringify({ type: "cmd-result", cmd: "createEmuDb", progress: "done" }));
    }

    async setEmuDbLevelCanvasesOrder(ws, msg) {
        //emudb-setlevelcanvasesorder
        await session.runCommand(["/usr/local/bin/node", "/container-agent/main.js", "emudb-setlevelcanvasesorder"], env.concat(envVars));

        ws.send(JSON.stringify({ type: "cmd-result", cmd: "createEmuDb", progress: "done" }));
    }
    
    async setEmuDbTrackDefinitions(ws, msg) {
        //emudb-track-definitions (reindeer)
        ws.send(JSON.stringify({ type: "cmd-result", cmd: "createEmuDb", progress: "12", result: "Adding track definitions" }));
        await session.runCommand(["/usr/local/bin/node", "/container-agent/main.js", "emudb-track-definitions"], env.concat(envVars));
    }

    async setEmuDbSignalCanvasesOrder(ws, msg) {
        //emudb-setsignalcanvasesorder
        ws.send(JSON.stringify({ type: "cmd-result", cmd: "createEmuDb", progress: "13", result: "Setting signal canvases order" }));
        await session.runCommand(["/usr/local/bin/node", "/container-agent/main.js", "emudb-setsignalcanvasesorder"], env.concat(envVars));
    }

    async validateInviteCode(ws, msg, userInfo) {
        let db = await this.connectToMongo("visp");
        let inviteCodesCollection = db.collection("invite_codes");
        let inviteCodeObject = await inviteCodesCollection.findOne({ code: msg.data.code, used: false });

        if(inviteCodeObject) {
            let userCollection = db.collection("users");

            if(userInfo == null) {
                this.app.addLog("Session data was null when trying to validate invite code.", "error");
                ws.send(JSON.stringify({ type: "cmd-result", cmd: "validateInviteCode", result: false, requestId: msg.requestId }));
                return;
            }
            //check that the user is not already in the database
            let user = await userCollection.findOne({ username: userInfo.username, loginAllowed: true });
            if(user) {
                this.app.addLog("User "+user.username+" tried to use an invite code, but user is already in the database and authorized.", "warning");
                ws.send(JSON.stringify({ type: "cmd-result", cmd: "validateInviteCode", result: false, requestId: msg.requestId }));
                return;
            }
            userCollection.updateOne({ username: userInfo.username }, { $set: { loginAllowed: true } });

            inviteCodeObject.projectIds.forEach((projectId) => {
                let projectCollection = db.collection("projects");
                projectCollection.updateOne({ id: projectId }, { $push: { members: { username: userInfo.username, role: "member" } } });
            });

            //mark the code as used
            inviteCodesCollection.updateOne({ code: msg.data.code }, { $set: { used: true, usedDate: new Date() } });

            this.app.addLog("User "+userInfo.username+" entered a valid invite code and was added to database", "info");
            ws.send(JSON.stringify({ type: "cmd-result", cmd: "validateInviteCode", result: true, requestId: msg.requestId }));
        }
        else {
            this.app.addLog("Invalid invite code "+msg.data.code+", user eppn: "+userInfo.eppn, "info");
            ws.send(JSON.stringify({ type: "cmd-result", cmd: "validateInviteCode", result: false, requestId: msg.requestId }));
        }
    }

    async generateInviteCode(ws, msg) {
        let user = this.getUserSessionBySocket(ws);

        let inviteCode = nanoid.nanoid();
        //insert the invite code into the mongodb collection "invite_codes"
        let db = await this.connectToMongo("visp");
        let collection = db.collection("invite_codes");
        await collection.insertOne({ 
            code: inviteCode, 
            projectIds: msg.projectIds, 
            used: false, 
            role: "transcriber",
            createdBy: user.eppn,
            created: new Date() 
        });
        ws.send(JSON.stringify({ type: "cmd-result", cmd: "generateInviteCode", result: inviteCode, requestId: msg.requestId }));
    }

    async updateInviteCodes(ws, msg) {
        for(let key in msg.data.inviteCodes) {
            /*
            if you're thinking it's stupid to re-connect to the db for each iteration here, i am completely with you, but it doesn't work if I don't - hear me out
            I can't explain it, but if I put the connection on top of the loop it will fail on the second iteration, no idea why
            */
            let db = await this.connectToMongo("visp");
            let collection = db.collection("invite_codes");

            let inviteCode = msg.data.inviteCodes[key];
            await collection.updateOne({ code: inviteCode.code }, { $set: { projectIds: inviteCode.projectIds, role: inviteCode.role } });
        }
        ws.send(JSON.stringify({ type: "cmd-result", cmd: "updateInviteCodes", result: "OK", requestId: msg.requestId }));
    }

    async getInviteCodesByUser(ws, msg) {
        let user = this.getUserSessionBySocket(ws);

        let db = await this.connectToMongo("visp");
        let collection = db.collection("invite_codes");
        let inviteCodes = await collection.find({ createdBy: user.eppn, used: false }).toArray();
        ws.send(JSON.stringify({ type: "cmd-result", cmd: "getInviteCodesByUser", result: inviteCodes, requestId: msg.requestId }));
    }

    async deleteInviteCode(ws, msg) {
        let db = await this.connectToMongo("visp");
        let collection = db.collection("invite_codes");
        await collection.deleteOne({ code: msg.data.code });
        ws.send(JSON.stringify({ type: "cmd-result", cmd: "deleteInviteCode", result: "OK", requestId: msg.requestId }));
    }

    async createEmuDb(ws, msg) {
        const session = this.app.sessMan.getSessionByCode(msg.appSession);
        
        let envVars = [
            //"PROJECT_PATH=/home/project-setup",
            "PROJECT_PATH=/home/rstudio/project",
            //"UPLOAD_PATH=/home/uploads",
            "UPLOAD_PATH=/unimported_audio",
            "EMUDB_SESSIONS=[]"
        ];

        await session.runCommand(["/usr/local/bin/node", "/container-agent/main.js", "emudb-create"], envVars);

        ws.send(JSON.stringify({ type: "cmd-result", cmd: "createEmuDb", progress: "done" }));
    }

    async fetchSprSession(sessionId) {
        //fetch from mongo
        let db = await this.connectToMongo("wsrng");
        const sessionsCollection = db.collection("sessions");
        const sprSession = await sessionsCollection.findOne({ sessionId: sessionId });
        return sprSession;
    }

    async fetchSprScript(scriptId) {
         //fetch from mongo
         let db = await this.connectToMongo("wsrng");
         const sessionsCollection = db.collection("scripts");
         const sprScript = await sessionsCollection.findOne({ scriptId: scriptId });
         return sprScript;
    }

    async fetchSprScriptBySessionId(sessionId) {
        let sprSession = await this.fetchSprSession(sessionId);
        let sprScript = null;
        if(sprSession) {
            sprScript = await this.fetchSprScript(sprSession.script);
        }
        return sprScript;
    }

    async receiveFileUpload(ws, msg) {
        let userSession = this.getUserSessionBySocket(ws);
        const unimportedAudioPath = "/unimported_audio/"+userSession.id;
        let path = unimportedAudioPath+"/"+msg.data.projectId+"/"+msg.data.sessionName;
        let fileBinaryData = Buffer.from(msg.data.file, 'base64');
        let mkdirRes = await fs.promises.mkdir(path, { recursive: true });
        
        let writeRes = await fs.promises.writeFile(path+"/"+msg.data.fileName, fileBinaryData);
        this.app.addLog("Wrote file "+path);
        
        //let container = this.getSessionByCode(msg.appSession);
        /*
        container.runCommand("mkdir -p "+unimportedAudioPath+"/"+msg.data.sessionName);
        container.container.fs.put('./file.tar', {
            path: 'root'
        });
        */
    }

    slugify(inputString) {
        inputString = inputString.trim();
        const replacements = {
            '@': '_at_',
            '.': '_dot_',
            ' ': '_',
        };
    
        return inputString.replace(/[.@\s]/g, match => replacements[match]);
    }

    async copyDirectory(sourceDir, targetDir) {
        try {
            await fs.copy(sourceDir, targetDir, {
                preserveTimestamps: true
            });
            this.app.addLog('Directory copied successfully.');
            return true;
        } catch (error) {
            this.app.addLog('Error copying directory:'+error, "error");
            return false;
        }
    }

    async setPermissionsRecursive(directoryPath, mode) {
        try {
            // Set permissions for the directory itself
            await fs.chmod(directoryPath, mode);
    
            // Get the list of items (files and subdirectories) in the directory
            const items = await fs.readdir(directoryPath);
    
            // Iterate through each item
            for (const item of items) {
                const itemPath = path.join(directoryPath, item);
                const stats = await fs.stat(itemPath);
    
                if (stats.isDirectory()) {
                    // If the item is a subdirectory, recursively set permissions
                    await setPermissionsRecursive(itemPath, mode);
                } else {
                    // Set permissions for individual files
                    await fs.chmod(itemPath, mode);
                }
            }
    
            console.log(`Permissions set for ${directoryPath}`);
        } catch (error) {
            console.error(`Error setting permissions:`, error);
        }
    }

    async setOwnershipRecursive(directoryPath, targetUID, targetGID) {
        try {
            // Set ownership for the directory itself
            await fs.chown(directoryPath, targetUID, targetGID);
    
            // Get the list of items (files and subdirectories) in the directory
            const items = await fs.readdir(directoryPath);
    
            // Iterate through each item
            for (const item of items) {
                const itemPath = path.join(directoryPath, item);
                const stats = await fs.stat(itemPath);
    
                if (stats.isDirectory()) {
                    // If the item is a subdirectory, recursively set ownership
                    await this.setOwnershipRecursive(itemPath, targetUID, targetGID);
                } else {
                    // Set ownership for individual files
                    await fs.chown(itemPath, targetUID, targetGID);
                }
            }
    
            //console.log(`Ownership set for ${directoryPath}`);
        } catch (error) {
            console.error(`Error setting ownership:`, error);
        }
    }

    async getProjectById(projectId) {
        const Project = this.mongoose.model('Project');
    
        // Validate input
        if (!projectId) {
            throw new Error("Invalid projectId provided.");
        }
    
        try {
            // Fetch the project with improved performance
            let project = await Project.findOne({ id: projectId });
    
            if (!project) {
                throw new Error(`Project with id "${projectId}" not found.`);
            }
    
            return project;
        } catch (error) {
            console.error(`Error in getProjectById: ${error.message}`);
            throw error; // Rethrow for upstream handling
        }
    }
    
    async getSessionById(projectId, sessionId) {
        const Project = this.mongoose.model('Project');
    
        try {
            // Query the project and use $elemMatch to fetch the matching session
            let project = await Project.findOne(
                { id: projectId },
                { sessions: { $elemMatch: { id: sessionId } } }
            );
    
            // Safely check if project and session exist
            if (!project || !project.sessions || project.sessions.length === 0) {
                throw new Error(`Session with id "${sessionId}" not found in project "${projectId}".`);
            }
    
            let session = project.sessions[0]; // Retrieve the matched session
            return session;
    
        } catch (error) {
            this.app.addLog(error.message, "error");
            throw error; // Re-throw the error for upstream handling
        }
    }

    async downloadBundle(ws, user, msg) {
        let projectId = msg.data.projectId;
        let sessionId = msg.data.sessionId;
        let fileName = msg.data.fileName;
    
        let project = await this.getProjectById(projectId);
        let session = await this.getSessionById(projectId, sessionId);
    
        if (!project || !session) {
            ws.send(JSON.stringify({ type: "cmd-result", cmd: "downloadBundle", progress: "end", result: false, message: "Could not find project or session", requestId: msg.requestId }));
            return;
        }
    
        let fileBaseName = path.basename(fileName, path.extname(fileName));
        let repoBundlePath = "/repositories/" + project.id + "/Data/VISP_emuDB/" + session.name + "_ses/" + fileBaseName + "_bndl";
        this.app.addLog("Downloading bundle directory " + repoBundlePath, "debug");
    
        // Check that the bundle directory exists
        if (!fs.existsSync(repoBundlePath)) {
            this.app.addLog("Trying to download bundle directory " + repoBundlePath + ", but it does not exist", "error");
            ws.send(JSON.stringify({ type: "cmd-result", cmd: "downloadBundle", progress: "end", result: false, message: "Bundle directory does not exist", requestId: msg.requestId }));
            return;
        }
    
        // Create an instance of AdmZip for in-memory zipping
        let zip = new AdmZip();
    
        // Add the directory to the zip
        zip.addLocalFolder(repoBundlePath);
    
        // Get the zip file data as a buffer (in-memory, no disk write)
        let zipBuffer = zip.toBuffer();
    
        // Send the zip file to the client as a base64 string
        ws.send(JSON.stringify({
            type: "cmd-result", cmd: "downloadBundle", progress: "end", result: true, message: "Success", requestId: msg.requestId,
            data: { fileName: fileBaseName + ".zip", file: zipBuffer.toString('base64') }
        }));
    }
    

    async deleteBundle(ws, user, msg) {
        let projectId = msg.data.projectId;
        let sessionId = msg.data.sessionId;
        let fileName = msg.data.fileName;

        let project = await this.getProjectById(projectId);
        let session = await this.getSessionById(projectId, sessionId);

        if(!project || !session) {
            ws.send(JSON.stringify({ type: "cmd-result", cmd: "deleteBundle", progress: "end", result: false, message: "Could not find project or session", requestId: msg.requestId }));
            return;
        }

        //check that this user is a project member and has the role 'admin'
        let userIsAdmin = project.members.find(m => m.username == user.username && m.role == "admin");
        if(!userIsAdmin) {
            ws.send(JSON.stringify({ type: "cmd-result", cmd: "deleteBundle", progress: "end", result: false, message: "User is not admin for this project", requestId: msg.requestId }));
            return;
        }
        
        //delete from both mongodb and repository path
        let fileBaseName = path.basename(fileName, path.extname(fileName));
        let repoBundlePath = "/repositories/"+project.id+"/Data/VISP_emuDB/"+session.name+"_ses/"+fileBaseName+"_bndl";
        this.app.addLog("Deleting bundle directory "+repoBundlePath, "debug");
        
        //check that the bundle directory exists
        if(!fs.existsSync(repoBundlePath)) {
            this.app.addLog("Trying to delete bundle directory "+repoBundlePath+", but it does not exist, continuing anyway", "warning");
        }
        
        if(!nativeSync(repoBundlePath)) {
            this.app.addLog("Could not delete file "+repoBundlePath, "error");
            ws.send(JSON.stringify({ type: "cmd-result", cmd: "deleteBundle", progress: "end", result: false, message: "Could not delete file "+repoBundlePath, requestId: msg.requestId }));
            return;
        }

        const Project = this.mongoose.model('Project');
        await Project.updateOne(
            { id: projectId, "sessions.id": sessionId },
            { $pull: { "sessions.$.files": { name: fileName } } }
        );

        ws.send(JSON.stringify({ type: "cmd-result", cmd: "deleteBundle", progress: "end", message: "Success", requestId: msg.requestId }));
    }

    async deleteProject(ws, user, msg) {
        let totalStepsNum = 3;
        let stepNum = 0;
        ws.send(JSON.stringify({ type: "cmd-result", cmd: "deleteProject", progress: (++stepNum)+"/"+totalStepsNum, message: "Initiating", result: true }));

        let project = msg.data.project;
        let repoPath = "/repositories/"+project.id;

        ws.send(JSON.stringify({ type: "cmd-result", cmd: "deleteProject", progress: (++stepNum)+"/"+totalStepsNum, message: "Deleting project from database", result: true }));
        const Project = this.mongoose.model('Project');
        await Project.deleteOne({ id: project.id });

        ws.send(JSON.stringify({ type: "cmd-result", cmd: "deleteProject", progress: (++stepNum)+"/"+totalStepsNum, message: "Deleting project from filesystem", result: true }));
        if(!nativeSync(repoPath)) {
            this.app.addLog("Could not delete project "+repoPath, "error");
        }
        ws.send(JSON.stringify({ type: "cmd-result", cmd: "deleteProject", progress: "end", message: "Project deleted", result: true }));
    }

    async createProject(ws, user, msg) {
        let totalStepsNum = 14;
        let stepNum = 0;
        let projectFormData = msg.project;
        let customAlphabet = nanoid.customAlphabet('1234567890abcdefghijklmnopqrstuvwxyz', 21); //this is just to avoid the possibility of getting a "-" as the first character, which is annoying when you wish to work with the directory in the terminal
        projectFormData.id = customAlphabet();
        /*
            example user:
            {
session-manager_1    |   _id: new ObjectId("64e71bdb16e4d351def68ca5"),
session-manager_1    |   id: 2,
session-manager_1    |   firstName: 'Test',
session-manager_1    |   lastName: 'User',
session-manager_1    |   email: 'testuser@example.com',
session-manager_1    |   username: 'testuser_at_example_dot_com',
session-manager_1    |   personalAccessToken: 'glpat-mzSUUgcxozyAuyxruMfx',
session-manager_1    |   eppn: 'testuser@example.com'
session-manager_1    | }
        */

        /*
        example msg:
        {
session-manager_1    |   "cmd": "createProject",
session-manager_1    |   "project": {
session-manager_1    |     "projectName": "Test 25",
session-manager_1    |     "docFiles": [],
session-manager_1    |     "standardDirectoryStructure": true,
session-manager_1    |     "createEmuDb": true,
session-manager_1    |     "emuDb": {
session-manager_1    |       "formContextId": "iBDtccdEjeP-y6x9a67Gi",
session-manager_1    |       "project": null,
session-manager_1    |       "sessions": [
session-manager_1    |         {
session-manager_1    |           "new": true,
session-manager_1    |           "deleted": false,
session-manager_1    |           "sessionId": "Xf2iDCUFhjz7Vw2-g9SLB",
session-manager_1    |           "name": "lkmlm",
session-manager_1    |           "speakerGender": null,
session-manager_1    |           "speakerAge": 35,
session-manager_1    |           "dataSource": "upload",
session-manager_1    |           "sessionScript": "Missing script",
session-manager_1    |           "files": [],
session-manager_1    |           "collapsed": false
session-manager_1    |         }
session-manager_1    |       ],
session-manager_1    |       "annotLevels": [
session-manager_1    |         {
session-manager_1    |           "name": "Word",
session-manager_1    |           "type": "ITEM"
session-manager_1    |         },
session-manager_1    |         {
session-manager_1    |           "name": "Phonetic",
session-manager_1    |           "type": "SEGMENT"
session-manager_1    |         }
session-manager_1    |       ],
session-manager_1    |       "annotLevelLinks": [
session-manager_1    |         {
session-manager_1    |           "superLevel": "Word",
session-manager_1    |           "subLevel": "Phonetic",
session-manager_1    |           "type": "ONE_TO_MANY"
session-manager_1    |         }
session-manager_1    |       ]
session-manager_1    |     }
session-manager_1    |   },
session-manager_1    |   "requestId": "aNlbDLXk9lCvWTaDqvyZS"
session-manager_1    | }
        */
        this.app.addLog("Creating project");

        ws.send(JSON.stringify({ requestId: msg.requestId, type: "cmd-result", cmd: "saveProject", progress: (++stepNum)+"/"+totalStepsNum, result: true, message: "Validating input" }));
        if(!this.validateProjectForm(projectFormData)) {
            return;
        }
        
        ws.send(JSON.stringify({ requestId: msg.requestId, type: "cmd-result", cmd: "saveProject", progress: (++stepNum)+"/"+totalStepsNum, result: true, message: "Initializing project directory" })); 
        if(!await this.initProjectDirectory(user, projectFormData)) {
            this.app.addLog("Failed initializing project directory", "warn");
        }

        ws.send(JSON.stringify({ requestId: msg.requestId, type: "cmd-result", cmd: "saveProject", progress: (++stepNum)+"/"+totalStepsNum, result: true, message: "Storing project in MongoDB" }));
        
        let mongoProject = await this.mongoose.model('Project').create({
            id: projectFormData.id,
            name: projectFormData.projectName,
            slug: this.slugify(projectFormData.projectName),
            sessions: [],
            annotationLevels: projectFormData.annotLevels,
            annotationLinks: projectFormData.annotLevelLinks,
            members: [{
                username: String(user.username),
                role: "admin"
            }],
            docs: projectFormData.docFiles
        });

        mongoProject.save();

        await this.saveSessionsMongo(projectFormData);

        //create a bundlelist for the user creating the project
        let bundles = [];
        projectFormData.sessions.forEach(session => {
            session.files.forEach(file => {
                let bundleName = file.name.replace(/\.[^/.]+$/, "");
                bundles.push({
                    comment: "",
                    fileName: file.name,
                    finishedEditing: session.sessionId,
                    name: bundleName,
                    session: session.name,
                });
            });
        });

        this._saveBundleLists(user.username, projectFormData.id, bundles)

        ws.send(JSON.stringify({ requestId: msg.requestId, type: "cmd-result", cmd: "saveProject", progress: (++stepNum)+"/"+totalStepsNum, result: true, message: "Building project directory" }));
        await this.saveProjectEmuDb(user, projectFormData, true, ws, msg);
        ws.send(JSON.stringify({ requestId: msg.requestId, type: "cmd-result", cmd: "saveProject", progress: "end", result: true, message: "Done" }));
    }

    async _saveBundleLists(username, projectId, bundles) {
        const BundleList = this.mongoose.model('BundleList');
        let bundleListResult = await BundleList.find({ owner: username, projectId: projectId });

        let bundleList = null;
        if(bundleListResult.length > 0) {
            //update
            bundleList = bundleListResult[0];
            bundleList.bundles = bundles;
        }
        else {
            //create
            bundleList = new BundleList({
                owner: username,
                projectId: projectId,
                bundles: bundles
            });
        }
        bundleList.save();
    }

    async saveProject(ws, user, msg) {

        if(!user || !user.privileges || user.privileges.createProjects != true) {
            this.app.addLog("User "+user.username+" tried to create a project, but is not authorized", "warning");
            ws.send(JSON.stringify({ requestId: msg.requestId, type: "cmd-result", cmd: "saveProject", message: "User not authorized to create projects", result: false, progress: "end" }));
            return;
        }

        let projectFormData = msg.project;

        //figure out if this is a new project or an existing one
        if(typeof projectFormData.id != "undefined" && projectFormData.id != null) {
            await this.updateProject(ws, user, msg);
        }
        else {
            await this.createProject(ws, user, msg);
        }
    }

    async updateProject(ws, user, msg) {
        let totalStepsNum = 14;
        let stepNum = 0;
        let projectFormData = msg.project;

        this.app.addLog("Updating project");
        if(!this.validateProjectForm(projectFormData)) {
            this.app.addLog("Project form validation failed", "error");
            return;
        }

        ws.send(JSON.stringify({ requestId: msg.requestId, type: "cmd-result", cmd: "saveProject", progress: (++stepNum)+"/"+totalStepsNum, result: "Updating database" }));
        await this.saveAnnotationLevelsMongo(projectFormData);
        await this.saveSessionsMongo(projectFormData);
        //await this.saveSprSession(projectFormData);
        
        ws.send(JSON.stringify({ requestId: msg.requestId, type: "cmd-result", cmd: "saveProject", progress: (++stepNum)+"/"+totalStepsNum, result: "Building project directory" }));
        await this.saveProjectEmuDb(user, projectFormData, false, ws, msg);
        ws.send(JSON.stringify({ requestId: msg.requestId, type: "cmd-result", cmd: "saveProject", progress: "end", result: "Done" }));
    }

    async saveSprSession(projectFormData) {
        //save any spr session attributes (currently only sprSessionSealed) in the wsrng database
        this.app.addLog("Saving SPR session data to MongoDB");
        let db = await this.connectToMongo("wsrng");
        let collection = db.collection("sessions");
        for(let formSession of projectFormData.sessions) {
            let sprSession = await collection.findOne({ sessionId: formSession.sessionId });
            if(sprSession) {
                console.log("Updating SPR session "+formSession.sessionId+" in MongoDB")
                await collection.updateOne({ sessionId: formSession.sessionId }, {
                    $set: {
                        sealed: formSession.sprSessionSealed
                    }
                });
            }
        }
    }

    async saveAnnotationLevelsMongo(projectFormData) {
        this.app.addLog("Saving annotation levels to MongoDB");
        let mongoProject = await this.mongoose.model('Project').findOne({ id: projectFormData.id });
        if(!mongoProject) {
            this.app.addLog("Could not find project in MongoDB", "error");
            return;
        }
        mongoProject.annotationLevels = projectFormData.annotLevels;
        mongoProject.annotationLinks = projectFormData.annotLevelLinks;
        mongoProject.markModified('annotationLevels');
        mongoProject.markModified('annotationLinks');
        await mongoProject.save();
    }

    async saveSessionsMongo(projectFormData) {
        this.app.addLog("Saving sessions to MongoDB");
        let mongoProject = await this.mongoose.model('Project').findOne({ id: projectFormData.id });

        for (let formSession of projectFormData.sessions) {

            if(formSession.deleted) {
                this.app.addLog("Deleting session with id "+formSession.id+" from mongo project", "debug");

                mongoProject.sessions = mongoProject.sessions.filter(session => session.id !== formSession.id);
                mongoProject.markModified('sessions');

                this.sprSessionDelete(formSession.id);

                continue;
            }

            if(formSession.new) {
                this.app.addLog("Adding session "+formSession.name+" to mongo project", "debug");
                //create new session in mongo
                mongoProject.sessions.push({
                    id: formSession.id,
                    name: formSession.name,
                    speakerGender: formSession.speakerGender,
                    speakerAge: formSession.speakerAge,
                    dataSource: formSession.dataSource,
                    sessionScript: formSession.sessionScript,
                    sessionId: formSession.sessionId,
                    files: formSession.files
                });

                this.sprSessionCreate(projectFormData.id, formSession);
                continue;
            }

            this.app.addLog("Updating session "+formSession.id+" in mongo project", "debug");

            //update existing session in mongo
            let mongoSession = mongoProject.sessions.find(session => session.id == formSession.id);
            mongoSession.speakerGender = formSession.speakerGender;
            mongoSession.speakerAge = formSession.speakerAge;
            mongoSession.dataSource = formSession.dataSource;
            mongoSession.sessionScript = formSession.sessionScript;
            mongoSession.sessionId = formSession.sessionId;
            
            mongoSession.files = formSession.files.map(fileMeta => ({
                name: fileMeta.name,
                size: fileMeta.size,
                type: fileMeta.type,
            }));

            if(formSession.dataSource == 'record') {
                this.sprSessionUpdate(formSession);
            }
            
        }
        mongoProject.markModified('sessions');
        await mongoProject.save();
    }

    async sprSessionCreate(projectId, session) {
        this.app.addLog("Creating SPR session "+session.id);
        let db = await this.connectToMongo("wsrng");
        let collection = db.collection("sessions");
        collection.insertOne({
            project: projectId,
            sessionId: session.id,
            script: session.sessionScript,
            debugMode: false,
            type: 'NORM',
            status: 'CREATED',
            sealed: false,
            loadedDate: new Date().toISOString(), //format: '2022-12-16T14:57:04.651Z'
        });
    }

    async sprSessionUpdate(session) {
        if(session.dataSource != 'record') {
            return;
        }
        this.app.addLog("Updating SPR session "+session.id);
        let db = await this.connectToMongo("wsrng");
        let collection = db.collection("sessions");
        collection.updateOne({ sessionId: session.id }, {
            $set: {
                script: session.sessionScript,
                sealed: session.sprSessionSealed == 'true' ? true : false
            },
        });
    }

    async sprSessionDelete(sessionId) {
        this.app.addLog("Deleting SPR session "+sessionId);
        let db = await this.connectToMongo("wsrng");
        let collection = db.collection("sessions");
        collection.deleteOne({ sessionId: sessionId });
    }

    async convertAllInDirectoryToWav(projectId, dir) {
        let processedFiles = [];
        dir = path.join(dir, "emudb-sessions");
        this.app.addLog("Converting all files in " + dir + " to WAV");
    
        //does the directory exist?
        if (!fs.existsSync(dir)) {
            this.app.addLog("Directory " + dir + " does not exist, aborting", "info");
            return processedFiles;
        }

        // Scan the parent directory for session directories
        let sessionDirs = fs.readdirSync(dir);
    
        for (const sessionDir of sessionDirs) {
            if (sessionDir === "." || sessionDir === "..") {
                continue;
            }
    
            const sessionDirPath = path.join(dir, sessionDir);
            const sessionDirFiles = fs.readdirSync(sessionDirPath);
    
            for (const file of sessionDirFiles) {
                if (file === "." || file === "..") {
                    continue;
                }
    
                const filePath = path.join(sessionDirPath, file);
                const fileExt = path.extname(filePath);
    
                if (fileExt.toLowerCase() !== ".wav") {
                    const newFilePath = path.join(sessionDirPath, path.basename(file, fileExt) + ".wav");

                    let runResult = {
                        newFilePath: newFilePath,
                        oldFilePath: filePath,
                        result: "",
                        message: ""
                    };

                    //check that there isn't already a file with the new name
                    if(fs.existsSync(newFilePath)) {
                        //if there is, we need to delete this entire file/bundle from the session since we can't have non-wav files in the project
                        this.app.addLog("File "+newFilePath+" already exists, not converting", "warning");

                        //delete the original file
                        fs.unlinkSync(filePath);
                        runResult.result = "warning";
                        runResult.message = "Deleted file "+filePath+" since a file with the same name already exists in the session.";
                        continue;
                    }

                    this.app.addLog(`Converting ${filePath} to ${newFilePath}`);

                    try {
                        execSync(
                            `ffmpeg -i "${filePath}" -acodec pcm_s16le -ac 1 -ar 16000 "${newFilePath}"`,
                            { stdio: "pipe" }
                        );
                        this.app.addLog(`Successfully converted ${filePath} to ${newFilePath}`);
    
                        let fileName = path.basename(filePath);

                        //the second parent directory in the "dir" path is the project id
                        //so it's <username>/<project_id>/emudb-sessions/<session_id>
                        await this.updateFileMetaDataOfConvertedFile(newFilePath, projectId, sessionDir, fileName);
                        
                        //delete the original file
                        fs.unlinkSync(filePath);

                        runResult.result = "info";
                        processedFiles.push(runResult);

                    } catch (error) {
                        this.app.addLog(`Failed converting ${filePath} to WAV: ${error.message}`, "error");
                        runResult.result = "error";
                        runResult.message = `Failed converting ${filePath} to WAV: ${error.message}`;
                        processedFiles.push(runResult);
                    }
                }
            }
        }

        return processedFiles;
    }

    async updateFileMetaDataOfConvertedFile(newFilePath, projectId, sessionId, fileName) {
        // Fetch the project by its ID
        let project = await this.getProjectById(projectId);

        // Find the specific session by sessionId
        let session = project.sessions.find(s => s.id === sessionId);

        // Ensure the session exists
        if (!session) {
            throw new Error(`Session with ID ${sessionId} not found.`);
        }

        // Find the specific file by fileName
        let file = session.files.find(f => f.name === fileName);

        // Ensure the file exists
        if (!file) {
            throw new Error(`File with name ${fileName} not found in session ${sessionId}.`);
        }

        // Update the file name to have a ".wav" extension
        file.name = fileName.replace(/\.[^/.]+$/, ".wav");
        file.size = fs.statSync(newFilePath).size;
        file.type = "audio/wav";

        // Save the updated project
        project.markModified('sessions');
        await project.save();
    }
    

    /**
     * This method will spin up a container, mount the repo volume and create or update the EmuDB directory structure and files
     * 
     * @param {*} ws 
     * @param {*} user 
     * @param {*} projectFormData 
     */
    async saveProjectEmuDb(user, projectFormData, newProject = true, ws = null, msg = null) {
        let totalStepsNum = 18;
        let stepNum = 2;

        if(typeof projectFormData.id == "undefined") {
            this.app.addLog("No project id specified in saveProjectEmuDb, aborting", "error");
            if(ws && msg) {
                ws.send(JSON.stringify({ requestId: msg.requestId, type: "cmd-result", cmd: msg.cmd, progress: "end", result: false, message: "" }));
            }
            return;
        }

        //Spawning container
        let context = projectFormData.formContextId;
        //this is the path from within this container
        let uploadsSrcDirLocal = "/tmp/uploads/"+user.username+"/"+context;
        //this is the path from the os root, which is what we will pass as a volume argument to the operations container
        let uploadsSrcDir = this.app.absRootPath+"/mounts/apache/apache/uploads/"+user.username+"/"+context;
        if(!fs.existsSync(uploadsSrcDirLocal)) {
            this.app.addLog("Directory "+uploadsSrcDir+" ("+uploadsSrcDirLocal+") does not exist, creating it");
            try {
                fs.mkdirSync(uploadsSrcDirLocal, {
                    recursive: true
                });

                if(!fs.existsSync(uploadsSrcDirLocal)) {
                    this.app.addLog("Failed creating directory (1) "+uploadsSrcDir+".", "error");
                }
            }
            catch(error) {
                this.app.addLog("Failed creating directory (2) "+uploadsSrcDir+". "+error.toString(), "error");
            }
        }

        if(ws && msg) {
            ws.send(JSON.stringify({ requestId: msg.requestId, type: "cmd-result", cmd: msg.cmd, progress: (++stepNum)+"/"+totalStepsNum, result: true, message: "Converting audio files to WAV" }));
        }
        const runResults = await this.convertAllInDirectoryToWav(projectFormData.id, uploadsSrcDirLocal);


        if(ws && msg) {
            ws.send(JSON.stringify({ requestId: msg.requestId, type: "cmd-result", cmd: msg.cmd, progress: (++stepNum)+"/"+totalStepsNum, result: true, message: "Preparing EMU-DB operations" }));
        }
        //createSession
        const gitRepoVolume = {
            source: this.app.absRootPath+"/mounts/repositories/"+projectFormData.id,
            target: "/home/rstudio/project"
        };
        const uploadsVolume = {
            source: uploadsSrcDir,
            target: "/home/uploads"
        }
        const projectDirectoryTemplateVolume = {
            source: this.app.absRootPath+"/docker/session-manager/project-template-structure",
            target: "/project-template-structure"
        }
        let volumes = [
            gitRepoVolume,
            uploadsVolume,
            projectDirectoryTemplateVolume, //don't think I actually need to mount this since the template is already copied over
        ];

        let mongoProject = await this.mongoose.model('Project').findOne({ id: projectFormData.id });
        
        const session = this.app.sessMan.createSession(user, mongoProject, 'operations', volumes);
        await session.createContainer();
        
        //Define env vars for the container-agent to use for further commands
        let envVars = [
            "PROJECT_PATH=/home/rstudio/project", //used to be /home/project-setup
            "UPLOAD_PATH=/home/uploads",
            "BUNDLE_LIST_NAME="+user.username
        ];
        
        //Create EMUDB_SESSIONS env var
        //Make sure that age is a number, not a string
        for(let sessionKey in projectFormData.sessions) {
            projectFormData.sessions[sessionKey].speakerAge = parseInt(projectFormData.sessions[sessionKey].speakerAge);

            //name of the session could be empty is this is an existing session, if so, just fetch it form the db
            if(typeof projectFormData.sessions[sessionKey].name == "undefined") {
                mongoProject.sessions.forEach(sess => {
                    if(projectFormData.sessions[sessionKey].id == sess.id) {
                        projectFormData.sessions[sessionKey].name = sess.name;
                    }
                })
            }
            
            if(!projectFormData.sessions[sessionKey].deleted) {
                projectFormData.sessions[sessionKey].slug = this.slugify(projectFormData.sessions[sessionKey].name);
            }
        }
        let sessionsEncoded = Buffer.from(JSON.stringify(projectFormData.sessions)).toString('base64');
        envVars.push("EMUDB_SESSIONS="+sessionsEncoded);

        let resultJson = null;
        let result = null;
        if(newProject) {
            //createEmuDb
            if(ws && msg) {
                ws.send(JSON.stringify({ requestId: msg.requestId, type: "cmd-result", cmd: msg.cmd, progress: (++stepNum)+"/"+totalStepsNum, result: true, message: "Creating EMU-DB" }));
            }
            resultJson = await session.runCommand(["/usr/local/bin/node", "/container-agent/main.js", "emudb-create"], envVars);
            result = JSON.parse(resultJson);
            if(!result || result.code != 200) {
                this.app.addLog("Failed creating emuDB (code "+result.code+"): stdout: "+result.body.stdout+". stderr: "+result.body.stderr, "error");
                await this.app.sessMan.deleteSession(session.accessCode);
                return;
            }
        }
        else {
            if(ws && msg) {
                ws.send(JSON.stringify({ requestId: msg.requestId, type: "cmd-result", cmd: msg.cmd, progress: (++stepNum)+"/"+totalStepsNum, result: true, message: "Skipping creation of EMU-DB" }));
            }
        }

        //emudb-create-sessions
        if(ws && msg) {
            ws.send(JSON.stringify({ requestId: msg.requestId, type: "cmd-result", cmd: msg.cmd, progress: (++stepNum)+"/"+totalStepsNum, result: true, message: "Creating EMU-DB sessions" }));
        }
        resultJson = await session.runCommand(["/usr/local/bin/node", "/container-agent/main.js", "emudb-create-sessions"], envVars);
        result = JSON.parse(resultJson);
        if(!result || result.code != 200) {
            this.app.addLog("Failed creating emuDB (code "+result.code+"): stdout: "+result.body.stdout+". stderr: "+result.body.stderr, "error");
            await this.app.sessMan.deleteSession(session.accessCode);
            return;
        }
        
        //emudb-create-bundlelist
        if(ws && msg) {
            ws.send(JSON.stringify({ requestId: msg.requestId, type: "cmd-result", cmd: msg.cmd, progress: (++stepNum)+"/"+totalStepsNum, result: true, message: "Creating EMU-DB bundlelists" }));
        }
        resultJson = await session.runCommand(["/usr/local/bin/node", "/container-agent/main.js", "emudb-create-bundlelist"], envVars);
        result = JSON.parse(resultJson);
        if(!result || result.code != 200) {
            this.app.addLog("Failed creating emuDB (code "+result.code+"): stdout: "+result.body.stdout+". stderr: "+result.body.stderr, "error");
            await this.app.sessMan.deleteSession(session.accessCode);
            return;
        }

        //insert bundle list into mongo
        let mongoBundleList = await this.mongoose.model('BundleList')
        mongoBundleList = {
            owner: user.username,
            projectId: projectFormData.id,
            bundles: []
        };
        //mongoBundleList.save();

        //read VISP_DBconfig.json
        if(ws && msg) {
            ws.send(JSON.stringify({ requestId: msg.requestId, type: "cmd-result", cmd: msg.cmd, progress: (++stepNum)+"/"+totalStepsNum, result: true, message: "Reading EMU-DB config" }));
        }
        resultJson = await session.runCommand(["/usr/local/bin/node", "/container-agent/main.js", "emudb-read-dbconfig"], envVars);
        let dbConfig = JSON.parse(resultJson).body;

        dbConfig.ssffTrackDefinitions;
        dbConfig.levelDefinitions;
        /*
        levelDefinition: {
            name: "Word",
            type: "ITEM",
            attributeDefinitions: [Array]
        }
        */
        dbConfig.linkDefinitions;
        /*
        linkDefinition: {
            superlevelName: "Word",
            sublevelName: "Phonetic",
            type: "ONE_TO_MANY"
        }
        */

        //emudb-create-annotlevels
        if(ws && msg) {
            ws.send(JSON.stringify({ requestId: msg.requestId, type: "cmd-result", cmd: msg.cmd, progress: (++stepNum)+"/"+totalStepsNum, result: true, message: "Setting annotation levels" }));
        }
        for(let key in projectFormData.annotLevels) {
            //check if this annot level already exists in the dbConfig
            let annotLevel = projectFormData.annotLevels[key];
            let levelExists = dbConfig.levelDefinitions.find(l => l.name == annotLevel.name);
            if(levelExists) {
                this.app.addLog("Level "+annotLevel.name+" already exists in the dbConfig, skipping creation", "debug");
                continue;
            }

            let env = [];
            env.push("ANNOT_LEVEL_DEF_NAME="+annotLevel.name);
            env.push("ANNOT_LEVEL_DEF_TYPE="+annotLevel.type);
            resultJson = await session.runCommand(["/usr/local/bin/node", "/container-agent/main.js", "emudb-create-annotlevel"], env.concat(envVars));
            result = JSON.parse(resultJson);
            if(!result || result.code != 200) {
                this.app.addLog("Failed creating emuDB (code "+result.code+"): stdout: "+result.body.stdout+". stderr: "+result.body.stderr, "error");
                await this.app.sessMan.deleteSession(session.accessCode);
                return;
            }
        }

        //now delete all annot levels that exists in the dbConfig, but not in the projectFormData.annotLevels
        for(let key in dbConfig.levelDefinitions) {
            let level = dbConfig.levelDefinitions[key];

            let levelExists = projectFormData.annotLevels.find(l => l.name == level.name);
            if(!levelExists) {
                this.app.addLog("Level "+level.name+" exists in the dbConfig, but not in the projectFormData.annotLevels, deleting", "debug");
                let env = [];
                env.push("ANNOT_LEVEL_DEF_NAME="+level.name);
                resultJson = await session.runCommand(["/usr/local/bin/node", "/container-agent/main.js", "emudb-remove-annotlevel"], env.concat(envVars));
                result = JSON.parse(resultJson);
                if(!result || result.code != 200) {
                    if(ws && msg) {
                        ws.send(JSON.stringify({ requestId: msg.requestId, type: "cmd-result", cmd: msg.cmd, progress: "end", result: false, message: "Failed removing annoations levels" }));
                    }
                    this.app.addLog("Failed creating emuDB (code "+result.code+"): stdout: "+result.body.stdout+". stderr: "+result.body.stderr, "error");
                    await this.app.sessMan.deleteSession(session.accessCode);
                    return;
                }
            }
        }

        //emudb-create-annotlevellinks
        if(ws && msg) {
            ws.send(JSON.stringify({ requestId: msg.requestId, type: "cmd-result", cmd: msg.cmd, progress: (++stepNum)+"/"+totalStepsNum, result: true, message: "Setting annotation level links" }));
        }
        for(let key in projectFormData.annotLevelLinks) {
            let env = [];
            let annotLevelLink = projectFormData.annotLevelLinks[key];

            //check if this annot level link already exists in the dbConfig
            let linkExists = dbConfig.linkDefinitions.find(l => l.superlevelName == annotLevelLink.superLevel && l.sublevelName == annotLevelLink.subLevel);
            if(linkExists) {
                this.app.addLog("Link "+annotLevelLink.superLevel+" -> "+annotLevelLink.subLevel+" already exists in the dbConfig, skipping creation", "debug");
                continue;
            }

            env.push("ANNOT_LEVEL_LINK_SUPER="+annotLevelLink.superLevel);
            env.push("ANNOT_LEVEL_LINK_SUB="+annotLevelLink.subLevel);
            env.push("ANNOT_LEVEL_LINK_DEF_TYPE="+annotLevelLink.type);
            resultJson = await session.runCommand(["/usr/local/bin/node", "/container-agent/main.js", "emudb-create-annotlevellink"], env.concat(envVars));
            result = JSON.parse(resultJson);
            if(!result || result.code != 200) {
                if(ws && msg) {
                    ws.send(JSON.stringify({ requestId: msg.requestId, type: "cmd-result", cmd: msg.cmd, progress: "end", result: false, message: "Failed to create annotation level links" }));
                }
                this.app.addLog("Failed creating annotation level link (code "+result.code+"): stdout: "+result.body.stdout+". stderr: "+result.body.stderr, "error");
                await this.app.sessMan.deleteSession(session.accessCode);
                return;
            }
        }

        //now delete all annot level links that exists in the dbConfig, but not in the projectFormData.annotLevelLinks
        for(let key in dbConfig.linkDefinitions) {
            let link = dbConfig.linkDefinitions[key];

            let linkExists = projectFormData.annotLevelLinks.find(l => l.superLevel == link.superlevelName && l.subLevel == link.sublevelName);
            if(!linkExists) {
                this.app.addLog("Link "+link.superlevelName+" -> "+link.sublevelName+" exists in the dbConfig, but not in the projectFormData.annotLevelLinks, deleting", "debug");
                let env = [];
                env.push("ANNOT_LEVEL_LINK_SUPER="+link.superlevelName);
                env.push("ANNOT_LEVEL_LINK_SUB="+link.sublevelName);
                
                resultJson = await session.runCommand(["/usr/local/bin/node", "/container-agent/main.js", "emudb-remove-annotlevellink"], env.concat(envVars));
                result = JSON.parse(resultJson);
                if(!result || result.code != 200) {
                    if(ws && msg) {
                        ws.send(JSON.stringify({ requestId: msg.requestId, type: "cmd-result", cmd: msg.cmd, progress: "end", result: false, message: "Failed to remove annoation level link in EMU-DB" }));
                    }
                    this.app.addLog("Failed removing annotation level link (code "+result.code+"): stdout: "+result.body.stdout+". stderr: "+result.body.stderr, "error");
                    await this.app.sessMan.deleteSession(session.accessCode);
                    return;
                }
            }
        }
        
        let env = [];
        env.push("ANNOT_LEVELS="+Buffer.from(JSON.stringify(projectFormData.annotLevels)).toString('base64'));
        //emudb-add-default-perspectives
        if(ws && msg) {
            ws.send(JSON.stringify({ requestId: msg.requestId, type: "cmd-result", cmd: msg.cmd, progress: (++stepNum)+"/"+totalStepsNum, result: true, message: "Adding default perspectives" }));
        }
        resultJson = await session.runCommand(["/usr/local/bin/node", "/container-agent/main.js", "emudb-add-default-perspectives"], env.concat(envVars));
        result = JSON.parse(resultJson);
        if(!result || result.code != 200) {
            if(ws && msg) {
                ws.send(JSON.stringify({ requestId: msg.requestId, type: "cmd-result", cmd: msg.cmd, progress: "end", result: false, message: "Failed to add default perspectives" }));
            }
            this.app.addLog("Failed creating emuDB (code "+result.code+"): stdout: "+result.body.stdout+". stderr: "+result.body.stderr, "error");
            await this.app.sessMan.deleteSession(session.accessCode);
            return;
        }

        //emudb-setlevelcanvasesorder
        if(ws && msg) {
            ws.send(JSON.stringify({ requestId: msg.requestId, type: "cmd-result", cmd: msg.cmd, progress: (++stepNum)+"/"+totalStepsNum, result: true, message: "Setting level canvases order" }));
        }
        resultJson = await session.runCommand(["/usr/local/bin/node", "/container-agent/main.js", "emudb-setlevelcanvasesorder"], env.concat(envVars));
        result = JSON.parse(resultJson);
        if(!result || result.code != 200) {
            if(ws && msg) {
                ws.send(JSON.stringify({ requestId: msg.requestId, type: "cmd-result", cmd: msg.cmd, progress: "end", result: false, message: "Failed to set level canvases order" }));
            }
            this.app.addLog("Failed creating emuDB (code "+result.code+"): stdout: "+result.body.stdout+". stderr: "+result.body.stderr, "error");
            await this.app.sessMan.deleteSession(session.accessCode);
            return;
        }

        /*
        //emudb-ssff-track-definitions
        resultJson = await session.runCommand(["/usr/local/bin/node", "/container-agent/main.js", "emudb-ssff-track-definitions"], env.concat(envVars));
        result = JSON.parse(resultJson);
        if(result.code != 200) {
            this.app.addLog("Failed defining ssff tracks (code "+result.code+"): stdout: "+result.body.stdout+". stderr: "+result.body.stderr, "error");
            return;
        }
        */

        //emudb-track-definitions (reindeer)


        //if this project contains wav files that are beyond 1GB in size, we skip this step

        let largeFiles = [];
        let skipTrackDefinitionCreation = false;
        mongoProject.sessions.forEach(session => {
            session.files.forEach(file => {
                if(file.type == "audio/wav" && file.size > 1000000000) {
                    skipTrackDefinitionCreation = true;
                    largeFiles.push(file.name);
                }
            })
        });
        if(!skipTrackDefinitionCreation) {
            if(ws && msg) {
                ws.send(JSON.stringify({ requestId: msg.requestId, type: "cmd-result", cmd: msg.cmd, progress: (++stepNum)+"/"+totalStepsNum, result: true, message: "Creating track definitions" }));
            }
            resultJson = await session.runCommand(["/usr/local/bin/node", "/container-agent/main.js", "emudb-track-definitions"], env.concat(envVars));
            result = JSON.parse(resultJson);
            if(!result || result.code != 200) {
                if(ws && msg) {
                    ws.send(JSON.stringify({ requestId: msg.requestId, type: "cmd-result", cmd: msg.cmd, progress: "end", result: false, message: "Failed to create track definitions" }));
                }
                this.app.addLog("Failed creating emuDB (code "+result.code+"): stdout: "+result.body.stdout+". stderr: "+result.body.stderr, "error");
                await this.app.sessMan.deleteSession(session.accessCode);
                return;
            }
        }
        else {
            if(ws && msg) {
                ws.send(JSON.stringify({ requestId: msg.requestId, type: "cmd-result", cmd: msg.cmd, progress: (++stepNum)+"/"+totalStepsNum, result: true, message: "Skipping track definitions" }));
            }
            this.app.addLog("Skipping track definition creation since the following files are too large: "+largeFiles.join(", "), "warn");
        }

        //emudb-setsignalcanvasesorder
        if(ws && msg) {
            ws.send(JSON.stringify({ requestId: msg.requestId, type: "cmd-result", cmd: msg.cmd, progress: (++stepNum)+"/"+totalStepsNum, result: true, message: "Setting signal canvases order" }));
        }
        resultJson = await session.runCommand(["/usr/local/bin/node", "/container-agent/main.js", "emudb-setsignalcanvasesorder"], env.concat(envVars));
        result = JSON.parse(resultJson);
        if(!result || result.code != 200) {
            if(ws && msg) {
                ws.send(JSON.stringify({ requestId: msg.requestId, type: "cmd-result", cmd: msg.cmd, progress: "end", result: false, message: "Failed to set signal canvases order" }));
            }
            this.app.addLog("Failed creating emuDB (code "+result.code+"): stdout: "+result.body.stdout+". stderr: "+result.body.stderr, "error");
            await this.app.sessMan.deleteSession(session.accessCode);
            return;
        }


        if(ws && msg) {
            ws.send(JSON.stringify({ requestId: msg.requestId, type: "cmd-result", cmd: msg.cmd, progress: (++stepNum)+"/"+totalStepsNum, result: true, message: "Copying docs" }));
        }
        resultJson = await session.copyUploadedDocs();
        result = JSON.parse(resultJson);
        if(!result || (result.code != 200 && result.code != 400)) { //accept 400 as a success code here since it generally just means that there were no documents to copy, which is fine
            this.app.addLog("Failed creating emuDB (code "+result.code+"): stdout: "+result.body.stdout+". stderr: "+result.body.stderr, "error");
            await this.app.sessMan.deleteSession(session.accessCode);
            return;
        }
        
        envVars.push("GIT_USER_EMAIL="+user.email);
        envVars.push("GIT_USER_NAME="+user.firstName+" "+user.lastName);

        let repoDir = "/repositories/"+projectFormData.id;
        this.app.addLog("Committing project "+repoDir, "debug");
        if(ws && msg) {
            ws.send(JSON.stringify({ requestId: msg.requestId, type: "cmd-result", cmd: msg.cmd, progress: (++stepNum)+"/"+totalStepsNum, result: true, message: "Committing project" }));
        }

        this.app.addLog("Initializing simpleGit", "debug");
        let git = await simpleGit(repoDir);
        this.app.addLog("Setting ownership", "debug");
        await this.setOwnershipRecursive(repoDir, 0, 0);
        this.app.addLog("git config user.name", "debug");
        await git.addConfig('user.name', user.firstName+" "+user.lastName);
        this.app.addLog("git config user.email", "debug");
        await git.addConfig('user.email', user.email);
        this.app.addLog("git add", "debug");
        try {
            //this operation might fail with the error: GitError: fatal: Unable to create '/repositories/<projectId>/.git/index.lock': File exists.
            //await git.add('.');
            await this.addFilesToGit(git, projectFormData.id);
        }
        catch(error) {
            this.app.addLog("Failed adding files to git: "+error.toString(), "error");
        }
        
        this.app.addLog("git commit", "debug");
        await git.commit("System commit");
        this.app.addLog("Setting ownership", "debug");
        await this.setOwnershipRecursive(repoDir, 1000, 1000);
        
        if(ws && msg) {
            ws.send(JSON.stringify({ requestId: msg.requestId, type: "cmd-result", cmd: msg.cmd, progress: (++stepNum)+"/"+totalStepsNum, result: true, message: "Finishing up" }));
        }
        await this.app.sessMan.deleteSession(session.accessCode);
    }

    async addFilesToGit(git, projectId) {
        const lockFilePath = path.join('/repositories', projectId, '.git', 'index.lock');
    
        try {
            // This operation might fail with the error: GitError: fatal: Unable to create '/repositories/<projectId>/.git/index.lock': File exists.
            await git.add('.');
        } catch (error) {
            if (error.message.includes('Unable to create') && error.message.includes('index.lock')) {
                this.app.addLog(`Lock file exists, attempting to delete: ${lockFilePath}`, "warn");
                try {
                    await fs.unlink(lockFilePath);
                    this.app.addLog("Lock file deleted, retrying git add operation.", "info");
                    await git.add('.'); // Retry the operation
                } catch (unlinkError) {
                    this.app.addLog("Failed to delete lock file: " + unlinkError.toString(), "error");
                }
            } else {
                this.app.addLog("Failed adding files to git: " + error.toString(), "error");
            }
        }
    }

    validateProjectForm(projectFormData) {
        if(typeof projectFormData.projectName == "undefined" || validator.escape(projectFormData.projectName) != projectFormData.projectName) {
            this.app.addLog("Project name contained invalid characters.", "warn");
            return false;
        }

        //Check that documents doesn't contain any weird files?
        projectFormData.docFiles.forEach(docFile => {
            if(typeof docFile.name == "undefined") {
                this.app.addLog("Document file name undefined", "warn");
                return false;
            }
            if(docFile.name != validator.escape(docFile.name)) {
                this.app.addLog("Document file name "+docFile.name+" contained invalid characters", "warn");
                return false;
            }
        });

        //Check that each session name is ok
        for(let key in projectFormData.sessions) {
            let session = projectFormData.sessions[key];
            let sessionName = session.name;
            if(session.new && (typeof sessionName == "undefined" || sessionName != validator.escape(sessionName))) { //only validate name if session is new, since the name isn't even transmitted otherwise
                this.app.addLog("Session name "+sessionName+" contained invalid characters", "warn");
                return false;
            }
            //Check that speaker gender is set to a valid option
            let validGenderOptions = ["Male", "Female", null]; //null is a valid option
            if(!validGenderOptions.includes(session.speakerGender)) {
                this.app.addLog("Speaker gender selection contained invalid option "+session.speakerGender, "warn");
                return false;
            }
            //Check that speaker age is a number
            if(!Number.isInteger(parseInt(session.speakerAge))) {
                this.app.addLog("Speaker age "+session.speakerAge+" is not a number", "warn");
                return false;
            }

            //Check that dataSource is set to a valid option
            let validDataSourceOptions = ["upload", "record"];
            if(!validDataSourceOptions.includes(session.dataSource)) {
                this.app.addLog("Data source selection contained invalid option "+session.dataSource, "warn");
                return false;
            }

            //If dataSource is set to 'upload', check that all the uploaded files are a supported file format (wav or flac)
            /* disabling this since it's not reliable. it will have a file type of undefined in some cases and if we really want to do file tpe checkcing we should probably use the linux file command instead
            if(session.dataSource == "upload") {
                for(let key in session.files) {
                    let fileMeta = session.files[key];
                    if(fileMeta.type != "audio/wav" && fileMeta.type != "audio/flac") {
                        this.app.addLog("File "+fileMeta.name+" is not a supported file format (wav or flac). File type is: '"+fileMeta.type+"'", "warn");
                        return false;
                    }
                }
            }
            */
        }

        return true;
    }

    async initProjectDirectory(user, projectFormData) {
        let sourceDir = "/repository-template";

        if(typeof projectFormData.id == "undefined") {
            this.app.addLog("No project id specified in initProjectDirectory, aborting", "error");
            return;
        }

        //define project repo path
        let repoDir = "/repositories/"+projectFormData.id;

        //check that target directory does not exist
        if(fs.existsSync(repoDir)) {
            this.app.addLog("Project directory "+repoDir+" already exists when trying to create project with name "+projectFormData.projectName+", aborting", "error");
            return false;
        }

        this.app.addLog("Copying template directory "+sourceDir+" to "+repoDir, "debug");

        if(!await this.copyDirectory(sourceDir, repoDir)) {
            this.app.addLog("Failed copying template directory "+sourceDir+" to "+repoDir, "error");
            return false;
        }

        //create personal directory user Applications for this user
        let userApplicationsDir = repoDir+"/Applications/"+user.firstName+" "+user.lastName+" ("+user.eppn+")";
        if(!fs.existsSync(userApplicationsDir)) {
            this.app.addLog("Creating user applications directory "+userApplicationsDir, "debug");
            fs.mkdirSync(userApplicationsDir); //WHY DOES THIS NOT WORK??? - FIGURE IT OUT ON MONDAY
        }

        //initialize git repo
        let git = await simpleGit(repoDir);
        await git.init();
        await git.addConfig('user.name', user.firstName+" "+user.lastName);
        await git.addConfig('user.email', user.email);
        await git.add('.');
        await git.commit("Initial commit");
        await this.setOwnershipRecursive(repoDir, 1000, 1000);

        return true;
    }

    getSessionContainer(username, projectId, hsApp = "operations", volumes  = [], options = []) {
        return new Rx.Observable(async (observer) => {

            let user = null;
            let project = null;

            //look up user and project via mongoose
            let UserModel = this.mongoose.model('User');
            let p1 = UserModel.findOne({ username: username }).then(res => {
                user = res;
            });
            let ProjectModel = this.mongoose.model('Project');
            let p2 = ProjectModel.findOne({ id: projectId }).then(res => {
                project = res;
            });

            observer.next({ type: "status-update", message: "Pre-flight" });

            Promise.all([p1, p2]).then(values => {
                observer.next({ type: "status-update", message: "Pre-flight complete" });
                observer.next({ type: "status-update", message: "Creating session" });
                let session = this.app.sessMan.createSession(user, project, hsApp, volumes);
                observer.next({ type: "status-update", message: "Spawning container" });
                session.createContainer().then(containerId => {
                    observer.next({ type: "status-update", message: "Session ready" });
                    this.app.addLog("Creating container complete");
                    observer.next({ type: "data", accessCode: session.accessCode });
                    this.app.addLog("Sending sessionAccessCode to client.");
                });
            });
        });
    }

    getSessionContainerOLD(user, project, hsApp = "operations", volumes  = [], options = []) {
        return new Rx.Observable(async (observer) => {
            observer.next({ type: "status-update", message: "Creating session" });
            let session = this.app.sessMan.createSession(user, project, hsApp, volumes);
            observer.next({ type: "status-update", message: "Spawning container" });
            let containerId = await session.createContainer();
            let credentials = user.username+":"+user.personalAccessToken;
            observer.next({ type: "status-update", message: "Cloning project" });
            
            let cloneOptions = [];
            if(options.includes("sparse")) {
                cloneOptions.push("sparse");
            }
            if(this.gitLabActivated) {
                let gitOutput = await session.cloneProjectFromGit(credentials, cloneOptions);
            }
            observer.next({ type: "status-update", message: "Session ready" });
            this.app.addLog("Creating container complete");
            observer.next({ type: "data", accessCode: session.accessCode });
        });
    }

    async shutdownSessionContainer(sessionAccessCode) {
        let session = this.app.sessMan.getSessionByCode(sessionAccessCode);
        if(session) {
            return this.app.sessMan.deleteSession(sessionAccessCode);
        }
        return false;
    }

    async authorizeWebSocketUser(userSession) {
        if(process.env.ACCESS_LIST_ENABLED == 'false') {
            //If access list checking is not enabled, always pass the check
            return true;
        }

        //check that this user exists in the mongodb (users collection) and has the loginAllowed flag set to true
        //this.app.addLog("Checking if user "+userSession.username+" is authorized", "debug");
        let user = await this.fetchMongoUser(userSession.eppn);
        if(user && user.loginAllowed == true) {
            return true;
        }
        this.app.addLog("User "+userSession.username+" not authorized.", "warn");
        return false;
    }

    async authenticateWebSocketUser(request) {
        let cookies = this.parseCookies(request);
        let phpSessionId = cookies.PHPSESSID;

        let options = {
            headers: {
                'Cookie': "PHPSESSID="+phpSessionId
            }
        }

        return new Promise((resolve, reject) => {
            http.get("http://apache/api/api.php?f=session", options, (incMsg) => {
                let body = "";
                incMsg.on('data', (data) => {
                    body += data;
                });
                incMsg.on('end', async () => {
                    try {
                        let responseBody = JSON.parse(body);
                        if(responseBody.body == "[]") {
                            //this.app.addLog("User not identified");
                            resolve({
                                authenticated: false,
                                reason: "User not identified"
                            });
                            return;
                        }
                    }
                    catch(error) {
                        this.app.addLog("Failed parsing authentication response data", "error");
                        resolve({
                            authenticated: false,
                            reason: "Failed parsing authentication response data"
                        });
                        return;
                    }

                    let userSession = JSON.parse(JSON.parse(body).body);

                    //complete user data from the mongodb database
                    let mongoUser = await this.fetchMongoUser(userSession.eppn);
                    userSession = Object.assign(userSession, mongoUser);

                    if(typeof userSession.username == "undefined") {
                        resolve({
                            authenticated: false,
                            reason: "Session not valid"
                        });
                        return;
                    }
                    //this.app.addLog("Welcome user "+userSession.username);
                    resolve({
                        authenticated: true,
                        userSession: userSession
                    });
                });
            });
        });
    }

    parseCookies (request) {
        var list = {},
            rc = request.headers.cookie;

        rc && rc.split(';').forEach(function( cookie ) {
            var parts = cookie.split('=');
            list[parts.shift().trim()] = decodeURI(parts.join('='));
        });
        return list;
    }

    async importContainerTest() {
        let containerId = "b8e26a40bcc364808d9681ccedae8000bdb35ecabdc6e6c9ade2643110921308";
        let modem = new Modem('/var/run/docker.sock');
        let container = new Container(modem, containerId);
        console.log(container);

        return new ApiResponse(200, JSON.stringify(container));

    }

    async fetchMongoProjectById(projectId) {
        let mongoProject = await this.mongoose.model('Project').findOne({ id: projectId });
        return mongoProject;
    }

    async importAudioFiles(projectId, sessionId) {
        this.app.addLog("Starting SPR audio files import", "info");
        /**
         * This method will import audio files from the speech recorder into the project directory.
         * It will do this in two main steps:
         * 1. Copy the last recorded version of each wav file from the speech recorder directory to a new directory
         * 2. Run an R script in the operations container that will import the files to the correct location in the project directory
         */

        let volumes = [{
            source: this.app.absRootPath+"/mounts/repositories/"+projectId,
            target: "/home/rstudio/project"
        }];

        let user = {
            id: "operations-user",
            firstName: "Operations",
            username: "operations-user",
            lastName: "User",
            email: "operations@visp",
            eppn: "operations@visp",
        }

        let project = await this.fetchMongoProjectById(projectId);

        const containerSession = this.app.sessMan.createSession(user, project, 'operations', volumes);
        await containerSession.createContainer();

        let projectSession = null;
        project.sessions.forEach(sess => {
            if(sess.id == sessionId) {
                projectSession = sess;
            }
        });

        let sessions = [{
            id: sessionId,
            slug: this.slugify(projectSession.name),
            sessionId: sessionId,
            name: projectSession.name,
            speakerGender: "", //unused, but needs to be included
            speakerAge: "", //unused, but needs to be included
            files: [] //unused, but needs to be included
        }];
        let sessionsJsonB64 = Buffer.from(JSON.stringify(sessions)).toString("base64");
        let envVars = [
            "PROJECT_PATH=/home/rstudio/project", // + /home/project/Data/VISP_emuDB
            "UPLOAD_PATH=/home/rstudio/project/Data/speech_recorder_uploads",
            //"BUNDLE_LIST_NAME="+userSession.getBundleListName(),
            "EMUDB_SESSIONS="+sessionsJsonB64,
            "WRITE_META_JSON=false"
        ];

        //first delete any old versions of bundles in this session that might exist (if this session has been previously recorded)
        await containerSession.runCommand(["/usr/local/bin/node", "/container-agent/main.js", "emudb-delete-session-bundles"], envVars);

        //emudb-create-sessions
        await containerSession.runCommand(["/usr/local/bin/node", "/container-agent/main.js", "emudb-create-sessions"], envVars);
        await containerSession.runCommand(["/usr/local/bin/node", "/container-agent/main.js", "emudb-track-definitions"], envVars);
        
        //shutdown the container
        await this.app.sessMan.deleteSession(containerSession.accessCode);


        const fileLocation = "/repositories/"+projectId+"/Data/speech_recorder_uploads/emudb-sessions/"+sessionId;
        let files = fs.readdirSync(fileLocation).filter(file => file !== '.' && file !== '..');
        
        //now update the project in mongo to reflect the new files in project.sessions[].files[]
        project.sessions.forEach(sess => {
            if(sess.id == sessionId) {
                files.forEach(file => {
                    //check that this session does not already have a file with this exact name
                    //if it does, then just update the size and type

                    let fileExists = false;

                    let fileSize = fs.statSync(fileLocation+"/"+file).size;
                    let fileMimeType = mime.lookup(fileLocation+"/"+file);

                    sess.files.forEach(sessFile => {
                        if(sessFile.name == file) {
                            fileExists = true;
                            sessFile.size = fileSize;
                            sessFile.type = fileMimeType;
                            this.app.addLog("File "+file+" already exists in session "+sessionId+", updating size and type", "debug");
                        }
                    });

                    if(!fileExists) {
                        sess.files.push({
                            name: file,
                            size: fileSize,
                            type: fileMimeType
                        });
                        this.app.addLog("File "+file+" added to session "+sessionId, "debug");
                    }
                });
                
            }
        });

        project.markModified('sessions');
        await project.save();


        //now delete the files copied for import...?
        /*
        importedFilePaths.forEach(filePath => {
            fs.unlinkSync(filePath);
        });
        */

        this.app.addLog("SPR audio files imported", "info");

        return new ApiResponse(200, "Audio files imported");

        /*

        this.app.addLog("Importing audio files for session "+sessionId+", project " + projectId);
        //Check that this session exists in this project
        this.app.addLog("Hooking up to the mongo-bongo", "debug");
        let db = await this.connectToMongo("wsrng");
        const sessionsCollection = db.collection("sessions");
        const sprSession = await sessionsCollection.findOne({ sessionId: sessionId });
        if(!sprSession || sprSession.project != projectId) {
            this.app.addLog("Session "+sessionId+" not found in project "+projectId, "error");
            return new ApiResponse(404, "Session not found in project");
        }
        db = await this.connectToMongo("visp");

        let project = await db.collection("projects").findOne({ id: projectId });
        if(!project) {
            this.app.addLog("importAudioFiles - project "+projectId+" not found in mongo", "error");
            return new ApiResponse(404, "Project not found in mongo");
        }
        
        let projectSession = null;
        project.sessions.forEach(sess => {
            if(sess.id == sessionId) {
                projectSession = sess;
            }
        });

        //check that this session does not already have files
        if(projectSession.files.length > 0) {
            this.app.addLog("Session "+sessionId+" already has files. Will not import newly recorded files over old ones.", "error");
            return new ApiResponse(400, "Session already has files");
        }

        let sessionPath = "/repositories/"+project.id+"/Data/speech_recorder_uploads/emudb-sessions/"+sessionId;
        //in this sessionPath, each wav file is placed in its own directory (called prompt_1, prompt_2, etc.)
        //there can also be multiple versions in each directory, they are named 0.wav, 1.wav, etc. where the highest number is the latest version and the one we want
        //we need to copy the latest version of each wav file to the Data/unimported_audio directory in the project directory
        
        let mongoProject = await this.mongoose.model('Project').findOne({ id: projectId });

        let mongoProjectSessionKey = null;
        for(let key in mongoProject.sessions) {
            let mongoSession = mongoProject.sessions[key];
            if(mongoSession.id == sessionId) {
                mongoProjectSessionKey = key;
            }
        }

        if(!mongoProject.sessions[mongoProjectSessionKey]) {
            this.app.addLog("importAudioFiles - session "+sessionId+" not found in mongo", "error");
            return new ApiResponse(404, "Session not found in mongo");
        }
        //let's start by scanning the sessionPath
        let importedFilePaths = [];

        let sessionPathContents = [];
        if(fs.existsSync(sessionPath)) {
            try {
              sessionPathContents = fs.readdirSync(sessionPath);
            } catch (err) {
              console.error('Error reading the directory:', err);
            }
          } else {
            console.log('Directory does not exist:', sessionPath);
        }
        
        //"promptDir" here is actually a wav file since we don't use prompt dirs
        sessionPathContents.forEach(promptFile => {
            let promptFileVersions = [];
            let fileBaseName = promptFile.split(".")[0];
            let fileVersion = parseInt(fileBaseName);
            promptFileVersions.push(fileVersion);

            promptFileVersions.sort((a, b) => {
                return b - a;
            });
            let latestFileVersion = promptFileVersions[0];
            let latestFileName = latestFileVersion+".wav";

            //first mkdir
            if(!fs.existsSync("/repositories/"+project.id+"/Data/speech_recorder_uploads/emudb-sessions/"+sessionId)) {
                fs.mkdirSync("/repositories/"+project.id+"/Data/speech_recorder_uploads/emudb-sessions/"+sessionId, {
                    recursive: true
                });
            }

            let promptDirPath = sessionPath+"/"+promptFile;

            let destPath = "/repositories/"+project.id+"/Data/VISP_emuDB/"+projectSession.name+"/"+promptFile;

            this.app.addLog("Copying "+promptDirPath+" to "+destPath, "debug");
            fs.copyFileSync(promptDirPath, destPath);

            importedFilePaths.push("/repositories/"+project.id+"/Data/speech_recorder_uploads/emudb-sessions/"+sessionId+"/"+promptFile);

            mongoProject.sessions[mongoProjectSessionKey].files.push({
                name: promptFile,
                size: null,
                type: 'audio/wav'
            });
        });
        
        mongoProject.markModified('sessions');
        await mongoProject.save();

        let volumes = [{
            source: this.app.absRootPath+"/mounts/repositories/"+project.id,
            target: "/home/rstudio/project"
        }];

        let user = {
            id: "operations-user",
            firstName: "Operations",
            username: "operations-user",
            lastName: "User",
            email: "operations@visp",
            eppn: "operations@visp",
        }

        const session = this.app.sessMan.createSession(user, project, 'operations', volumes);
        await session.createContainer();

        let sessions = [{
            id: sessionId,
            slug: this.slugify(projectSession.name),
            sessionId: sessionId,
            name: projectSession.name,
            speakerGender: "", //unused, but needs to be included
            speakerAge: "", //unused, but needs to be included
            files: [] //unused, but needs to be included
        }];
        let sessionsJsonB64 = Buffer.from(JSON.stringify(sessions)).toString("base64");
        let envVars = [
            "PROJECT_PATH=/home/rstudio/project", // + /home/project/Data/VISP_emuDB
            "UPLOAD_PATH=/home/rstudio/project/Data/speech_recorder_uploads",
            //"BUNDLE_LIST_NAME="+userSession.getBundleListName(),
            "EMUDB_SESSIONS="+sessionsJsonB64,
            "WRITE_META_JSON=false"
        ];

        //emudb-create-sessions
        //await session.runCommand(["/usr/local/bin/node", "/container-agent/main.js", "delete-sessions"], envVars);
        await session.runCommand(["/usr/local/bin/node", "/container-agent/main.js", "emudb-create-sessions"], envVars);
        await session.runCommand(["/usr/local/bin/node", "/container-agent/main.js", "emudb-track-definitions"], envVars);
        //await session.commit();

        //now delete the files copied for import
        importedFilePaths.forEach(filePath => {
            fs.unlinkSync(filePath);
        });

        return new ApiResponse(200, "Audio files imported");
        */
    }

    setupEndpoints() {
        
        this.expressApp.post('/api/importaudiofiles', (req, res) => {
            this.app.addLog('importAudioFiles', "debug");
            this.importAudioFiles(req.body.projectId, req.body.sessionId).then((ar) => {
                res.status(ar.code).end(ar.toJSON());
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
            let sessions = this.app.sessMan.getUserSessions(parseInt(req.params.username));
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
                    let cmdOutputParsed = "";
                    try {
                        cmdOutputParsed = JSON.parse(cmdOutput).body;
                    }
                    catch(error) {
                        cmdOutputParsed = cmdOutput;
                    }
                    //res.sendStatus(200);
                    res.status(200).send(cmdOutputParsed).end();
                });
            }
        });

        this.expressApp.get('/api/accesslist/:user', (req, res) => {
            console.log(req.params.user);
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
            else {
                let unimportedAudioPath = process.env.ABS_ROOT_PATH+"/mounts/session-manager/unimported_audio/"+user.id;
                fs.mkdirSync(unimportedAudioPath, { recursive: true });
                volumes.push({
                    source: unimportedAudioPath,
                    target: "/unimported_audio"
                });
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
                    let volumes = [{
                        source: process.env.ABS_ROOT_PATH+"/mounts/apache/apache/uploads/"+user.id,
                        target: "/unimported_audio"
                    }];

                    let session = this.app.sessMan.createSession(user, project, hsApp, volumes);
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

        this.expressApp.post('/api/spr', (req, res) => {
            //This is an endpoint for handling incoming new spr-sessions from the speech recorder server
            //So this will contain a bundle of wav files which should be added as a new session to a project
            //The project id and the new session name will be designated in the incoming data
            res.end();
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

    shutdown() {
        this.whisperService.shutdown();
    }
}

module.exports = ApiServer
