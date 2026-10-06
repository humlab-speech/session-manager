const test = require("node:test");
const assert = require("node:assert");

// deleteBundle removes directories through rimraf; stub it BEFORE
// ApiServer.class is required so its module-level destructure picks up the
// fake. No test may touch a real /repositories path.
const rimraf = require("rimraf");
const removedPaths = [];
rimraf.nativeSync = (p) => {
    removedPaths.push(p);
    return true;
};

const ApiServer = require("../src/ApiServer.class");

function createContext() {
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
                sessions: [{ id: "s1", name: "ses1", files: [{ name: "b1" }] }],
            },
        ],
    };
    const writes = [];
    const models = {};
    for (const [name, docs] of Object.entries(store)) {
        class Model {
            static async findOne(q) {
                return docs.find((d) => matches(d, q)) ?? null;
            }
            static async updateOne(q, u) {
                writes.push([q, u]);
            }
        }
        models[name] = Model;
    }
    const api = Object.create(ApiServer.prototype);
    api.mongoose = { model: (name) => models[name] };
    api.app = { addLog: () => {} };
    api.sprImportService = { markUploadsImported: async () => {} };
    const ws = { sent: [], send: (m) => ws.sent.push(JSON.parse(m)) };
    return { api, ws, store, writes, removedPaths };
}

// strict equality matching: an object-shaped query value ({ $ne: ... }) matches
// nothing, like the real driver does for { id: { $ne: null } } on a string field.
function matches(doc, q) {
    return Object.entries(q).every(([k, v]) => doc[k] === v);
}

const denied = (ws, why) =>
    ws.sent.length === 1 &&
    ws.sent[0].result === false &&
    ws.sent[0].requestId === "r1" &&
    ws.sent[0].message.includes(why);

const payload = (extra) => ({
    cmd: "deleteBundle",
    requestId: "r1",
    data: { projectId: "p1", sessionId: "s1", fileName: "b1", ...extra },
});

test("deleteBundle: non-member is refused and nothing is deleted", async () => {
    const { api, ws, writes, removedPaths } = createContext();
    await api.deleteBundle(ws, { username: "mallory" }, payload());
    assert.ok(
        denied(ws, "not authorized to delete bundles"),
        "must be refused, got: " + JSON.stringify(ws.sent),
    );
    assert.strictEqual(writes.length, 0, "no DB write may land");
    assert.strictEqual(removedPaths.length, 0, "no path may be removed");
});

test("deleteBundle: a plain member (researcher) is refused - destructive op needs admin", async () => {
    const { api, ws, writes, removedPaths } = createContext();
    await api.deleteBundle(ws, { username: "bob" }, payload());
    assert.ok(
        denied(ws, "not authorized to delete bundles"),
        "must be refused, got: " + JSON.stringify(ws.sent),
    );
    assert.strictEqual(writes.length, 0);
    assert.strictEqual(removedPaths.length, 0);
});

test("deleteBundle: object-shaped ids are refused before any lookup", async () => {
    const { api, ws, writes, removedPaths } = createContext();
    await api.deleteBundle(ws, { username: "alice" }, payload({ projectId: { $ne: null } }));
    assert.ok(denied(ws, "must be strings"), JSON.stringify(ws.sent));
    assert.strictEqual(writes.length, 0);
    assert.strictEqual(removedPaths.length, 0);
});

test("deleteBundle: missing msg.data gets an error reply, not a hanging rejection", async () => {
    const { api, ws, writes, removedPaths } = createContext();
    await api.deleteBundle(ws, { username: "alice" }, { cmd: "deleteBundle", requestId: "r1" });
    assert.ok(denied(ws, "must be strings"), JSON.stringify(ws.sent));
    assert.strictEqual(writes.length, 0);
    assert.strictEqual(removedPaths.length, 0);
});

test("deleteBundle: positive control - project admin of the project still deletes", async () => {
    const { api, ws, writes, removedPaths } = createContext();
    await api.deleteBundle(ws, { username: "alice" }, payload());
    assert.strictEqual(ws.sent[0].message, "Success");
    assert.strictEqual(ws.sent[0].requestId, "r1");
    assert.strictEqual(removedPaths.length, 1);
    assert.ok(removedPaths[0].startsWith("/repositories/p1/"));
    assert.strictEqual(writes.length, 1);
});
