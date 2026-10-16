const test = require("node:test");
const assert = require("node:assert");
const ApiServer = require("../src/ApiServer.class");
const { createApiServer } = require("../test-helpers/fake-mongoose.js");

// Item codes name the recorded takes, so a session that already has recordings must
// keep the script they were made with. validateSessionScriptChanges needs only a
// project, the upload listing and the SPR session doc, so a prototype instance with
// fakes is enough.
function createContext({ files = [], uploads = [], sprSession = null } = {}) {
    const api = createApiServer(ApiServer);
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

// A disabled form control drops its value from the group, so a session that must keep
// its script can arrive without one. The write below the validator is unconditional,
// so "treat the omission as no change" here would still clear mongo and the SPR doc.
const recordedFiles = [{ name: "prompt_1.wav", origin: "recording" }];

test("a recorded session whose save omits the script is refused", async () => {
    const api = createContext({ files: recordedFiles });
    for (const omitted of [undefined, null, ""]) {
        const errors = await api.validateSessionScriptChanges(formWith(omitted));
        assert.equal(errors.length, 1, `expected a refusal for ${String(omitted)}`);
        assert.match(errors[0], /Session 1/);
        assert.match(errors[0], /without its recording script/);
        assert.match(errors[0], /Reload this page/);
    }
});

test("a session with no recordings may be saved without a script", async () => {
    const api = createContext({});
    assert.deepEqual(await api.validateSessionScriptChanges(formWith(undefined)), []);
});

test("nothing is refused when no script is stored either", async () => {
    const api = createContext({ files: recordedFiles });
    api.fetchMongoProjectById = async () => ({
        id: "p1",
        sessions: [{ id: "s1", name: "Session 1", files: recordedFiles }],
    });
    assert.deepEqual(await api.validateSessionScriptChanges(formWith(undefined)), []);
});

test("deleting a recorded session does not need the script in the payload", async () => {
    const api = createContext({ files: recordedFiles });
    const form = formWith(undefined);
    form.sessions[0].deleted = true;
    assert.deepEqual(await api.validateSessionScriptChanges(form), []);
});
