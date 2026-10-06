const test = require("node:test");
const assert = require("node:assert");
const ApiServer = require("../src/ApiServer.class");

// Item codes name the recorded takes, so a session that already has recordings must
// keep the script they were made with. validateSessionScriptChanges needs only a
// project, the upload listing and the SPR session doc, so a prototype instance with
// fakes is enough.
function createContext({ files = [], uploads = [], sprSession = null } = {}) {
    const api = Object.create(ApiServer.prototype);
    api.app = { addLog: () => {} };
    api.fetchMongoProjectById = async () => ({
        id: "p1",
        sessions: [
            { id: "s1", name: "Session 1", files, sessionScript: "script-a" },
        ],
    });
    api.sprImportService = { listUploads: () => uploads };
    api.fetchSprSession = async () => sprSession;
    return api;
}

const formWith = (script) => ({
    id: "p1",
    sessions: [{ id: "s1", new: false, sessionScript: script }],
});

test("moving a session that has recordings to another script is refused", async () => {
    const api = createContext({
        files: [{ name: "prompt_1.wav", origin: "recording" }],
    });
    const errors = await api.validateSessionScriptChanges(formWith("script-b"));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Session 1/);
    assert.match(errors[0], /already has recordings made with another script/);
});

test("a take that has not been imported yet counts", async () => {
    const api = createContext({ uploads: ["prompt_1.wav"] });
    assert.equal(
        (await api.validateSessionScriptChanges(formWith("script-b"))).length,
        1,
    );
});

test("keeping the script, or having nothing recorded, is not refused", async () => {
    const recorded = createContext({
        files: [{ name: "prompt_1.wav", origin: "recording" }],
    });
    assert.deepEqual(
        await recorded.validateSessionScriptChanges(formWith("script-a")),
        [],
    );
    const empty = createContext({});
    assert.deepEqual(
        await empty.validateSessionScriptChanges(formWith("script-b")),
        [],
    );
});

test("an upload-only session can still change script", async () => {
    const api = createContext({
        files: [{ name: "my_recording.wav", origin: "upload" }],
    });
    assert.deepEqual(
        await api.validateSessionScriptChanges(formWith("script-b")),
        [],
    );
});

test("a new session has nothing to contradict", async () => {
    const api = createContext({
        files: [{ name: "prompt_1.wav", origin: "recording" }],
    });
    const form = formWith("script-b");
    form.sessions[0].new = true;
    assert.deepEqual(await api.validateSessionScriptChanges(form), []);
});

test("a session whose script cannot be established is not refused", async () => {
    const api = createContext({
        files: [{ name: "prompt_1.wav", origin: "recording" }],
    });
    api.fetchMongoProjectById = async () => ({
        id: "p1",
        sessions: [
            {
                id: "s1",
                name: "Session 1",
                files: [{ name: "prompt_1.wav", origin: "recording" }],
            },
        ],
    });
    assert.deepEqual(
        await api.validateSessionScriptChanges(formWith("script-b")),
        [],
    );
    // ...but the SPR session answers for records that predate sessionScript.
    api.fetchSprSession = async () => ({ script: "script-a" });
    assert.equal(
        (await api.validateSessionScriptChanges(formWith("script-b"))).length,
        1,
    );
});
