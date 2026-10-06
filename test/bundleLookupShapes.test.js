const test = require("node:test");
const assert = require("node:assert");

// Nothing here may delete real paths: stub rimraf BEFORE ApiServer.class is
// required so its module-level destructure picks up the fake.
const rimraf = require("rimraf");
rimraf.nativeSync = () => true;

const ApiServer = require("../src/ApiServer.class");

// findOne can be armed to throw (simulated database outage).
function createContext({ boom = null } = {}) {
    const logs = [];
    const store = {
        Project: [
            {
                id: "p1",
                members: [
                    {
                        username: "alice",
                        role: ApiServer.PROJECT_ROLE_PROJECT_ADMIN,
                    },
                    {
                        username: "bob",
                        role: ApiServer.PROJECT_ROLE_RESEARCHER,
                    },
                ],
                sessions: [{ id: "s1", name: "ses1", files: [] }],
            },
        ],
        BundleList: [],
    };
    const models = {};
    for (const [name, docs] of Object.entries(store)) {
        class Model {
            constructor(fields) {
                Object.assign(this, fields);
            }
            save() {
                if (!docs.includes(this)) docs.push(this);
            }
            static async findOne(q, proj) {
                if (boom) throw boom;
                const doc = docs.find((d) => matches(d, q)) ?? null;
                // honor a sessions.$elemMatch projection like the real driver
                if (doc && proj?.sessions?.$elemMatch?.id !== undefined) {
                    const want = proj.sessions.$elemMatch.id;
                    return {
                        ...doc,
                        sessions: (doc.sessions ?? []).filter(
                            (s) => s && s.id === want,
                        ),
                    };
                }
                return doc;
            }
            static async deleteOne(q) {}
        }
        models[name] = Model;
    }
    const api = Object.create(ApiServer.prototype);
    api.mongoose = { model: (name) => models[name] };
    api.app = {
        addLog: (m, level) => logs.push([level, String(m)]),
        sessMan: { getContainerSessionsByProjectId: async () => ({}) },
    };
    const ws = { sent: [], send: (m) => ws.sent.push(JSON.parse(m)) };
    return { api, ws, store, logs };
}

function matches(doc, q) {
    return Object.entries(q).every(([k, v]) => doc[k] === v);
}

const oneSettledReply = (ws, cmd, requestId) =>
    ws.sent.length === 1 &&
    ws.sent[0].cmd === cmd &&
    ws.sent[0].requestId === requestId &&
    ws.sent[0].progress === "end" &&
    ws.sent[0].result === false;

const dl = (data, requestId = "r1") => ({
    cmd: "downloadBundle",
    requestId,
    data,
});

for (const [label, data] of [
    ["missing msg.data", undefined],
    [
        "numeric projectId",
        { projectId: 123456, sessionId: "s1", fileName: "b" },
    ],
    [
        "object-shaped projectId",
        { projectId: { $ne: null }, sessionId: "s1", fileName: "b" },
    ],
    ["null sessionId", { projectId: "p1", sessionId: null, fileName: "b" }],
]) {
    test(`downloadBundle: ${label} settles with an error reply, not silence`, async () => {
        const { api, ws } = createContext();
        await api.downloadBundle(ws, { username: "mallory" }, dl(data));
        assert.ok(
            oneSettledReply(ws, "downloadBundle", "r1"),
            JSON.stringify(ws.sent),
        );
    });
}

test("downloadBundle: unknown-but-string project id is an honest not-found reply", async () => {
    const { api, ws } = createContext();
    await api.downloadBundle(
        ws,
        { username: "mallory" },
        dl({ projectId: "does-not-exist", sessionId: "s1", fileName: "b" }),
    );
    assert.ok(
        oneSettledReply(ws, "downloadBundle", "r1"),
        JSON.stringify(ws.sent),
    );
    assert.match(ws.sent[0].message, /not find/i);
});

test("downloadBundle: member + existing project but missing session replies too (no hang)", async () => {
    const { api, ws } = createContext();
    await api.downloadBundle(
        ws,
        { username: "bob" },
        dl({ projectId: "p1", sessionId: "nope", fileName: "b" }),
    );
    assert.ok(
        oneSettledReply(ws, "downloadBundle", "r1"),
        JSON.stringify(ws.sent),
    );
    assert.match(ws.sent[0].message, /not find/i);
});

test("downloadBundle: database outage is logged as an error and replies distinctly", async () => {
    const boom = new Error("MongoServerSelectionError: connection timed out");
    const { api, ws, logs } = createContext({ boom });
    await api.downloadBundle(
        ws,
        { username: "bob" },
        dl({ projectId: "p1", sessionId: "s1", fileName: "b" }),
    );
    assert.ok(
        oneSettledReply(ws, "downloadBundle", "r1"),
        JSON.stringify(ws.sent),
    );
    // real error must not masquerade as a deny/not-found:
    assert.match(ws.sent[0].message, /error looking up/i);
    assert.ok(
        logs.some(
            ([lvl, m]) =>
                lvl === "error" && m.includes("MongoServerSelectionError"),
        ),
        "the real error must be logged: " + JSON.stringify(logs),
    );
});

test("downloadBundle: positive control - member with all-valid shapes is not denied by the new code", async () => {
    const { api, ws } = createContext();
    await api.downloadBundle(
        ws,
        { username: "bob" },
        dl({ projectId: "p1", sessionId: "s1", fileName: "b" }),
    );
    // the bundle dir does not exist on the test host, so the honest outcome is
    // "directory does not exist", NOT a malformed/not-found/error message:
    assert.strictEqual(ws.sent.length, 1);
    assert.match(ws.sent[0].message, /directory does not exist/i);
});

test("deleteProject: missing msg.data settles with the refusal reply", async () => {
    const { api, ws } = createContext();
    await api.deleteProject(
        ws,
        { username: "bob" },
        { cmd: "deleteProject", requestId: "x1" },
    );
    assert.ok(
        oneSettledReply(ws, "deleteProject", "x1"),
        JSON.stringify(ws.sent),
    );
});

test("deleteProject: database outage is logged and replied, not left hanging", async () => {
    const { api, ws, logs } = createContext({ boom: new Error("db down") });
    await api.deleteProject(
        ws,
        { username: "bob" },
        {
            cmd: "deleteProject",
            requestId: "x2",
            data: { project: { id: "p1" } },
        },
    );
    assert.ok(
        oneSettledReply(ws, "deleteProject", "x2"),
        JSON.stringify(ws.sent),
    );
    assert.match(ws.sent[0].message, /error looking up/i);
    assert.ok(logs.some(([l, m]) => l === "error" && m.includes("db down")));
});

test("fetchBundleList: database outage is logged and replied, not left hanging", async () => {
    const { api, ws, logs } = createContext({ boom: new Error("db down") });
    await api.fetchBundleList(
        ws,
        { username: "bob" },
        {
            cmd: "fetchBundleList",
            requestId: "f1",
            projectId: "p1",
        },
    );
    assert.ok(
        oneSettledReply(ws, "fetchBundleList", "f1"),
        JSON.stringify(ws.sent),
    );
    assert.match(ws.sent[0].message, /error looking up/i);
    assert.ok(logs.some(([l, m]) => l === "error" && m.includes("db down")));
});

test("fetchBundleList: malformed/unknown projectId keeps the clean refusal reply", async () => {
    const { api, ws } = createContext();
    await api.fetchBundleList(
        ws,
        { username: "bob" },
        {
            cmd: "fetchBundleList",
            requestId: "f2",
            projectId: { $ne: null },
        },
    );
    assert.ok(
        oneSettledReply(ws, "fetchBundleList", "f2"),
        JSON.stringify(ws.sent),
    );
});
