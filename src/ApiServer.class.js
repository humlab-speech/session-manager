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
        //this.expressApp.use(bodyParser.json());

        this.setupEndpoints();
        this.startServer();
        this.startWsServer();
        this.mongoose = this.talkToMeGoose();
        this.fetchAccessList().then(accessList => {
            this.accessList = accessList;
        });

        this.defineModels();

        
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
        });
        mongoose.model('User', this.models.User);

        this.models.Project = new mongoose.Schema({
            id: String,
            name: String,
            slug: String,
            owner: String,
            sessions: Array,
            annotationLevels: Array,
            annotationLinks: Array,
            members: Array,
            docs: Array
        });
        mongoose.model('Project', this.models.Project);


        /* BundleList.bundles looks like this:
        [
            {
                "session": "Sess1",
                "name": "testljud",
                "comment": "",
                "finishedEditing": false
            },
            {
                "session": "Sess1",
                "name": "water_river",
                "comment": "",
                "finishedEditing": false
            }
        ]
        */
        this.models.BundleList = new mongoose.Schema({
            owner: String,
            projectId: String,
            bundles: Array,
        });
        mongoose.model('BundleList', this.models.BundleList);
    }

    async fetchAccessList() {
        const db = await this.connectToMongo();
        const usersCollection = db.collection("users");
        let accessList = await usersCollection.find({}).toArray();
        this.disconnectFromMongo();
        return accessList;
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

    talkToMeGoose() { //also known as 'connectMongoose'
        const mongoUrl = 'mongodb://root:'+process.env.MONGO_ROOT_PASSWORD+'@mongo:27017/visp?authSource=admin';
        mongoose.connect(mongoUrl, { useNewUrlParser: true, useUnifiedTopology: true });
        return mongoose;
    }
    connectMongoose = this.talkToMeGoose.bind(this);

    disconnectMongoose() {
        mongoose.disconnect();
    }

    async connectToMongo(database = "visp") {
        //check if this.mongoClient is already an active mongodb connection
        if(this.mongoClient != null) {
            return this.mongoClient.db(database);
        }

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
            this.app.addLog("Client requested WS upgrade - authenticating");
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
                        //If all is well this far, then the user has authenticated via keycloak and now has a valid session
                        //but we still need to check if this user is also included in the access list or not
                        if(await this.authorizeWebSocketUser(client) == false) {
                            ws.send(new WebSocketMessage('0', 'authentication-status', {
                                result: false,
                                reason: authResult.reason
                            }).toJSON());
                            return;
                        }

                        //If we have a valid user session, we can now create a gitlab user for this user (if it doesn't exist already)
                        //this.createGitlabUser(client.userSession); //this is already being done in the webapi - so nevermind

                        this.wsClients.push(client);
                        
                        ws.on('message', message => this.handleIncomingWebSocketMessage(ws, message));
                        ws.on('close', () => {
                            this.handleConnectionClosed(client);
                        });

                        ws.send(new WebSocketMessage('0', 'authentication-status', {
                            result: true
                        }).toJSON());
                    }
                    else {
                        this.app.addLog("Authentication failed", "warn");
                        ws.send(new WebSocketMessage('0', 'authentication-status', {
                            result: false,
                            reason: authResult.reason
                        }).toJSON());
                        ws.close(1000);
                    }
                });
            });
        });

        this.httpWsServer.listen(this.wsPort);
    }

    getUserSessionBySocket(ws) {
        for(let key in this.wsClients) {
            if(this.wsClients[key].socket === ws) {
                return this.wsClients[key].userSession;
            }
        }
        return false;
    }


    handleConnectionClosed(client) {
        //If this client has any active operations-sessions, kill them
        if(client.userSession) {
            this.app.sessMan.getUserSessions(client.userSession.username).forEach((session) => {
                if(session.type == "operations") {
                    this.shutdownSessionContainer(session.sessionCode);
                }
            });
        }
        
        if(this.deleteWsClient(client)) {
            this.app.addLog("Deleted websocket client");
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

    async handleIncomingWebSocketMessage(ws, message) {
        this.app.addLog("Received: "+message, "debug");

        let client = this.getUserSessionBySocket(ws);
        
        if(!client.accessListValidationPass) {
            //Disallow the user to call any functions if they are not in the access list
            this.app.addLog("User ("+client.userSession.username+") tried to call function without being in access list.");
            ws.send(new WebSocketMessage('0', 'unathorized', 'You are not authorized to use this functionality').toJSON());
            return;
        }
        
        let user = await this.fetchUser(client);
        if(!user) {
            this.app.addLog("Failed fetching user", "error");
            return;
        }

        let msg = null;
        try {
            msg = JSON.parse(message);
        }
        catch(err) {
            this.app.addLog("Failed parsing incoming websocket message as JSON. Message was: "+message, "error");
        }

        if(msg == null) {
            this.app.addLog("Received unparsable websocket message, ignoring.", "warning");
            return;
        }

        if(msg.cmd == "fetchMembers") {
            this.fetchMembers(ws, msg);
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
                ws.send(JSON.stringify({ type: "cmd-result", cmd: msg.cmd, result: result }));
            });
        }

        if(msg.cmd == "fetchSprScriptBySessionId") {
            this.fetchSprScriptBySessionId(msg.data.sprSessionId).then(result => {
                ws.send(JSON.stringify({ type: "cmd-result", cmd: msg.cmd, result: result, requestId: msg.requestId }));
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
                ws.send(JSON.stringify({ type: "cmd-result", cmd: msg.caCmd, session: msg.appSession, result: "Error - no such session" }));
                return;
            }
            
            let envVars = [];
            msg.env.forEach(pair => {
                envVars.push(pair.key+"="+pair.value);
            });

            session.runCommand(["/usr/bin/node", "/container-agent/main.js", msg.caCmd], envVars).then((result) => {
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
                session.runCommand(["/usr/bin/node", "/container-agent/main.js", "emudb-scan"], envVars).then((emuDbScanResult) => {
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

        if(msg.cmd == "fetchSession") {

            //this is deprecated
            this.app.addLog("fetchSession called, this probably shouldn't happen.", "warning");
            /*
            try {
                let userSession = this.getUserSessionBySocket(ws);
                let volumes = [];
                let userSess = new UserSession(userSession);

                //this is the path from within this container
                const uploadsSrcDirLocal = "/mounts/apache/apache/uploads/"+userSession.id;
                
                //this is the path from the os root
                const uploadsSrcDir = this.app.absRootPath+"/mounts/apache/apache/uploads/"+userSession.id;
                if(!fs.existsSync(uploadsSrcDirLocal)) {
                    this.app.addLog("Directory "+uploadsSrcDir+" does not exist, creating it");
                    try {
                        fs.mkdirSync(uploadsSrcDirLocal, {
                            recursive: true
                        });
                    }
                    catch(error) {
                        this.app.addLog("Failed creating directory "+uploadsSrcDir+". "+error.toString(), "error");
                    }
                }

                volumes.push({
                    source: uploadsSrcDir,
                    target: '/home/uploads'
                });


                if(this.gitLabActivated) {
                    let usernameSlug = msg.user.gitlabUsername.replace(/[^a-zA-Z0-9]/g, '-');
                    let projectSlug = msg.project.name.replace(/[^a-zA-Z0-9]/g, '-');
                    this.app.addLog("Mounting "+this.app.absRootPath+"/mounts/repositories/"+usernameSlug+"/"+projectSlug+" to /home/rstudio/project - WARNING CHECK SLUGS", "debug");
                    volumes.push({
                        source: this.app.absRootPath+"/mounts/repositories/"+usernameSlug+"/"+projectSlug,
                        target: '/home/rstudio/project'
                    });
                }

                let data = JSON.parse(msg.data);
                this.getSessionContainer(userSess, data.project, "operations", volumes, data.options).subscribe(status => {
                    if(status.type == "status-update") {
                        ws.send(JSON.stringify({ type: "cmd-result", cmd: "fetchSession", progress: "update", result: status.message }));
                    }
                    if(status.type == "data") {
                        ws.send(JSON.stringify({ type: "cmd-result", cmd: "fetchSession", progress: "end", result: status.accessCode }));
                    }
                });
            }
            catch(error) {
                this.app.addLog(error, "error")
            }
            */
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

        /*
        if(msg.cmd == "importEmuDbSessions") {
            this.app.addLog("createEmuDb", "debug");
            this.importEmuDbSessions(ws, msg.appSession);
        }
        */
    }

    async closeContainerSession(ws, user, msg) {
        let session = this.app.sessMan.getSessionByCode(msg.sessionAccessCode);
        if(!session) {
            ws.send(JSON.stringify({ type: "cmd-result", cmd: "closeSession", progress: "end", result: "Error - no such session", requestId: msg.requestId }));
            return;
        }

        if(session.user.username != user.username) {
            ws.send(JSON.stringify({ type: "cmd-result", cmd: "closeSession", progress: "end", result: "Error - you are not the owner of this session", requestId: msg.requestId }));
            return;
        }

        this.app.sessMan.deleteSession(msg.sessionAccessCode).then((result) => {
            ws.send(JSON.stringify({ type: "cmd-result", cmd: "closeSession", result: result, progress: "end", requestId: msg.requestId }));
        });
    }

    async launchContainerSession(ws, user, msg) {
        //check if this user already has a running session, if so, route into that instead of spawning a new one
        let sessions = this.app.sessMan.getUserSessions(user.username);
        for(let key in sessions) {
            if(sessions[key].type == msg.appName && sessions[key].projectId == msg.projectId) {
                ws.send(JSON.stringify({ type: "cmd-result", cmd: "launchContainerSession", progress: "end", result: sessions[key].sessionCode, requestId: msg.requestId }));
                return;
            }
        }

        let project = await this.fetchProject(msg.projectId);

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
            ws.send(JSON.stringify({ type: "cmd-result", cmd: "launchContainerSession", progress: "end", result: "Error - unknown app name", requestId: msg.requestId }));
            return;
        }

        volumes.push({
            source: this.app.absRootPath+"/mounts/repositories/"+project.id,
            target: '/home/'+containerUser+'/project'
        });
        
        this.getSessionContainer(user.username, msg.projectId, msg.appName, volumes).subscribe(status => {
            if(status.type == "status-update") {
                ws.send(JSON.stringify({ type: "cmd-result", cmd: "launchContainerSession", progress: "update", result: status.message }));
            }
            if(status.type == "data") {
                ws.send(JSON.stringify({ type: "cmd-result", cmd: "launchContainerSession", progress: "end", result: status.accessCode, requestId: msg.requestId }));
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
            ws.send(JSON.stringify({ type: "cmd-result", requestId: msg.requestId, progress: 'end', cmd: msg.cmd, result: false, message: "Project not found" }));
            return;
        }

        //get user info
        const User = this.mongoose.model('User');
        let userInfo = await User.findOne({ username: msg.username }).select('username email eppn firstName lastName fullName');

        if(!userInfo) {
            ws.send(JSON.stringify({ type: "cmd-result", requestId: msg.requestId, progress: 'end', cmd: msg.cmd, result: false, message: "User not found" }));
            return;
        }

        if(!project.members) {
            project.members = [];
        }

        //check that this user has the authority to add members to this project, project.members should contain this user with the role 'admin'
        let userIsAdmin = project.members.find(m => m.username == user.username && m.role == "admin");
        if(!userIsAdmin) {
            this.app.addLog("User "+user.username+" tried to add a member to project "+msg.projectId+", but is not an admin of this project", "warning");
            ws.send(JSON.stringify({ type: "cmd-result", requestId: msg.requestId, progress: 'end', cmd: msg.cmd, result: false, message: "User is not an admin of this project" }));
            return;
        }

        //check if user is already a member
        let existingMember = project.members.find(m => m.username == msg.username);
        if(existingMember) {
            ws.send(JSON.stringify({ type: "cmd-result", requestId: msg.requestId, progress: 'end', cmd: msg.cmd, result: false, message: "User is already a member of this project" }));
            return;
        }

        //add user to project
        project.members.push({
            username: msg.username,
            role: "member"
        });
        project.save();

        

        ws.send(JSON.stringify({ type: "cmd-result", requestId: msg.requestId, progress: 'end', cmd: msg.cmd, result: true, user: userInfo }));
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

    async searchUsers(ws, user, msg) {
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

        ws.send(JSON.stringify({ type: "cmd-result", cmd: "fetchBundleList", result: bundleListResult, requestId: msg.requestId }));
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
            delete users[key].authorized;
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
                project.members[key2].fullName = userInfo.fullName;
                project.members[key2].firstName = userInfo.firstName;
                project.members[key2].lastName = userInfo.lastName;
                project.members[key2].email = userInfo.email;
                project.members[key2].eppn = userInfo.eppn;
            }

            //also return information about any running containers for this project
            projects[key].liveAppSessions = this.app.sessMan.getSessionsByProjectId(project.id);
        }
    
        ws.send(JSON.stringify({ type: "cmd-result", requestId: msg.requestId, progress: 'end', cmd: msg.cmd, result: projects }));
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
        this.disconnectFromMongo();
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
            
            await session.runCommand(["/usr/bin/node", "/container-agent/main.js", "emudb-update-bundle-lists"], envVars).then((result) => {
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
        await containerSession.runCommand(["/usr/bin/node", "/container-agent/main.js", "emudb-create-sessions"], envVars);

        ws.send(JSON.stringify({
            type: "cmd-result", 
            cmd: "addSessions", 
            progress: "3", 
            result: "Creating bundle lists"
        }));
        await containerSession.runCommand(["/usr/bin/node", "/container-agent/main.js", "emudb-create-bundlelist"], envVars);

        
        ws.send(JSON.stringify({
            type: "cmd-result", 
            cmd: "addSessions", 
            progress: "4", 
            result: "Adding track definitions" 
        }));
        await containerSession.runCommand(["/usr/bin/node", "/container-agent/main.js", "emudb-track-definitions"], envVars);

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
            await session.runCommand(["/usr/bin/node", "/container-agent/main.js", "emudb-create-annotlevels"], env.concat(envVars));
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
             await session.runCommand(["/usr/bin/node", "/container-agent/main.js", "emudb-create-annotlevellinks"], env.concat(envVars));
         }

         ws.send(JSON.stringify({ type: "cmd-result", cmd: "createAnnotationLevelLinks", progress: "done" }));
    }

    async createEmuDbDefaultPerspectives(ws, msg) {
        let env = [];
        env.push("ANNOT_LEVELS="+Buffer.from(JSON.stringify(msg.data.form.emuDb.annotLevels)).toString('base64'));
        //emudb-add-default-perspectives
        
        await session.runCommand(["/usr/bin/node", "/container-agent/main.js", "emudb-add-default-perspectives"], env.concat(envVars));

        ws.send(JSON.stringify({ type: "cmd-result", cmd: "createEmuDb", progress: "done" }));
    }

    async setEmuDbLevelCanvasesOrder(ws, msg) {
        //emudb-setlevelcanvasesorder
        await session.runCommand(["/usr/bin/node", "/container-agent/main.js", "emudb-setlevelcanvasesorder"], env.concat(envVars));

        ws.send(JSON.stringify({ type: "cmd-result", cmd: "createEmuDb", progress: "done" }));
    }
    
    async setEmuDbTrackDefinitions(ws, msg) {
        //emudb-track-definitions (reindeer)
        ws.send(JSON.stringify({ type: "cmd-result", cmd: "createEmuDb", progress: "12", result: "Adding track definitions" }));
        await session.runCommand(["/usr/bin/node", "/container-agent/main.js", "emudb-track-definitions"], env.concat(envVars));
    }

    async setEmuDbSignalCanvasesOrder(ws, msg) {
        //emudb-setsignalcanvasesorder
        ws.send(JSON.stringify({ type: "cmd-result", cmd: "createEmuDb", progress: "13", result: "Setting signal canvases order" }));
        await session.runCommand(["/usr/bin/node", "/container-agent/main.js", "emudb-setsignalcanvasesorder"], env.concat(envVars));
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

        await session.runCommand(["/usr/bin/node", "/container-agent/main.js", "emudb-create"], envVars);

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
        console.log(path);
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
        inputString = inputString.toLowerCase().trim();
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
        let project = await Project.findOne({ id: projectId });
        return project;   
    }
    /*
    async getSessionById(projectId, sessionId) {
        const Project = this.mongoose.model('Project');
        let project = await Project.findOne(
            { id: parseInt(projectId), 'sessions.id': sessionId },
            { 'sessions.$': 1 }
        );

        console.log(project);

        console.log(JSON.stringify(project, null, 2));

        let session = project.sessions[0];
        return session;
    }
    */
    async getSessionById(projectId, sessionId) {
        const Project = this.mongoose.model('Project');
        let project = await Project.findOne(
            { id: projectId }, 
            { sessions: { $elemMatch: { id: sessionId } } }
        );
        let session = project.sessions[0];
        return session;
    }
    

    async deleteBundle(ws, user, msg) {
        let projectId = msg.data.projectId;
        let sessionId = msg.data.sessionId;
        let fileName = msg.data.fileName;

        let project = await this.getProjectById(projectId);
        let session = await this.getSessionById(projectId, sessionId);

        if(!project || !session) {
            ws.send(JSON.stringify({ type: "cmd-result", cmd: "deleteBundle", progress: "end", result: "Could not find project or session", requestId: msg.requestId }));
            return;
        }

        //check that this user is a project member and has the role 'admin'
        let userIsAdmin = project.members.find(m => m.username == user.username && m.role == "admin");
        if(!userIsAdmin) {
            ws.send(JSON.stringify({ type: "cmd-result", cmd: "deleteBundle", progress: "end", result: "User is not admin for this project", requestId: msg.requestId }));
            return;
        }
        
        //delete from both mongodb and repository path
        let fileBaseName = path.basename(fileName, path.extname(fileName));
        let repoBundlePath = "/repositories/"+project.id+"/Data/VISP_emuDB/"+this.slugify(session.name)+"_ses/"+fileBaseName+"_bndl";
        this.app.addLog("Deleting bundle directory "+repoBundlePath, "debug");
        
        //check that the bundle directory exists
        if(!fs.existsSync(repoBundlePath)) {
            this.app.addLog("Trying to delete bundle directory "+repoBundlePath+", but it does not exist, continuing anyway", "warning");
        }
        
        if(!nativeSync(repoBundlePath)) {
            this.app.addLog("Could not delete file "+repoBundlePath, "error");
        }

        const Project = this.mongoose.model('Project');
        await Project.updateOne(
            { id: projectId, "sessions.id": sessionId },
            { $pull: { "sessions.$.files": { name: fileName } } }
        );

        ws.send(JSON.stringify({ type: "cmd-result", cmd: "deleteBundle", progress: "end", result: "Success", requestId: msg.requestId }));
    }

    async deleteProject(ws, user, msg) {
        let totalStepsNum = 3;
        let stepNum = 0;
        ws.send(JSON.stringify({ type: "cmd-result", cmd: "deleteProject", progress: (++stepNum)+"/"+totalStepsNum, result: "Initiating" }));

        let project = msg.data.project;
        let repoPath = "/repositories/"+project.id;

        ws.send(JSON.stringify({ type: "cmd-result", cmd: "deleteProject", progress: (++stepNum)+"/"+totalStepsNum, result: "Deleting project from database" }));
        const Project = this.mongoose.model('Project');
        await Project.deleteOne({ id: project.id });

        ws.send(JSON.stringify({ type: "cmd-result", cmd: "deleteProject", progress: (++stepNum)+"/"+totalStepsNum, result: "Deleting project from filesystem" }));
        if(!nativeSync(repoPath)) {
            this.app.addLog("Could not delete project "+repoPath, "error");
        }
        ws.send(JSON.stringify({ type: "cmd-result", cmd: "deleteProject", progress: "end", result: "Project deleted" }));
    }

    async createProject(ws, user, msg) {
        let totalStepsNum = 5;
        let stepNum = 0;
        let projectFormData = msg.project;
        projectFormData.id = nanoid.nanoid();
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
session-manager_1    |           "sprScriptName": "",
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

        ws.send(JSON.stringify({ type: "cmd-result", cmd: "saveProject", progress: (++stepNum)+"/"+totalStepsNum, result: "Validating input" }));
        if(!this.validateProjectForm(projectFormData)) {
            return;
        }
        
        ws.send(JSON.stringify({ type: "cmd-result", cmd: "saveProject", progress: (++stepNum)+"/"+totalStepsNum, result: "Initializing project directory" })); 
        if(!await this.initProjectDirectory(user, projectFormData)) {
            this.app.addLog("Failed initializing project directory", "warn");
        }

        ws.send(JSON.stringify({ type: "cmd-result", cmd: "saveProject", progress: (++stepNum)+"/"+totalStepsNum, result: "Storing project in MongoDB" }));
        
        let mongoProject = await this.mongoose.model('Project').create({
            id: projectFormData.id,
            name: projectFormData.projectName,
            owner: user.eppn,
            slug: this.slugify(projectFormData.projectName),
            sessions: [],
            annotationLevels: [],
            annotationLinks: [],
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

        ws.send(JSON.stringify({ type: "cmd-result", cmd: "saveProject", progress: (++stepNum)+"/"+totalStepsNum, result: "Building project directory" }));
        await this.saveProjectEmuDb(user, projectFormData, true);
        ws.send(JSON.stringify({ type: "cmd-result", cmd: "saveProject", progress: (++stepNum)+"/"+totalStepsNum, result: "Done" }));
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
        let totalStepsNum = 3;
        let stepNum = 0;
        let projectFormData = msg.project;

        this.app.addLog("Updating project");
        if(!this.validateProjectForm(projectFormData)) {
            this.app.addLog("Project form validation failed", "error");
            return;
        }

        ws.send(JSON.stringify({ type: "cmd-result", cmd: "saveProject", progress: (++stepNum)+"/"+totalStepsNum, result: "Updating database" }));
        await this.saveSessionsMongo(projectFormData);
        
        ws.send(JSON.stringify({ type: "cmd-result", cmd: "saveProject", progress: (++stepNum)+"/"+totalStepsNum, result: "Building project directory" }));
        await this.saveProjectEmuDb(user, projectFormData, false);
        ws.send(JSON.stringify({ type: "cmd-result", cmd: "saveProject", progress: (++stepNum)+"/"+totalStepsNum, result: "Done" }));
    }

    async saveSessionsMongo(projectFormData) {
        this.app.addLog("Saving sessions to MongoDB");
        let mongoProject = await this.mongoose.model('Project').findOne({ id: projectFormData.id });

        for (let formSession of projectFormData.sessions) {
        //for(let key in projectFormData.sessions) {
            //let formSession = projectFormData.sessions[key];

            if(formSession.deleted) {
                this.app.addLog("Deleting session "+formSession.name+" from mongo project", "debug");
                await mongoProject.updateOne(
                    {
                      $pull: {
                        sessions: { id: formSession.id },
                      },
                    }
                  );

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
                    sprScriptName: formSession.sprScriptName,
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
            mongoSession.sprScriptName = formSession.sprScriptName;
            mongoSession.sessionScript = formSession.sessionScript;
            mongoSession.sessionId = formSession.sessionId;
            mongoSession.files = formSession.files.map(fileMeta => ({
                name: fileMeta.fileName
            }));

            this.sprSessionUpdate(formSession);
        }

        mongoProject.save();
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
        this.app.addLog("Updating SPR session "+session.id);
        let db = await this.connectToMongo("wsrng");
        let collection = db.collection("sessions");
        collection.updateOne({ sessionId: session.id }, {
            $set: {
                script: session.sessionScript,
            }
        });
    }

    async sprSessionDelete(sessionId) {
        this.app.addLog("Deleting SPR session "+sessionId);
        let db = await this.connectToMongo("wsrng");
        let collection = db.collection("sessions");
        collection.deleteOne({ sessionId: sessionId });
    }

    /**
     * This method will spin up a container, mount the repo volume and create or update the EmuDB directory structure and files
     * 
     * @param {*} ws 
     * @param {*} user 
     * @param {*} projectFormData 
     */
    async saveProjectEmuDb(user, projectFormData, newProject = true) {
        if(typeof projectFormData.id == "undefined") {
            this.app.addLog("No project id specified in saveProjectEmuDb, aborting", "error");
            return;
        }

        //Spawning container
        let context = projectFormData.formContextId;
        //this is the path from within this container
        let uploadsSrcDirLocal = "/tmp/uploads/"+user.username+"/"+context;
        //this is the path from the os root, which is what we will pass as a volume argument to the operations container
        let uploadsSrcDir = this.app.absRootPath+"/mounts/apache/apache/uploads/"+user.username+"/"+context;
        if(!fs.existsSync(uploadsSrcDirLocal)) {
            this.app.addLog("Directory "+uploadsSrcDir+" does not exist, creating it");
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

        //TODO: import the files in uploadsSrcDir, e.g. uploadsSrcDir+"/emudb-sessions/FMaeQyJomuZkyYGiN70Jq/testljud.wav"
        //where FMaeQyJomuZkyYGiN70Jq is the session id

        //execute emuDb import sessions - we need to spin up a container for this
        
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
            resultJson = await session.runCommand(["/usr/bin/node", "/container-agent/main.js", "emudb-create"], envVars);
            result = JSON.parse(resultJson);
            if(result.code != 200) {
                this.app.addLog("Failed creating emuDB (code "+result.code+"): stdout: "+result.body.stdout+". stderr: "+result.body.stderr, "error");
                return;
            }
        }

        //emudb-create-sessions
        resultJson = await session.runCommand(["/usr/bin/node", "/container-agent/main.js", "emudb-create-sessions"], envVars);
        result = JSON.parse(resultJson);
        if(result.code != 200) {
            this.app.addLog("Failed creating emuDB (code "+result.code+"): stdout: "+result.body.stdout+". stderr: "+result.body.stderr, "error");
            return;
        }
        
        //emudb-create-bundlelist
        resultJson = await session.runCommand(["/usr/bin/node", "/container-agent/main.js", "emudb-create-bundlelist"], envVars);
        result = JSON.parse(resultJson);
        if(result.code != 200) {
            this.app.addLog("Failed creating emuDB (code "+result.code+"): stdout: "+result.body.stdout+". stderr: "+result.body.stderr, "error");
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


        //emudb-create-annotlevels
        for(let key in projectFormData.annotLevels) {
            let env = [];
            let annotLevel = projectFormData.annotLevels[key];
            env.push("ANNOT_LEVEL_DEF_NAME="+annotLevel.name);
            env.push("ANNOT_LEVEL_DEF_TYPE="+annotLevel.type);
            resultJson = await session.runCommand(["/usr/bin/node", "/container-agent/main.js", "emudb-create-annotlevels"], env.concat(envVars));
            result = JSON.parse(resultJson);
            if(result.code != 200) {
                this.app.addLog("Failed creating emuDB (code "+result.code+"): stdout: "+result.body.stdout+". stderr: "+result.body.stderr, "error");
                return;
            }
        }

        //emudb-create-annotlevellinks
        for(let key in projectFormData.annotLevelLinks) {
            let env = [];
            let annotLevelLink = projectFormData.annotLevelLinks[key];
            env.push("ANNOT_LEVEL_LINK_SUPER="+annotLevelLink.superLevel);
            env.push("ANNOT_LEVEL_LINK_SUB="+annotLevelLink.subLevel);
            env.push("ANNOT_LEVEL_LINK_DEF_TYPE="+annotLevelLink.type);
            resultJson = await session.runCommand(["/usr/bin/node", "/container-agent/main.js", "emudb-create-annotlevellinks"], env.concat(envVars));
            result = JSON.parse(resultJson);
            if(result.code != 200) {
                this.app.addLog("Failed creating emuDB (code "+result.code+"): stdout: "+result.body.stdout+". stderr: "+result.body.stderr, "error");
                return;
            }
        }
        
        let env = [];
        env.push("ANNOT_LEVELS="+Buffer.from(JSON.stringify(projectFormData.annotLevels)).toString('base64'));
        //emudb-add-default-perspectives
        resultJson = await session.runCommand(["/usr/bin/node", "/container-agent/main.js", "emudb-add-default-perspectives"], env.concat(envVars));
        result = JSON.parse(resultJson);
        if(result.code != 200) {
            this.app.addLog("Failed creating emuDB (code "+result.code+"): stdout: "+result.body.stdout+". stderr: "+result.body.stderr, "error");
            return;
        }

        //emudb-setlevelcanvasesorder
        resultJson = await session.runCommand(["/usr/bin/node", "/container-agent/main.js", "emudb-setlevelcanvasesorder"], env.concat(envVars));
        result = JSON.parse(resultJson);
        if(result.code != 200) {
            this.app.addLog("Failed creating emuDB (code "+result.code+"): stdout: "+result.body.stdout+". stderr: "+result.body.stderr, "error");
            return;
        }

        /*
        //emudb-ssff-track-definitions
        resultJson = await session.runCommand(["/usr/bin/node", "/container-agent/main.js", "emudb-ssff-track-definitions"], env.concat(envVars));
        result = JSON.parse(resultJson);
        if(result.code != 200) {
            this.app.addLog("Failed defining ssff tracks (code "+result.code+"): stdout: "+result.body.stdout+". stderr: "+result.body.stderr, "error");
            return;
        }
        */

        //emudb-track-definitions (reindeer)
        resultJson = await session.runCommand(["/usr/bin/node", "/container-agent/main.js", "emudb-track-definitions"], env.concat(envVars));
        result = JSON.parse(resultJson);
        if(result.code != 200) {
            this.app.addLog("Failed creating emuDB (code "+result.code+"): stdout: "+result.body.stdout+". stderr: "+result.body.stderr, "error");
            return;
        }

        //emudb-setsignalcanvasesorder
        resultJson = await session.runCommand(["/usr/bin/node", "/container-agent/main.js", "emudb-setsignalcanvasesorder"], env.concat(envVars));
        result = JSON.parse(resultJson);
        if(result.code != 200) {
            this.app.addLog("Failed creating emuDB (code "+result.code+"): stdout: "+result.body.stdout+". stderr: "+result.body.stderr, "error");
            return;
        }

        resultJson = await session.copyUploadedDocs();
        result = JSON.parse(resultJson);
        if(result.code != 200 && result.code != 400) { //accept 400 as a success code here since it generally just means that there were no documents to copy, which is fine
            this.app.addLog("Failed creating emuDB (code "+result.code+"): stdout: "+result.body.stdout+". stderr: "+result.body.stderr, "error");
            return;
        }
        
        envVars.push("GIT_USER_EMAIL="+user.email);
        envVars.push("GIT_USER_NAME="+user.firstName+" "+user.lastName);

        let repoDir = "/repositories/"+projectFormData.id;
        this.app.addLog("Committing project "+repoDir, "debug");
        let git = await simpleGit(repoDir);
        await this.setOwnershipRecursive(repoDir, 0, 0);
        await git.addConfig('user.name', user.firstName+" "+user.lastName);
        await git.addConfig('user.email', user.email);
        await git.add('.');
        await git.commit("System commit");
        await this.setOwnershipRecursive(repoDir, 1000, 1000);
        
        await this.app.sessMan.deleteSession(session.accessCode);
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

            //If dataSource is set to 'record', check that a valid recording script is selected
            if(session.dataSource == "record") {
                if(session.sprScriptName == "") {
                    this.app.addLog("No recording script selected", "warn"); //this is ok though
                }
            }
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

    async authenticateWebSocketUser(request) {
        let cookies = this.parseCookies(request);
        let phpSessionId = cookies.PHPSESSID;

        this.app.addLog('Validating phpSessionId '+phpSessionId);

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
                incMsg.on('end', () => {
                    try {
                        let responseBody = JSON.parse(body);
                        if(responseBody.body == "[]") {
                            this.app.addLog("User not identified");
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
                    if(typeof userSession.username == "undefined") {
                        resolve({
                            authenticated: false,
                            reason: "Session not valid"
                        });
                        return;
                    }
                    this.app.addLog("Welcome user "+userSession.username);
                    resolve({
                        authenticated: true,
                        userSession: userSession
                    });
                });
            });
        });
    }

    async authorizeWebSocketUser(client) {
        if(process.env.ACCESS_LIST_ENABLED == 'false') {
            //If access list checking is not enabled, always pass the check
            client.userSession.accessListValidationPass = true;
            return client.userSession.accessListValidationPass;
        }

        /*
        const db = await this.connectToMongo();
        const usersCollection = db.collection("users");
        const usersList = await usersCollection.find({
            eppn: client.userSession.eppn
        }).toArray();
        
        this.disconnectFromMongo();
        */

        let foundUserInAccessList = false;
        this.accessList.forEach(user => {
            if(user.eppn == client.userSession.eppn) {
                foundUserInAccessList = true;
            }
        });

        if(!foundUserInAccessList) {
            //Couldn't find this user in the db
            this.app.addLog("User with eppn "+client.userSession.eppn+" tried to sign-in but was not in the access list", "warn");
            client.userSession.accessListValidationPass = false;
        }
        else {
            this.app.addLog("User with eppn "+client.userSession.eppn+" authorized by being in the access list",);
            client.userSession.accessListValidationPass = true;
        }

        return client.userSession.accessListValidationPass;
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

    async importAudioFiles(projectId, sessionId) {
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
        let sessionPathContents = fs.readdirSync(sessionPath);
        sessionPathContents.forEach(promptDir => {
            let promptDirPath = sessionPath+"/"+promptDir;
            let promptDirContents = fs.readdirSync(promptDirPath);

            let promptFileVersions = [];
            promptDirContents.forEach(promptFile => {
                let fileBaseName = promptFile.split(".")[0];
                let fileVersion = parseInt(fileBaseName);
                promptFileVersions.push(fileVersion);
            });

            promptFileVersions.sort((a, b) => {
                return b - a;
            });
            let latestFileVersion = promptFileVersions[0];
            let latestFileName = latestFileVersion+".wav";

            //first mkdir
            if(!fs.existsSync("/repositories/"+project.id+"/Data/unimported_audio/emudb-sessions/"+sessionId)) {
                fs.mkdirSync("/repositories/"+project.id+"/Data/unimported_audio/emudb-sessions/"+sessionId, {
                    recursive: true
                });
            }

            this.app.addLog("Copying "+promptDirPath+"/"+latestFileName+" to "+"/repositories/"+project.id+"/Data/unimported_audio/emudb-sessions/"+sessionId+"/"+promptDir+".wav", "debug");
            fs.copyFileSync(promptDirPath+"/"+latestFileName, "/repositories/"+project.id+"/Data/unimported_audio/emudb-sessions/"+sessionId+"/"+promptDir+".wav");

            importedFilePaths.push("/repositories/"+project.id+"/Data/unimported_audio/emudb-sessions/"+sessionId+"/"+promptDir+".wav");

            mongoProject.sessions[mongoProjectSessionKey].files.push({
                name: promptDir+".wav",
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
            "UPLOAD_PATH=/home/rstudio/project/Data/unimported_audio",
            //"BUNDLE_LIST_NAME="+userSession.getBundleListName(),
            "EMUDB_SESSIONS="+sessionsJsonB64,
            "WRITE_META_JSON=false"
        ];

        //emudb-create-sessions
        //await session.runCommand(["/usr/bin/node", "/container-agent/main.js", "delete-sessions"], envVars);
        await session.runCommand(["/usr/bin/node", "/container-agent/main.js", "emudb-create-sessions"], envVars);
        await session.runCommand(["/usr/bin/node", "/container-agent/main.js", "emudb-track-definitions"], envVars);
        //await session.commit();

        //now delete the files copied for import
        importedFilePaths.forEach(filePath => {
            fs.unlinkSync(filePath);
        });

        return new ApiResponse(200, "Audio files imported");
    }

    setupEndpoints() {
        
        this.expressApp.post('/api/importaudiofiles', (req, res) => {
            this.app.addLog('importAudioFiles', "debug");
            this.importAudioFiles(req.body.projectId, req.body.sessionId).then((ar) => {
                res.status(ar.code).end(ar.toJSON());
            });
        });

        this.expressApp.get('/api/isgitlabready', (req, res) => {
            //this.app.addLog('isGitlabReady');
            this.app.sessMan.isGitlabReady().then((gitlabIsReady) => {
                res.status(200).end(new ApiResponse(200, { gitlabIsReady: gitlabIsReady }).toJSON());
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
}

module.exports = ApiServer
