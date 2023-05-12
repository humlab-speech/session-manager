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
const axios = require('axios');
const fs = require('fs');
const mongodb = require('mongodb');
const UserSession = require('./models/UserSession.class');
const nanoid = require("nanoid");

class ApiServer {
    constructor(app) {
        this.app = app;
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
        this.fetchAccessList().then(accessList => {
            this.accessList = accessList;
        });
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

    disconnectFromMongo() {
        if(this.mongoClient != null) {
            this.mongoClient.close();
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

    /*
    async createGitlabUser(userSession) {
        console.log("Checking gitlab user for "+userSession.eppn);
        console.log(userSession);

        let gitlabApiRequest = this.app.gitlabAddress+"/api/v4/users?search="+userSession.eppn+"&private_token="+this.app.gitlabAccessToken;
        let result = await axios.get(gitlabApiRequest);
        let userList = result.data;
        if(userList.length == 0) {
            //addLog message about creating user
            console.log("Gitlab user not found, creating it.");

            //User doesn't exist, create it
            let gitlabApiRequest = this.app.gitlabAddress+"/api/v4/users?private_token="+this.app.gitlabAccessToken;

            let postData = {
                username: userSession.username,
                email: userSession.email,
                external: false,
                extern_uid: userSession.eppn,
                name: userSession.fullName,
                organization: "",
                skip_confirmation: true
            }
            console.log(postData)
            //let result = await axios.post(gitlabApiRequest, postData);
        }
        else {
            console.log("Gitlab user found");
        }
    }
    */

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
            this.app.sessMan.getUserSessions(client.userSession.id).forEach((session) => {
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

    handleIncomingWebSocketMessage(ws, message) {
        this.app.addLog("Received: "+message, "debug");

        let client = this.getUserSessionBySocket(ws);
        if(!client.accessListValidationPass) {
            //Disallow the user to call any functions if they are not in the access list
            this.app.addLog("User ("+client.userSession.username+") tried to call function without being in access list.");
            ws.send(new WebSocketMessage('0', 'unathorized', 'You are not authorized to use this functionality').toJSON());
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

        if(msg.cmd == "fetchSprScripts") {
            this.fetchSprScripts(ws, msg.data.userId);
        }

        if(msg.cmd == "saveSprScripts") {
            this.saveSprScripts(ws, msg.data.scripts, msg.data.ownerId);
        }

        if(msg.cmd == "deleteSprScript") {
            this.deleteSprScript(ws, msg.data.scriptId);
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

        if(msg.cmd == "fetchOperationsSession") {
            //ws.send("Will totally spawn a new session container for you with "+msg.user.gitlabUsername+" and "+msg.project.id);
            try {
                this.getSessionContainer(msg.user, msg.project).then(session => {
                    ws.send(new WebSocketMessage(msg.context, 'data', session.accessCode).toJSON());
                    //ws.send(JSON.stringify({ type: "data", sessionAccessCode: session.accessCode }));
                });
            }
            catch(error) {
                this.app.addLog(error, "error")
            }
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

        if(msg.cmd == "createProject") {
            try {
                this.createProject(ws, msg);
            }
            catch(error) {
                this.app.addLog(error, "error")
            }
        }

        if(msg.cmd == "fetchSession") {
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

    async fetchSprScripts(ws, userId) {
        const db = await this.connectToMongo("wsrng");

        let query = {};
        if(userId != null && parseInt(userId)) {
            query = { ownerId: userId };
        }
        //fetch all with this user OR with sharing set to 'all'
        query = { $or: [ { ownerId: userId }, { sharing: 'all' } ] }

        let scripts = await db.collection("scripts").find(query).toArray();
        ws.send(JSON.stringify({ type: "cmd-result", cmd: "fetchSprScripts", result: scripts }));
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

    async saveSprScripts(ws, scripts, ownerId) {

        //convert scripts to spr format
        let sprScripts = [];
        for(let key in scripts) {
            let script = scripts[key];

            let sprScript = {
                name: script.name,
                type: "script",
                scriptId: script.scriptId,
                ownerId: ownerId,
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
            
            ws.send(JSON.stringify({ type: "cmd-result", cmd: "saveSprScripts", result: "OK" }));
        });
    }

    async deleteSprScript(ws, scriptId) {
        this.connectToMongo("wsrng").then(async (db) => {
            await db.collection("scripts").deleteOne({ scriptId: scriptId });
            ws.send(JSON.stringify({ type: "cmd-result", cmd: "deleteScript", result: "OK" }));
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
            cmd: "createProject", 
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

    async createEmuDbSessions(ws, msg) {
        let sessions = [{
            sessionId: "", //upload path context
            name: "",
            speakerGender: "",
            speakerAge: "",
            files: [] //don't even need this, the R script will import all the files it finds in the target dir, which is UPLOAD_PATH/emudb-sessions/sessionId
        }];
        let envVars = [
            "PROJECT_PATH=/home/rstudio/project",
            "UPLOAD_PATH=/unimported_audio",
            "EMUDB_SESSIONS="+Buffer.from(JSON.stringify(sessions)).toString('base64')
        ];
        //emudb-create-sessions
        await session.runCommand(["/usr/bin/node", "/container-agent/main.js", "emudb-create-sessions"], envVars);
        ws.send(JSON.stringify({ type: "cmd-result", cmd: "createEmuDbSessions", progress: "done" }));
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

    async createProject(ws, msg) {
        let context = msg.data.context;
        //sanitize input
        let projectName = validator.escape(msg.data.form.projectName);
        
        if(this.emuDbIntegrationEnabled) {
            //Check that names are ok
            for(let key in msg.data.form.sessions) {
                msg.data.form.sessions[key].name = validator.escape(msg.data.form.sessions[key].name);
                msg.data.form.sessions[key].name = msg.data.form.sessions[key].name.replace(/ /g, "_");
            }
        }

        ws.send(JSON.stringify({ type: "cmd-result", cmd: "createProject", progress: "1", result: "Creating project "+projectName }));
        
        //createGitlabProject
        let userSession = this.getUserSessionBySocket(ws);
        let gitlabApiRequest = this.app.gitlabAddress+"/api/v4/projects/user/"+userSession.id+"?private_token="+this.app.gitlabAccessToken;

        let result = await axios.post(gitlabApiRequest, {
            name: projectName
        });

        const gitlabProject = result.data;

        //Set default project branch to 'unprotected' so that users with the 'developer' role can push to it
        gitlabApiRequest = this.app.gitlabAddress+"/api/v4/projects/"+gitlabProject.id+"/protected_branches?private_token="+this.app.gitlabAccessToken;
        await axios.post(gitlabApiRequest, {
            name: "master",
            push_access_level: 30,
            merge_access_level: 30
        });

        ws.send(JSON.stringify({ type: "cmd-result", cmd: "createProject", progress: "2", result: "Creating container" }));

        //this is the path from within this container
        let uploadsSrcDirLocal = "/mounts/apache/apache/uploads/"+userSession.id+"/"+context;
        
        //this is the path from the os root
        let uploadsSrcDir = this.app.absRootPath+"/mounts/apache/apache/uploads/"+userSession.id+"/"+context;
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
        
        //createSession
        const uploadsVolume = {
            source: uploadsSrcDir,
            target: "/home/uploads"
        }
        const projectDirectoryTemplateVolume = {
            source: this.app.absRootPath+"/docker/session-manager/project-template-structure",
            target: "/project-template-structure"
        }
        let volumes = [
            uploadsVolume,
            projectDirectoryTemplateVolume
        ];
        const session = this.app.sessMan.createSession(userSession, gitlabProject, 'operations', volumes);
        await session.createContainer();

        ws.send(JSON.stringify({ type: "cmd-result", cmd: "createProject", progress: "3", result: "Fetching from Git" }));
        let credentials = userSession.username+":"+this.app.gitlabAccessToken;
        let gitOutput = await session.cloneProjectFromGit(credentials);

        let envVars = [
            "PROJECT_PATH=/home/project-setup",
            "UPLOAD_PATH=/home/uploads",
            "BUNDLE_LIST_NAME="+userSession.getBundleListName()
        ];
        //createStandardDirectoryStructure
        if(msg.data.form.standardDirectoryStructure) {
            ws.send(JSON.stringify({ type: "cmd-result", cmd: "createProject", progress: "4", result: "Creating standard directory structure" }));
            
            if(this.emuDbIntegrationEnabled) {
                //Make sure that age is a number, not a string
                for(let sessionKey in msg.data.form.sessions) {
                    msg.data.form.sessions[sessionKey].speakerAge = parseInt(msg.data.form.sessions[sessionKey].speakerAge);
                }

                let sessionsEncoded = Buffer.from(JSON.stringify(msg.data.form.sessions)).toString('base64');
                envVars.push("EMUDB_SESSIONS="+sessionsEncoded);
            }

            await session.runCommand(["/usr/bin/node", "/container-agent/main.js", "copy-project-template-directory"], envVars);

            if(msg.data.form.createEmuDb) {
                //createEmuDb
                ws.send(JSON.stringify({ type: "cmd-result", cmd: "createProject", progress: "5", result: "Creating EmuDB" }));
                await session.runCommand(["/usr/bin/node", "/container-agent/main.js", "emudb-create"], envVars);
                //emudb-create-sessions
                ws.send(JSON.stringify({ type: "cmd-result", cmd: "createProject", progress: "6", result: "Creating EmuDB sessions" }));
                await session.runCommand(["/usr/bin/node", "/container-agent/main.js", "emudb-create-sessions"], envVars);
                //emudb-create-bundlelist
                ws.send(JSON.stringify({ type: "cmd-result", cmd: "createProject", progress: "7", result: "Creating EmuDB bundlelist" }));
                await session.runCommand(["/usr/bin/node", "/container-agent/main.js", "emudb-create-bundlelist"], envVars);

                //emudb-create-annotlevels
                ws.send(JSON.stringify({ type: "cmd-result", cmd: "createProject", progress: "8", result: "Creating EmuDB annotation levels" }));
                for(let key in msg.data.form.annotLevels) {
                    let env = [];
                    let annotLevel = msg.data.form.annotLevels[key];
                    env.push("ANNOT_LEVEL_DEF_NAME="+annotLevel.name);
                    env.push("ANNOT_LEVEL_DEF_TYPE="+annotLevel.type);
                    await session.runCommand(["/usr/bin/node", "/container-agent/main.js", "emudb-create-annotlevels"], env.concat(envVars));
                }

                //emudb-create-annotlevellinks
                ws.send(JSON.stringify({ type: "cmd-result", cmd: "createProject", progress: "9", result: "Creating EmuDB annotation level links" }));
                for(let key in msg.data.form.annotLevelLinks) {
                    let env = [];
                    let annotLevelLink = msg.data.form.annotLevelLinks[key];
                    env.push("ANNOT_LEVEL_LINK_SUPER="+annotLevelLink.superLevel);
                    env.push("ANNOT_LEVEL_LINK_SUB="+annotLevelLink.subLevel);
                    env.push("ANNOT_LEVEL_LINK_DEF_TYPE="+annotLevelLink.type);
                    await session.runCommand(["/usr/bin/node", "/container-agent/main.js", "emudb-create-annotlevellinks"], env.concat(envVars));
                }
                
                
                let env = [];
                env.push("ANNOT_LEVELS="+Buffer.from(JSON.stringify(msg.data.form.annotLevels)).toString('base64'));
                //emudb-add-default-perspectives
                ws.send(JSON.stringify({ type: "cmd-result", cmd: "createProject", progress: "10", result: "Adding default perspectives to EmuDB" }));
                await session.runCommand(["/usr/bin/node", "/container-agent/main.js", "emudb-add-default-perspectives"], env.concat(envVars));

                //emudb-setlevelcanvasesorder
                ws.send(JSON.stringify({ type: "cmd-result", cmd: "createProject", progress: "11", result: "Setting level canvases order" }));
                await session.runCommand(["/usr/bin/node", "/container-agent/main.js", "emudb-setlevelcanvasesorder"], env.concat(envVars));

                /*
                //emudb-ssff-track-definitions
                ws.send(JSON.stringify({ type: "cmd-result", cmd: "createProject", progress: "12", result: "Adding ssff track definitions" }));
                await session.runCommand(["/usr/bin/node", "/container-agent/main.js", "emudb-ssff-track-definitions"], env.concat(envVars));
                */

                //emudb-track-definitions (reindeer)
                ws.send(JSON.stringify({ type: "cmd-result", cmd: "createProject", progress: "12", result: "Adding track definitions" }));
                await session.runCommand(["/usr/bin/node", "/container-agent/main.js", "emudb-track-definitions"], env.concat(envVars));

                //emudb-setsignalcanvasesorder
                ws.send(JSON.stringify({ type: "cmd-result", cmd: "createProject", progress: "13", result: "Setting signal canvases order" }));
                await session.runCommand(["/usr/bin/node", "/container-agent/main.js", "emudb-setsignalcanvasesorder"], env.concat(envVars));
            }
        }
        else {
            this.app.addLog("Skipping creation of standard directory structure");
        }

        ws.send(JSON.stringify({ type: "cmd-result", cmd: "createProject", progress: "14", result: "Copying documents" }));
        await session.copyUploadedFiles();

        ws.send(JSON.stringify({ type: "cmd-result", cmd: "createProject", progress: "15", result: "Copying project files to destination" }));
        await session.runCommand(["/usr/bin/node", "/container-agent/main.js", "full-recursive-copy", "/home/project-setup", "/home/rstudio/project"], envVars);
        
        //ws.send(JSON.stringify({ type: "cmd-result", cmd: "createProject", progress: "16", result: "Running chown on project directory" }));
        await session.runCommand(["/usr/bin/node", "/container-agent/main.js", "chown-directory", "/home/rstudio/project", "root:root"], envVars);

        ws.send(JSON.stringify({ type: "cmd-result", cmd: "createProject", progress: "16", result: "Pushing to Git" }));
        await session.commit();

        ws.send(JSON.stringify({ type: "cmd-result", cmd: "createProject", progress: "end", result: "Done" }));
        await session.delete();
    }

    getSessionContainer(user, project, hsApp = "operations", volumes  = [], options = []) {
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
            let gitOutput = await session.cloneProjectFromGit(credentials, cloneOptions);
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

    async fetchGitlabUser(userId) {
        let config = {
            headers: {
                'PRIVATE-TOKEN': this.app.gitlabAccessToken
            }
        }

        return await axios.get("http://gitlab/api/v4/users/"+userId, config);
    }

    async fetchGitlabProject(projectId) {
        let config = {
            headers: {
                'PRIVATE-TOKEN': this.app.gitlabAccessToken
            }
        }

        return await axios.get("http://gitlab/api/v4/projects/"+projectId, config);
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
        this.disconnectFromMongo();
        db = await this.connectToMongo("visp");
        //spawn new container session
        const gitlabProject = await this.fetchGitlabProject(projectId);
        let userData = gitlabProject.data.owner;
        userData.firstName = userData.name.split(" ")[0];
        userData.lastName = userData.name.substring(userData.name.indexOf(" ")+1);
        //get mongo personal access token
        const usersCollection = db.collection("personal_access_tokens");
        const userPAT = await usersCollection.findOne({
            userId: parseInt(userData.id)
        });
        this.disconnectFromMongo();
        if(!userPAT) {
            this.app.addLog("User with id "+userData.id+" was not in the db", "warn");
            return new ApiResponse(403, "User not found in database");
        }

        userData.personalAccessToken = userPAT.pat;
        const userSession = new UserSession(userData);
        
        let volumes = [];
        const session = this.app.sessMan.createSession(userSession, gitlabProject.data, 'operations', volumes);
        await session.createContainer();

        let credentials = userSession.username+":"+userData.personalAccessToken;
        let gitOutput = await session.cloneProjectFromGit(credentials);

        let sessions = [{
            sessionId: sessionId,
            name: sprSession.sessionName,
            speakerGender: "", //unused
            speakerAge: "", //unused
            files: [] //unused
        }];
        let sessionsJsonB64 = Buffer.from(JSON.stringify(sessions)).toString("base64");
        let envVars = [
            "PROJECT_PATH=/home/rstudio/project", // + /home/project/Data/VISP_emuDB
            "UPLOAD_PATH=/home/rstudio/project/Data/unimported_audio",
            "BUNDLE_LIST_NAME="+userSession.getBundleListName(),
            "EMUDB_SESSIONS="+sessionsJsonB64,
            "WRITE_META_JSON=false"
        ];

        //emudb-create-sessions
        await session.runCommand(["/usr/bin/node", "/container-agent/main.js", "delete-sessions"], envVars);
        await session.runCommand(["/usr/bin/node", "/container-agent/main.js", "emudb-create-sessions"], envVars);
        await session.runCommand(["/usr/bin/node", "/container-agent/main.js", "emudb-track-definitions"], envVars);
        await session.commit();

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
            let sessions = this.app.sessMan.getUserSessions(parseInt(req.params.user_id));
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

        this.expressApp.get('/api/session/:session_id/copyuploadedfiles', (req, res) => {
            let sess = this.app.sessMan.getSessionByCode(req.params.session_id);
            if(sess === false) {
            //Todo: Add error handling here if session doesn't exist
            res.end(`{ "msg": "Session does not exist", "level": "error" }`);
            }
            sess.copyUploadedFiles().then((result) => {
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
