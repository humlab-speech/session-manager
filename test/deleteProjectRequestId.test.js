const test = require("node:test");
const assert = require("node:assert");

// deleteProject removes the repository directory through rimraf; stub it
// BEFORE ApiServer.class is required so its destructure picks up the fake.
const rimraf = require("rimraf");
const removedPaths = [];
rimraf.nativeSync = (p) => {
    removedPaths.push(p);
    return true;
};

const ApiServer = require("../src/ApiServer.class");

function createContext() {
    const deleted = [];
    const store = {
        Project: [
            {
                id: "p1",
                members: [
                    {
                        username: "alice",
                        role: ApiServer.PROJECT_ROLE_PROJECT_ADMIN,
                    },
                ],
                sessions: [],
            },
        ],
    };
    const models = {};
    for (const [name, docs] of Object.entries(store)) {
        class Model {
            static async findOne(q) {
                return docs.find((d) => d.id === q.id) ?? null;
            }
            static async deleteOne(q) {
                deleted.push(q.id);
            }
        }
        models[name] = Model;
    }
    const api = Object.create(ApiServer.prototype);
    api.mongoose = { model: (name) => models[name] };
    api.app = {
        addLog: () => {},
        sessMan: { getContainerSessionsByProjectId: async () => ({}) },
    };
    const ws = { sent: [], send: (m) => ws.sent.push(JSON.parse(m)) };
    return { api, ws, deleted, removedPaths };
}

test("deleteProject success replies all carry the requestId (UI correlation)", async () => {
    const { api, ws, deleted, removedPaths } = createContext();
    await api.deleteProject(ws, { username: "alice" }, {
        cmd: "deleteProject",
        requestId: "r42",
        data: { project: { id: "p1" } },
    });
    assert.ok(ws.sent.length >= 2, "progress + end expected");
    assert.strictEqual(ws.sent.at(-1).progress, "end");
    assert.strictEqual(ws.sent.at(-1).result, true);
    assert.deepStrictEqual(deleted, ["p1"]);
    assert.deepStrictEqual(removedPaths, ["/repositories/p1"]);
    for (const s of ws.sent) {
        assert.strictEqual(
            s.requestId,
            "r42",
            "every deleteProject reply must carry the requestId: " +
                JSON.stringify(s),
        );
    }
});
