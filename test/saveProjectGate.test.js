// saveProject is ONE entry point for TWO different permissions:
//   create  -> the system permission createProjects (sys_admin only), as the
//              two-tier role split intended ("project creation is now
//              sysadmin-only", scripts/migrate-permissions.py)
//   edit    -> the project-scoped editProjectFiles that ProjectAdmin and
//              Researcher hold, checked against the server's own project
//              document
// The branch came first only AFTER the create gate, so editing was gated by
// creating: a Researcher could never save a project they belonged to, while
// updateProject itself checked no membership at all. These tests pin both
// directions - members of the named project get through, everyone else does
// not - because a regression either way is silent to the rest of the suite.
const test = require("node:test");
const assert = require("node:assert");

const ApiServer = require("../src/ApiServer.class");
const {
    fakeModels,
    createApiServer,
} = require("../test-helpers/fake-mongoose.js");

const PROJECTS = [
    {
        id: "p1",
        members: [
            { username: "owner_one", role: ApiServer.PROJECT_ROLE_PROJECT_ADMIN },
            { username: "helper_one", role: ApiServer.PROJECT_ROLE_RESEARCHER },
        ],
    },
    {
        id: "p2",
        members: [
            { username: "owner_two", role: ApiServer.PROJECT_ROLE_PROJECT_ADMIN },
        ],
    },
];

function context() {
    const { models } = fakeModels({ Project: PROJECTS.map((p) => ({ ...p })) });
    const api = createApiServer(ApiServer);
    api.mongoose = { model: (name) => models[name] };
    // The real constructor seeds this from the database at boot; getProject-
    // Permissions reads the role flags straight out of the cache.
    api.projectRolesCache = Object.fromEntries(
        ApiServer.DEFAULT_PROJECT_ROLES.map((role) => [role.name, role]),
    );
    api.systemRolesCache = Object.fromEntries(
        ApiServer.DEFAULT_SYSTEM_ROLES.map((role) => [role.name, role]),
    );
    // The two workhorses are stubbed: this test is about which door you are
    // allowed through, not about what happens behind it.
    const calls = [];
    api.updateProject = async (ws, user, msg) =>
        calls.push({ cmd: "update", user: user.username, id: msg.project.id });
    api.createProject = async (ws, user) =>
        calls.push({ cmd: "create", user: user.username });
    const ws = { readyState: 1, sent: [], send: (m) => ws.sent.push(JSON.parse(m)) };
    return { api, ws, calls };
}

const save = async (ctx, user, project) =>
    await ctx.api.saveProject(ctx.ws, user, { cmd: "saveProject", requestId: "r1", project });

const refused = (ctx) =>
    ctx.ws.sent.length === 1 &&
    ctx.ws.sent[0].result === false &&
    ctx.ws.sent[0].progress === "end" &&
    ctx.ws.sent[0].cmd === "saveProject" &&
    ctx.ws.sent[0].requestId === "r1";

test("a Researcher saves a project they belong to", async () => {
    const ctx = context();
    await save(ctx, { username: "helper_one" }, { id: "p1", name: "Edited" });
    assert.deepStrictEqual(ctx.calls, [
        { cmd: "update", user: "helper_one", id: "p1" },
    ]);
    assert.strictEqual(ctx.ws.sent.length, 0, "no refusal for an allowed save");
});

test("a ProjectAdmin saves their project", async () => {
    const ctx = context();
    await save(ctx, { username: "owner_one" }, { id: "p1" });
    assert.strictEqual(ctx.calls.length, 1);
    assert.strictEqual(ctx.calls[0].cmd, "update");
});

test("a member of one project cannot save another", async () => {
    const ctx = context();
    await save(ctx, { username: "helper_one" }, { id: "p2", name: "Not mine" });
    assert.deepStrictEqual(ctx.calls, [], "nothing was written anywhere");
    assert.ok(refused(ctx), "exactly one terminal failure frame");
});

test("a stranger cannot save a project", async () => {
    const ctx = context();
    await save(ctx, { username: "nobody" }, { id: "p1" });
    assert.deepStrictEqual(ctx.calls, []);
    assert.ok(refused(ctx));
});

test("a sysadmin edits any project and creates new ones", async () => {
    const admin = { username: "root_user", system_role: "sys_admin" };

    const edit = context();
    await save(edit, admin, { id: "p2" });
    assert.deepStrictEqual(edit.calls, [
        { cmd: "update", user: "root_user", id: "p2" },
    ]);

    const create = context();
    await save(create, admin, { name: "Fresh" });
    assert.deepStrictEqual(create.calls, [{ cmd: "create", user: "root_user" }]);
});

test("creating a project stays sysadmin-only", async () => {
    for (const user of [{ username: "owner_one" }, { username: "helper_one" }]) {
        const ctx = context();
        await save(ctx, user, { name: "Trying to create" });
        assert.deepStrictEqual(ctx.calls, []);
        assert.ok(refused(ctx), user.username + " was refused");
        assert.match(ctx.ws.sent[0].message, /create/i);
    }
});

test("an unknown project id says exactly what a foreign one says", async () => {
    // Same refusal for "no such project" and "not yours to edit": being able to
    // tell those apart turns a save into an id enumerator.
    const missing = context();
    await save(missing, { username: "helper_one" }, { id: "nosuchproject" });
    const foreign = context();
    await save(foreign, { username: "helper_one" }, { id: "p2" });
    assert.deepStrictEqual(missing.calls, []);
    assert.deepStrictEqual(foreign.calls, []);
    assert.strictEqual(missing.ws.sent[0].message, foreign.ws.sent[0].message);
});

test("an object-shaped id is refused, not looked up", async () => {
    const ctx = context();
    await save(ctx, { username: "helper_one" }, { id: { $ne: null } });
    assert.deepStrictEqual(ctx.calls, []);
    assert.strictEqual(ctx.ws.sent.length, 1, "answered, and answered once");
    assert.strictEqual(ctx.ws.sent[0].result, false);
});

test("a frame with no project form still gets an answer", async () => {
    const ctx = context();
    await ctx.api.saveProject(ctx.ws, { username: "helper_one" }, {
        cmd: "saveProject",
        requestId: "r1",
    });
    assert.deepStrictEqual(ctx.calls, []);
    assert.strictEqual(ctx.ws.sent.length, 1);
    assert.strictEqual(ctx.ws.sent[0].result, false);
});
