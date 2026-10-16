// Deleting a whole session (formSession.deleted in the save form) removes it
// from the project and drops its SPR session. Since 7ac00ef any member with
// editProjectFiles can save the dialog - so the session delete had to be
// gated separately, and it is gated like deleting a stored bundle or the
// project itself (ProjectAdmin/SysAdmin). Nothing may be written before the
// refusal.
const test = require("node:test");
const assert = require("node:assert");

const {
    fakeModels,
    createApiServer,
    wsRecorder,
} = require("../test-helpers/fake-mongoose.js");
const ApiServer = require("../src/ApiServer.class");

function createContext(role) {
    const projectDoc = {
        id: "p1",
        markModified() {},
        save: async () => {},
        members:
            role === null
                ? []
                : [{ username: "member_one", role: role }],
        sessions: [{ id: "s1", name: "Session One" }],
    };
    const { models } = fakeModels({ Project: [projectDoc] });
    const api = createApiServer(ApiServer);
    api.mongoose = { model: (name) => models[name] };
    api.projectRolesCache = Object.fromEntries(
        ApiServer.DEFAULT_PROJECT_ROLES.map((role) => [role.name, role]),
    );
    api.systemRolesCache = Object.fromEntries(
        ApiServer.DEFAULT_SYSTEM_ROLES.map((role) => [role.name, role]),
    );
    const state = { uploadsTouched: false, sessionsSaveTouched: false };
    api.prepareSessionUploads = async () => {
        state.uploadsTouched = true;
        return null; // makes updateProject stop right after the gate
    };
    api.saveSessionsMongo = async () => {
        state.sessionsSaveTouched = true;
    };
    const ws = wsRecorder();
    // sendProjectSaveFailure drops sends on a socket that is not OPEN.
    ws.readyState = 1;
    return { api, ws, project: projectDoc, state };
}

const deletedSessionForm = () => ({
    id: "p1",
    projectName: "Test Project",
    docFiles: [],
    sessions: [
        {
            id: "s1",
            name: "Session One",
            deleted: true,
            speakerAge: 30,
            speakerGender: null,
            dataSource: "upload",
        },
    ],
});

const update = (ctx, user) =>
    ctx.api.updateProject(ctx.ws, user, {
        cmd: "saveProject",
        requestId: "r1",
        project: deletedSessionForm(),
    });

test("a Researcher cannot delete a session; the save is refused before anything runs", async () => {
    const ctx = createContext(ApiServer.PROJECT_ROLE_RESEARCHER);
    await update(ctx, { username: "member_one" });
    assert.strictEqual(ctx.ws.sent.length, 1, JSON.stringify(ctx.ws.sent));
    assert.strictEqual(ctx.ws.sent[0].result, false);
    assert.match(ctx.ws.sent[0].message, /project admin/i);
    assert.strictEqual(ctx.state.uploadsTouched, false, "no upload handling");
    assert.strictEqual(
        ctx.state.sessionsSaveTouched,
        false,
        "sessions were not saved",
    );
    assert.strictEqual(ctx.project.sessions.length, 1, "session still listed");
});

test("a ProjectAdmin passes the gate", async () => {
    const ctx = createContext(ApiServer.PROJECT_ROLE_PROJECT_ADMIN);
    await update(ctx, { username: "member_one" });
    assert.strictEqual(ctx.state.uploadsTouched, true);
    assert.strictEqual(
        ctx.ws.sent.filter((m) => m.result === false).length,
        0,
        JSON.stringify(ctx.ws.sent),
    );
});

test("a SysAdmin passes the gate without being a member", async () => {
    const ctx = createContext(null);
    await update(ctx, { username: "root_user", system_role: "sys_admin" });
    assert.strictEqual(ctx.state.uploadsTouched, true);
});

test("a non-member still gets the save refusal, not a delete refusal", async () => {
    const ctx = createContext(ApiServer.PROJECT_ROLE_PROJECT_ADMIN);
    await update(ctx, { username: "mallory" });
    assert.strictEqual(ctx.ws.sent.length, 1);
    assert.strictEqual(ctx.ws.sent[0].result, false);
    assert.strictEqual(ctx.state.uploadsTouched, false);
    assert.strictEqual(ctx.state.sessionsSaveTouched, false);
});

test("saveSessionsMongo validates every id before deleting any", async () => {
    // The old order deleted as it walked, so a later bad id aborted after an
    // earlier session's SPR record was already dropped. Now the bad id is hit
    // in a first pass and the document is untouched.
    const projectDoc = {
        id: "p1",
        markModified() {},
        save: async () => {
            throw new Error("the document must not be saved");
        },
        sessions: [{ id: "s1" }, { id: "s2" }, { id: "s3" }],
    };
    const { models } = fakeModels({ Project: [projectDoc] });
    const api = createApiServer(ApiServer);
    api.mongoose = { model: (name) => models[name] };
    await assert.rejects(
        () =>
            api.saveSessionsMongo({
                id: "p1",
                sessions: [
                    { id: "s1", deleted: true },
                    { id: { $ne: null } },
                    { id: "s3" },
                ],
            }),
        /must be a string/,
    );
    assert.deepStrictEqual(
        projectDoc.sessions,
        [{ id: "s1" }, { id: "s2" }, { id: "s3" }],
        "the first session survived the refusal",
    );
});
