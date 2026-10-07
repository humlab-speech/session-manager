const test = require("node:test");
const assert = require("node:assert");

// deleteProject removes the repository directory through rimraf; stub it
// BEFORE ApiServer.class is required so its destructure picks up the fake.
const {
    stubRimraf,
    fakeModels,
    createApiServer,
    wsRecorder,
} = require("../test-helpers/fake-mongoose.js");
const removedPaths = stubRimraf();

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
                ],
                sessions: [],
            },
        ],
    };
    const { models, deleted } = fakeModels(store);
    const api = createApiServer(ApiServer, {
        addLog: () => {},
        sessMan: { getContainerSessionsByProjectId: async () => ({}) },
    });
    api.mongoose = { model: (name) => models[name] };
    const ws = wsRecorder();
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
