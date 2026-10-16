const test = require("node:test");
const assert = require("node:assert");

// NoSQL operator injection through the raw MongoDB driver.
//
// ApiServer talks to some collections through db.collection() (no schema
// casting). A client that sends {"$ne": null} where a string is expected used
// to have it interpreted as query operators — redeeming ANY unused invite code
// and escalating to project membership. The fakes below implement the naive
// operator matching of the real driver, so against unfixed code these tests
// show the injection succeeding; the fix must refuse before the DB call.

const {
    createApiServer,
    wsRecorder,
} = require("../test-helpers/fake-mongoose.js");
const ApiServer = require("../src/ApiServer.class");

// Naive driver semantics for the shapes under test: bare values compare by
// equality, {$ne: v} / {$gt: v} evaluate as operators. Unknown operators
// match nothing. This is deliberately NOT the strict-equality fake-mongoose
// `matches()` — that one models Mongoose casting, this one models raw db.collection().
function naiveMatch(doc, q) {
    return Object.entries(q).every(([k, v]) => {
        if (v !== null && typeof v === "object" && !Array.isArray(v)) {
            return Object.entries(v).every(([op, operand]) => {
                if (op === "$ne") return doc[k] !== operand;
                if (op === "$gt") return String(doc[k]) > String(operand);
                return false;
            });
        }
        return doc[k] === v;
    });
}

function rawDb(docs) {
    const calls = [];
    const writes = [];
    const db = {
        collection(name) {
            const list = docs[name] ?? [];
            return {
                async findOne(q) {
                    calls.push([name, q]);
                    return list.find((d) => naiveMatch(d, q)) ?? null;
                },
                // The real driver's find() is synchronous and hands back a
                // cursor; making this async would hide that contract.
                find(q) {
                    calls.push([name, q]);
                    const matched = list.filter((d) => naiveMatch(d, q));
                    return { toArray: async () => matched };
                },
                async updateOne(q, u) {
                    calls.push([name, q]);
                    writes.push([name, u]);
                },
                async deleteOne(q) {
                    calls.push([name, q]);
                    writes.push([name, null]);
                },
                async insertOne(d) {
                    calls.push([name, d]);
                    writes.push([name, d]);
                },
            };
        },
    };
    return { db, calls, writes };
}

function createContext(docs) {
    const { db, calls, writes } = rawDb(docs);
    const api = createApiServer(ApiServer);
    api.connectToMongo = async () => db;
    api.getUserSessionBySocket = () => ({ username: "alice" });
    // The real constructor seeds this from the database; tests use the static
    // defaults — getProjectPermissions reads the role flags straight from it.
    api.projectRolesCache = Object.fromEntries(
        ApiServer.DEFAULT_PROJECT_ROLES.map((role) => [role.name, role]),
    );
    // authorizeInviteCodeAccess reads the project through Mongoose (String-cast
    // id — the non-injectable half of the story); give it an admin'd project.
    const authProject = {
        id: "p1",
        members: [
            { username: "alice", role: ApiServer.PROJECT_ROLE_PROJECT_ADMIN },
        ],
    };
    api.mongoose = {
        model: () => ({
            findOne: (q) => ({
                lean: async () => (q?.id === authProject.id ? authProject : null),
            }),
        }),
    };
    const ws = wsRecorder();
    return { api, ws, calls, writes };
}

const VALID_DOCS = () => ({
    invite_codes: [
        {
            code: "G00D-C0DE",
            used: false,
            projectId: "p1",
            role: "researcher",
        },
    ],
    users: [{ username: "alice" }],
    projects: [{ id: "p1", members: [] }],
});

const msgWith = (code) => ({
    cmd: "validateInviteCode",
    requestId: "r1",
    data: { code },
});

test("validateInviteCode: {\"$ne\":null} must be refused before any DB call", async () => {
    const { api, ws, calls, writes } = createContext(VALID_DOCS());
    await api.validateInviteCode(ws, msgWith({ $ne: null }), {
        eppn: "someone",
        username: "mallory",
    });
    assert.strictEqual(calls.length, 0, "no raw query may be issued");
    assert.strictEqual(writes.length, 0, "no write may land");
    assert.strictEqual(ws.sent.length, 1);
    assert.strictEqual(ws.sent[0].result, false);
    assert.strictEqual(ws.sent[0].requestId, "r1");
});

test("validateInviteCode: {\"$gt\":\"\"} must be refused before any DB call", async () => {
    const { api, ws, calls, writes } = createContext(VALID_DOCS());
    await api.validateInviteCode(ws, msgWith({ $gt: "" }), {
        eppn: "someone",
        username: "mallory",
    });
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(writes.length, 0);
    assert.strictEqual(ws.sent[0].result, false);
});

test("validateInviteCode: positive control - a real code still redeems", async () => {
    const { api, ws, calls, writes } = createContext(VALID_DOCS());
    await api.validateInviteCode(ws, msgWith("G00D-C0DE"), {
        eppn: "someone",
        username: "alice",
    });
    assert.ok(calls.length > 0, "the good code must reach the lookup");
    assert.strictEqual(ws.sent[ws.sent.length - 1].result, true);
    const userWrite = writes.find(
        ([name, u]) => name === "users" && u?.$set?.loginAllowed === true,
    );
    assert.ok(userWrite, "redeeming authorizes the account");
    const usedWrite = writes.find(
        ([name, u]) => name === "invite_codes" && u?.$set?.used === true,
    );
    assert.ok(usedWrite, "the code must be marked used");
});

test("deleteInviteCode: operator-shaped code is refused before any lookup", async () => {
    const { api, ws, calls, writes } = createContext(VALID_DOCS());
    await api.deleteInviteCode(ws, {
        cmd: "deleteInviteCode",
        requestId: "r1",
        data: { code: { $ne: null } },
    });
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(writes.length, 0);
    assert.match(String(ws.sent[0].result), /^ERROR/);
});

test("updateInviteCodes: one malformed code refuses the whole batch, nothing is written", async () => {
    const { api, ws, writes } = createContext(VALID_DOCS());
    await api.updateInviteCodes(ws, {
        cmd: "updateInviteCodes",
        requestId: "r1",
        data: {
            inviteCodes: [
                { code: "G00D-C0DE", role: "researcher", eppn: "" },
                { code: { $ne: null }, role: "researcher", eppn: "" },
            ],
        },
    });
    assert.strictEqual(writes.length, 0, "no updateOne may be applied");
    assert.match(String(ws.sent[0].result), /^ERROR/);
});

test("getInviteCodesByProject: object projectId is refused before the raw find", async () => {
    const { api, ws, calls } = createContext(VALID_DOCS());
    await api.getInviteCodesByProject(ws, {
        cmd: "getInviteCodesByProject",
        requestId: "r1",
        data: { projectId: { $ne: null } },
    });
    assert.strictEqual(calls.length, 0);
    assert.match(String(ws.sent[0].result), /^ERROR/);
});

test("fetchSprScripts: object username is refused; a string username still queries", async () => {
    const { api, ws, calls } = createContext({ scripts: [] });
    await api.fetchSprScripts(ws, {
        cmd: "fetchSprScripts",
        requestId: "r1",
        data: { username: { $ne: "nobody" } },
    });
    assert.strictEqual(calls.length, 0);
    assert.match(String(ws.sent[0].result), /^ERROR/);

    const ctx2 = createContext({ scripts: [] });
    await ctx2.api.fetchSprScripts(ctx2.ws, {
        cmd: "fetchSprScripts",
        requestId: "r2",
        data: { username: "alice" },
    });
    assert.strictEqual(ctx2.calls.length, 1);
    assert.deepStrictEqual(ctx2.calls[0][1], {
        $or: [{ owner: "alice" }, { sharing: "all" }],
    });
});

test("deleteSprScript: operator scriptId never reaches deleteOne", async () => {
    const { api, ws, writes } = createContext({ scripts: [] });
    await api.deleteSprScript(ws, {
        cmd: "deleteSprScript",
        requestId: "r1",
        data: { scriptId: { $ne: null } },
    });
    assert.strictEqual(writes.length, 0);
    assert.match(String(ws.sent[0].result), /^ERROR/);
});

test("createSprSessions: malformed entries refuse the batch before any write", async () => {
    const { api, ws, calls, writes } = createContext({ sessions: [] });
    await api.createSprSessions(ws, {
        cmd: "createSprSessions",
        requestId: "r1",
        sessions: [
            {
                projectId: 12,
                sessionId: { $ne: null },
                sessionName: "x",
                sessionScript: "s",
            },
        ],
    });
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(writes.length, 0);
    assert.match(String(ws.sent[0].result), /^ERROR/);
});

test("fetchMongoUser: non-string eppn returns null without a query", async () => {
    const { api, calls } = createContext(VALID_DOCS());
    assert.strictEqual(await api.fetchMongoUser({ $ne: null }), null);
    assert.strictEqual(await api.fetchMongoUser(""), null);
    assert.strictEqual(calls.length, 0);
    // A real eppn must still reach the lookup
    assert.strictEqual(await api.fetchMongoUser("someone@example.edu"), null);
    assert.strictEqual(calls.length, 1);
});

test("fetchSprSession: operator-shaped sessionId never reaches the collection", async () => {
    const { api, calls } = createContext({ sessions: [{ sessionId: "s1", project: 1 }] });
    assert.strictEqual(await api.fetchSprSession({ $ne: null }), null);
    assert.strictEqual(calls.length, 0);
    const found = await api.fetchSprSession("s1");
    assert.ok(found);
});

test("requireQueryString: only non-empty strings pass", () => {
    const r = ApiServer.requireQueryString;
    assert.strictEqual(r("abc"), "abc");
    assert.strictEqual(r(""), null);
    assert.strictEqual(r(null), null);
    assert.strictEqual(r(undefined), null);
    assert.strictEqual(r(123), null);
    assert.strictEqual(r(true), null);
    assert.strictEqual(r([]), null);
    assert.strictEqual(r({ $ne: null }), null);
});

test("getSession: the browser copy of the user session carries no long-lived credentials", async () => {
    const api = createApiServer(ApiServer);
    api.app = { addLog: () => {} };
    api.projectRolesCache = Object.fromEntries(
        ApiServer.DEFAULT_PROJECT_ROLES.map((r) => [r.name, r]),
    );
    const fullUser = {
        _id: "64e71bdb16e4d351def68ca5",
        username: "alice",
        eppn: "alice@example.edu",
        firstName: "Alice",
        loginAllowed: true,
        personalAccessToken: "glpat-SECRET",
        phpSessionId: "abc123",
    };
    const client = { originalRequest: {} };
    api.getClientBySocket = () => client;
    api.authenticateWebSocketUser = async () => ({
        authenticated: true,
        userSession: fullUser,
    });
    const ws = wsRecorder();
    await api.handleIncomingWebSocketMessage(
        ws,
        JSON.stringify({ cmd: "getSession", requestId: "r1", data: {} }),
    );
    const sent = ws.sent.find((m) => m.cmd === "getSession");
    assert.ok(sent, "getSession must be answered: " + JSON.stringify(ws.sent));
    assert.strictEqual(sent.data.personalAccessToken, undefined);
    assert.strictEqual(sent.data.phpSessionId, undefined);
    assert.strictEqual(sent.data._id, undefined);
    assert.strictEqual(sent.data.username, "alice", "identity fields survive");
    // The server must keep the full object internally for git operations.
    assert.strictEqual(client.userSession.personalAccessToken, "glpat-SECRET");
});

test("clientUserSessionPayload unit: trims, primitives pass through", () => {
    const f = ApiServer.clientUserSessionPayload;
    assert.deepStrictEqual(f({ _id: 1, phpSessionId: "x", personalAccessToken: "p", username: "u" }), {
        username: "u",
    });
    assert.strictEqual(f(null), null);
    assert.strictEqual(f("x"), "x");
});
