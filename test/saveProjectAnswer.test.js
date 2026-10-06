const test = require("node:test");
const assert = require("node:assert");
const ApiServer = require("../src/ApiServer.class");

// The contract: one saveProject frame gets exactly one progress:end, and that
// frame says whether the project was stored. Before this was pinned, an
// incomplete save fell through to the success branch and answered "Done", and a
// callee that had already answered was followed by a second end for the same
// request. None of that needs Mongo - the steps below the stubs are the parts
// that would.
function fakeApi(saveProjectEmuDbResult, hooks = {}) {
    const sends = [];
    const api = Object.create(ApiServer.prototype);
    api.app = { addLog: () => {} };
    api.validateProjectForm = () => true;
    api.prepareSessionUploads = async () => ({});
    api.saveAnnotationLevelsMongo = async () => {};
    api.writeProjectMetadataFile = async () => {};
    api.saveSessionsMongo = async () => {};
    api.saveProjectEmuDb = async () => {
        if (hooks.onCall) hooks.onCall();
        return saveProjectEmuDbResult;
    };
    for (const [name, fn] of Object.entries(hooks)) {
        if (name !== "onCall") api[name] = fn;
    }
    const ws = { readyState: 1, send: (m) => sends.push(JSON.parse(m)) };
    return { api, sends, ws };
}

const msg = { requestId: "r1", cmd: "saveProject", project: { id: "p1" } };
const ends = (sends) => sends.filter((s) => s.progress === "end");

test("a save that stopped early answers exactly one end, and it says failure", async () => {
    for (const early of [undefined, "undefined from a bare return"]) {
        const { api, sends, ws } = fakeApi(early);
        await api.updateProject(ws, {}, msg);
        const got = ends(sends);
        assert.equal(got.length, 1, JSON.stringify(sends));
        assert.equal(got[0].result, false);
        assert.equal(got[0].requestId, "r1");
    }
});

test("a callee that already answered is not followed by a second end", async () => {
    const { api, sends, ws } = fakeApi(false);
    await api.updateProject(ws, {}, msg);
    assert.equal(ends(sends).length, 0);
});

test("a save that completed answers one end", async () => {
    const { api, sends, ws } = fakeApi(true);
    await api.updateProject(ws, {}, msg);
    const got = ends(sends);
    assert.equal(got.length, 1);
    assert.ok(got[0].result, "the end of a successful save must be truthy");
});

test("a form that fails validation answers instead of leaving the client waiting", async () => {
    const { api, sends, ws } = fakeApi(true, {
        validateProjectForm: () => false,
    });
    await api.updateProject(ws, {}, msg);
    const got = ends(sends);
    assert.equal(got.length, 1);
    assert.equal(got[0].result, false);
});
