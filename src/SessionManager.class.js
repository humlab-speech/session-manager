// Require nanoid explicitly. Fail fast if it's missing or doesn't provide the expected export.
const nanoid = require("nanoid");
const Session = require("./Session.class");
const fetch = require("node-fetch");
const { Docker } = require("node-docker-api");
const ApiResponse = require("./ApiResponse.class");
const JupyterSession = require("./Sessions/JupyterSession.class");
const OperationsSession = require("./Sessions/OperationsSession.class");

class SessionManager {
    constructor(app) {
        this.app = app;
        this.sessions = [];
        // Maps an authenticated PHP session id -> the user's eppn. Populated by
        // ApiServer.authenticateWebSocketUser (the one place a PHPSESSID is verified
        // against Apache) and consulted by routeToApp/routeToAppWs to confirm that a
        // request proxying into a session container comes from that session's owner.
        // A plain Map (insertion-ordered) so we can evict the oldest entry when the
        // cap is reached; entries are tiny strings and the cap bounds memory on long
        // uptimes. Evicting a live user's entry is safe — it only drops that request
        // back to the fail-open path (no enforcement), never denies a legitimate owner.
        this.phpSessionOwners = new Map();
        this.phpSessionOwnersMax = 10000;
        this.docker = new Docker({ socketPath: this.app.dockerSocketPath });
    }

    importSuspendedSessions() {
        this.app.addLog("Importing suspended sessions");
        this.docker.image.list().then((sessionImages) => {
            let imageShortList = [];
            sessionImages.forEach((si) => {
                si.data.RepoTags.forEach((tag) => {
                    let tagParts = tag.split(":");
                    let tagName = tagParts[0];
                    let tagVersion = tagParts[1];

                    if (tagName == "hs-suspended-session") {
                        imageShortList.push(si);
                    }
                });
            });

            imageShortList.forEach((image) => {
                this.app.addLog(
                    "Importing suspended session: " +
                        image.data.Labels["visp.hsApp"] +
                        "/" +
                        "u" +
                        image.data.Labels["visp.userId"] +
                        "/p" +
                        image.data.Labels["visp.projectId"],
                );

                let fetchPromises = [];
                fetchPromises.push(
                    this.fetchUserById(image.data.Labels["visp.userId"]),
                );
                fetchPromises.push(
                    this.fetchProjectById(image.data.Labels["visp.projectId"]),
                );
                Promise.all(fetchPromises).then((data) => {
                    let user = data[0];
                    let project = data[1];
                    let sess = this.createSession(
                        user,
                        project,
                        image.data.Labels["visp.hsApp"],
                    );
                    sess.overrideImage(image);
                    sess.createContainer();
                });
            });
        });
    }

    commitRunningSessions(shutdownWhenDone = true) {
        this.app.addLog("Committing all running sessions");
        let promises = [];
        this.sessions.forEach((session) => {
            promises.push(session.commit());
        });

        Promise.all(promises).then(() => {
            this.app.addLog("All running sessions committed");
            if (shutdownWhenDone) {
                promises = [];
                this.sessions.forEach((session) => {
                    promises.push(session.delete());
                });

                Promise.all(promises).then(() => {
                    this.app.addLog("All running sessions shutdown");
                });
            }
        });
    }

    exportRunningSessions() {
        this.sessions.forEach((session) => {
            session.exportToImage();
        });
    }

    getContainerAccessCode() {
        let code = nanoid.nanoid(32);
        while (this.checkIfCodeIsUsed(code)) {
            code = nanoid(32);
        }
        return code;
    }

    checkIfCodeIsUsed(code) {
        for (let key in this.sessions) {
            if (this.sessions[key].accessCode == code) {
                return true;
            }
        }
        return false;
    }

    getContainerSessionsOverviewByProjectId(projectId) {
        this.refreshSessions();

        let sessions = [];
        this.sessions.forEach((session) => {
            if (session.project.id == projectId) {
                sessions.push({
                    projectId: session.project.id,
                    username: session.user.username,
                    type: session.hsApp,
                    sessionAccessCode: session.accessCode,
                });
            }
        });
        return sessions;
    }

    async getContainerSessionsByProjectId(projectId) {
        await this.refreshSessions();

        let sessions = [];
        this.sessions.forEach((session) => {
            if (session.project.id == projectId) {
                sessions.push(session);
            }
        });
        return sessions;
    }

    getAllSessions() {
        this.refreshSessions();

        let sessions = [];
        this.sessions.forEach((session) => {
            sessions.push({
                projectId: session.project.id,
                username: session.user.username,
                type: session.hsApp,
                sessionAccessCode: session.accessCode,
            });
        });
        return sessions;
    }

    getUserSessions(username) {
        this.app.addLog("Getting user sessions for user " + username);
        let userSessions = [];
        for (let key in this.sessions) {
            if (this.sessions[key].user.username == username) {
                userSessions.push({
                    sessionCode: this.sessions[key].accessCode,
                    projectId: this.sessions[key].project.id,
                    type: this.sessions[key].hsApp,
                });
            }
        }
        if (userSessions.length == 0) {
            this.app.addLog("No container sessions found for user " + username);
        }
        return userSessions;
    }

    createSession(user, project, hsApp = "jupyter", volumes = []) {
        let sess = null;
        switch (hsApp) {
            case "jupyter":
                sess = new JupyterSession(
                    this.app,
                    user,
                    project,
                    this.getAvailableSessionProxyPort(),
                    hsApp,
                    volumes,
                );
                break;
            case "operations":
                sess = new OperationsSession(
                    this.app,
                    user,
                    project,
                    this.getAvailableSessionProxyPort(),
                    hsApp,
                    volumes,
                );
                break;
            default:
                this.app.addLog("Unknown hsApp type: " + hsApp, "error");
        }

        if (sess != null) {
            this.sessions.push(sess);
        }

        return sess;
    }

    async refreshSessions() {
        //check with the docker daemon for running containers
        //if we find any that are not in the sessions array, add them
        //if we find any in the sessions array that are not in the docker daemon, remove them
        this.docker.container
            .list({ all: true })
            .then((containers) => {
                let containerIds = [];
                containers.forEach((container) => {
                    let shortId = container.id.substring(0, 12);
                    containerIds.push(shortId);
                });

                this.app.addLog(
                    "refreshSessions: Found " +
                        containerIds.length +
                        " containers in docker daemon",
                    "debug",
                );
                this.app.addLog(
                    "refreshSessions: Checking " +
                        this.sessions.length +
                        " sessions",
                    "debug",
                );

                // Check each session
                for (let i = this.sessions.length - 1; i >= 0; i--) {
                    let session = this.sessions[i];

                    // Skip sessions created in the last 10 seconds to avoid race conditions
                    if (
                        session.createdAt &&
                        Date.now() - session.createdAt < 10000
                    ) {
                        this.app.addLog(
                            "refreshSessions: Skipping recently created session " +
                                session.accessCode +
                                " (created " +
                                (Date.now() - session.createdAt) +
                                "ms ago)",
                            "debug",
                        );
                        continue;
                    }

                    if (session.shortDockerContainerId === null) {
                        this.app.addLog(
                            "refreshSessions: Skipping session " +
                                session.accessCode +
                                " - container not yet created",
                            "debug",
                        );
                        continue;
                    }

                    // Check if container exists in Docker daemon
                    if (
                        containerIds.indexOf(session.shortDockerContainerId) ==
                        -1
                    ) {
                        this.app.addLog(
                            "Session " +
                                session.accessCode +
                                " (container " +
                                session.shortDockerContainerId +
                                ") not found in docker daemon, removing",
                            "debug",
                        );
                        session.delete();
                        continue;
                    }

                    // Check if container is actually running by inspecting it
                    let containerFound = containers.find(
                        (c) =>
                            c.id.substring(0, 12) ===
                            session.shortDockerContainerId,
                    );
                    if (
                        containerFound &&
                        containerFound.data &&
                        containerFound.data.State
                    ) {
                        let state = containerFound.data.State;
                        if (state === "exited" || state === "dead") {
                            this.app.addLog(
                                "Session " +
                                    session.accessCode +
                                    " (container " +
                                    session.shortDockerContainerId +
                                    ") is in state " +
                                    state +
                                    ", removing",
                                "debug",
                            );
                            session.delete();
                            continue;
                        }
                    }

                    this.app.addLog(
                        "Session " +
                            session.accessCode +
                            " (container " +
                            session.shortDockerContainerId +
                            ") found and running",
                        "debug",
                    );
                }
            })
            .catch((error) => {
                this.app.addLog(
                    "refreshSessions: Error listing containers: " + error,
                    "error",
                );
            });
    }

    getSessionAccessCodeFromRequest(req) {
        return this.getCookieFromRequest(req, "SessionAccessCode");
    }

    // Generic single-cookie reader. Kept tolerant of both "; " and ";" delimiters
    // and of values that themselves contain "=" (only the first "=" is the split).
    getCookieFromRequest(req, name) {
        let value = false;
        if (typeof req.headers.cookie != "undefined") {
            req.headers.cookie.split(";").forEach((cookie) => {
                let trimmed = cookie.trim();
                let eq = trimmed.indexOf("=");
                if (eq === -1) return;
                if (trimmed.substring(0, eq) === name) {
                    value = trimmed.substring(eq + 1);
                }
            });
        }
        return value;
    }

    // Called by ApiServer.authenticateWebSocketUser after a PHPSESSID has been
    // validated against Apache. Remembers which user owns this PHP session so
    // routeToApp can authorize proxied requests without its own Apache round-trip.
    recordAuthenticatedUser(phpSessionId, eppn) {
        if (!phpSessionId || !eppn) return;
        // Re-insert to mark as most-recently-used, then bound the map size.
        this.phpSessionOwners.delete(phpSessionId);
        this.phpSessionOwners.set(phpSessionId, eppn);
        while (this.phpSessionOwners.size > this.phpSessionOwnersMax) {
            const oldest = this.phpSessionOwners.keys().next().value;
            this.phpSessionOwners.delete(oldest);
        }
    }

    forgetAuthenticatedUser(phpSessionId) {
        if (phpSessionId) this.phpSessionOwners.delete(phpSessionId);
    }

    // Authorization gate for proxying a request into a session container.
    //
    // The accessCode alone is a bearer token: anyone presenting it is routed in.
    // This adds a cheap, in-memory ownership check on top — no Apache call, no DB
    // call, so no latency or throughput cost on the proxy path. It compares the
    // eppn that owns the target session against the eppn behind the requester's
    // PHPSESSID cookie.
    //
    // Deliberately fail-OPEN when identity cannot be established (no PHPSESSID, or
    // a PHPSESSID/owner we have not seen authenticate in this process — e.g. after
    // a session-manager restart, before the owner's control socket reconnects).
    // Failing open there means we never deny a legitimate owner, honoring the
    // "no usability impact" requirement; we only ever deny a POSITIVE mismatch —
    // a logged-in user trying to ride someone else's session code — which is the
    // concrete threat. Returns true to allow, false to deny.
    isRequestAuthorizedForSession(req, sess) {
        const ownerEppn = sess && sess.user ? sess.user.eppn : null;
        if (!ownerEppn) return true; // owner identity unknown -> fail open

        const phpSessionId = this.getCookieFromRequest(req, "PHPSESSID");
        if (!phpSessionId) return true; // requester identity unknown -> fail open

        const requesterEppn = this.phpSessionOwners.get(phpSessionId);
        if (!requesterEppn) return true; // never saw this session authenticate -> fail open

        return requesterEppn === ownerEppn;
    }

    routeToApp(req, res = null, socket = null, ws = false, head = null) {
        let sessionAccessCode = this.getSessionAccessCodeFromRequest(req);
        if (sessionAccessCode === false) {
            this.app.addLog(
                "Couldn't perform routing to app (" +
                    req.url +
                    ") because we couldn't get a sessionAccessCode from the request! (1)",
                "warn",
            );
            return false;
        }

        let sess = this.getSessionByCode(sessionAccessCode);
        if (sess === false) {
            this.app.addLog(
                "Couldn't find a container session with code " +
                    sessionAccessCode +
                    " (1)",
                "warn",
            );
            this.app.addLog(this.sessions);
            return false;
        }

        if (!this.isRequestAuthorizedForSession(req, sess)) {
            this.app.addLog(
                "Denied routing to session " +
                    sessionAccessCode +
                    ": requester is not the session owner (" +
                    req.url +
                    ") (1)",
                "warn",
            );
            if (res) {
                res.writeHead(403, { "Content-Type": "text/plain" });
                res.end("Forbidden");
            }
            return false;
        }
        //this.app.addLog("Route-to-app - request: "+req.url, "debug");
        sess.proxyServer.web(req, res);
    }

    routeToAppWs(req, socket, head) {
        let sessionAccessCode = this.getSessionAccessCodeFromRequest(req);
        if (sessionAccessCode === false) {
            this.app.addLog(
                "Couldn't perform routing to app (" +
                    req.url +
                    ") because we couldn't get a sessionAccessCode from the request! (2)",
                "warn",
            );
            return false;
        }

        let sess = this.getSessionByCode(sessionAccessCode);
        if (sess === false) {
            this.app.addLog(
                "Couldn't find a container session with code " +
                    sessionAccessCode +
                    " (2)",
                "warn",
            );
            this.app.addLog(this.sessions);
            return false;
        }

        if (!this.isRequestAuthorizedForSession(req, sess)) {
            this.app.addLog(
                "Denied ws routing to session " +
                    sessionAccessCode +
                    ": requester is not the session owner (" +
                    req.url +
                    ") (2)",
                "warn",
            );
            if (socket) socket.destroy();
            return false;
        }

        this.app.addLog("Route-to-app ws - request: " + req.url, "debug");

        //socket.on('message', message => this.addLog("routeToAppWs - ws msg: "+message, "debug"));

        sess.proxyServer.ws(req, socket, head);
    }

    /*
    getSessionName(userId, projectId) {
        return "rstudio-session-p"+projectId+"u"+userId;
    }
    */

    stopContainer(containerId) {}

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
        for (let key in this.sessions) {
            if (
                this.sessions[key].user.id == userId &&
                this.sessions[key].project.id == projectId &&
                this.sessions[key].hsApp == hsApp
            ) {
                return this.sessions[key];
            }
        }
        return false;
    }

    getRunningContainers() {
        //This needs to be implemented using docker API
    }

    getSessionByCode(code) {
        if (typeof code != "string") {
            this.app.addLog(
                "getSessionByCode received non-string argument: " + code,
                "error",
            );
            return false;
        }
        code = code.toString("utf8");
        for (let key in this.sessions) {
            if (this.sessions[key].accessCode == code) {
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
        while (selectedPortInUse) {
            selectedPortInUse = false;
            for (let key in this.sessions) {
                if (this.sessions[key].port == selectedPort) {
                    selectedPortInUse = true;
                }
            }
            if (selectedPortInUse) {
                if (selectedPort < portMax) {
                    selectedPort++;
                } else {
                    return false;
                }
            } else {
                return selectedPort;
            }
        }

        return false;
    }

    removeSession(session) {
        for (let i = this.sessions.length - 1; i > -1; i--) {
            if (this.sessions[i].accessCode == session.accessCode) {
                this.sessions.splice(i, 1);
            }
        }
    }

    sessionDeletionCleanup(sessionId) {
        //delete from the sessions array
        for (let key in this.sessions) {
            if (this.sessions[key].accessCode == sessionId) {
                this.sessions.splice(key, 1);
                return false;
            }
        }
    }

    async deleteSession(sessionId) {
        return new Promise((resolve, reject) => {
            let sess = this.getSessionByCode(sessionId);
            if (sess === false) {
                reject("Could not find session " + sessionId);
            }

            sess.delete().then(() => {
                this.removeSession(sess);
                resolve("Session deleted");
            });
        });
    }

    async shutdown() {
        //nothing to do here
        return true;
    }
}

module.exports = SessionManager;
