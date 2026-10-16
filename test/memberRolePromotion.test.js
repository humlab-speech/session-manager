const test = require("node:test");
const assert = require("node:assert");

// setProjectMemberRole gated on manageProjectMembers — a permission the seeded
// Researcher role holds — and then assigned whatever valid role name arrived.
// So a Researcher could hand themselves project_admin, which additionally buys
// createInviteCodes: the ability to invite anyone into the project. Managing
// members stays a Researcher right; granting the admin role does not.
const {
    fakeModels,
    createApiServer,
    wsRecorder,
} = require("../test-helpers/fake-mongoose.js");
const ApiServer = require("../src/ApiServer.class");

function createContext() {
    const saves = [];
    // The project document is mutated and saved in place.
    const projectDoc = {
        id: "p1",
        markModified() {},
        save: async () => {
            saves.push("members");
        },
        members: [
            { username: "owner_one", role: ApiServer.PROJECT_ROLE_PROJECT_ADMIN },
            { username: "helper_one", role: ApiServer.PROJECT_ROLE_RESEARCHER },
            { username: "newcomer_one", role: ApiServer.PROJECT_ROLE_RESEARCHER },
        ],
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
    return { api, ws: wsRecorder(), project: projectDoc, saves };
}

const setRole = (ctx, user, username, role) =>
    ctx.api.setProjectMemberRole(ctx.ws, user, {
        cmd: "setProjectMemberRole",
        requestId: "r1",
        projectId: "p1",
        username,
        role,
    });

const roleOf = (ctx, username) =>
    ctx.project.members.find((m) => m.username === username).role;

const refused = (ctx) =>
    ctx.ws.sent.length === 1 &&
    ctx.ws.sent[0].result === false &&
    ctx.ws.sent[0].requestId === "r1";

test("a Researcher cannot promote themselves to Project Admin", async () => {
    const ctx = createContext();
    await setRole(ctx, { username: "helper_one" }, "helper_one", "project_admin");
    assert.ok(refused(ctx), "must be refused, got: " + JSON.stringify(ctx.ws.sent));
    assert.strictEqual(
        roleOf(ctx, "helper_one"),
        ApiServer.PROJECT_ROLE_RESEARCHER,
        "the role was not assigned",
    );
    assert.deepStrictEqual(ctx.saves, [], "nothing was saved");
});

test("a Researcher cannot promote anyone else to Project Admin either", async () => {
    const ctx = createContext();
    await setRole(ctx, { username: "helper_one" }, "newcomer_one", "project_admin");
    assert.ok(refused(ctx), JSON.stringify(ctx.ws.sent));
    assert.strictEqual(roleOf(ctx, "newcomer_one"), ApiServer.PROJECT_ROLE_RESEARCHER);
});

test("a Researcher still changes ordinary member roles", async () => {
    const ctx = createContext();
    await setRole(ctx, { username: "helper_one" }, "newcomer_one", "researcher");
    assert.strictEqual(ctx.ws.sent[0].result, true, JSON.stringify(ctx.ws.sent));
    assert.strictEqual(roleOf(ctx, "newcomer_one"), ApiServer.PROJECT_ROLE_RESEARCHER);
});

test("a ProjectAdmin may promote a member, and a SysAdmin may promote anyone", async () => {
    const byAdmin = createContext();
    await setRole(byAdmin, { username: "owner_one" }, "newcomer_one", "project_admin");
    assert.strictEqual(byAdmin.ws.sent[0].result, true, JSON.stringify(byAdmin.ws.sent));
    assert.strictEqual(roleOf(byAdmin, "newcomer_one"), ApiServer.PROJECT_ROLE_PROJECT_ADMIN);

    const bySysAdmin = createContext();
    await setRole(
        bySysAdmin,
        { username: "root_user", system_role: "sys_admin" },
        "helper_one",
        "project_admin",
    );
    assert.strictEqual(bySysAdmin.ws.sent[0].result, true, JSON.stringify(bySysAdmin.ws.sent));
    assert.strictEqual(roleOf(bySysAdmin, "helper_one"), ApiServer.PROJECT_ROLE_PROJECT_ADMIN);
});

test("a non-member still gets the plain membership refusal", async () => {
    const ctx = createContext();
    await setRole(ctx, { username: "mallory" }, "newcomer_one", "project_admin");
    assert.ok(refused(ctx), JSON.stringify(ctx.ws.sent));
    assert.strictEqual(roleOf(ctx, "newcomer_one"), ApiServer.PROJECT_ROLE_RESEARCHER);
});

// The same ceiling had to be applied to addProjectMember: it gated on
// manageProjectMembers (a Researcher right) and then pushed whatever valid role
// name arrived, so it was the way around the rule above. It also turned an
// unknown role into a silent Researcher instead of refusing it.
const addMember = (ctx, user, username, role) =>
    ctx.api.addProjectMember(ctx.ws, user, {
        cmd: "addProjectMember",
        requestId: "r1",
        projectId: "p1",
        username,
        role,
    });

test("a Researcher cannot add someone as Project Admin", async () => {
    const ctx = createContext();
    await addMember(ctx, { username: "helper_one" }, "stranger_one", "project_admin");
    assert.ok(refused(ctx), "must be refused, got: " + JSON.stringify(ctx.ws.sent));
    assert.ok(
        !ctx.project.members.some((m) => m.username === "stranger_one"),
        "the member was added anyway",
    );
    assert.deepStrictEqual(ctx.saves, [], "nothing was saved");
});

test("refusal happens before the User collection is queried", async () => {
    // The guard sits ahead of the lookup on purpose, so this model is absent:
    // reaching for it is the proof that the order held.
    const ctx = createContext();
    const inner = ctx.api.mongoose;
    ctx.api.mongoose = {
        model: (name) => {
            if (name !== "Project") throw new Error("queried " + name);
            return inner.model(name);
        },
    };
    await addMember(ctx, { username: "helper_one" }, "stranger_one", "project_admin");
    assert.ok(refused(ctx), JSON.stringify(ctx.ws.sent));
});

test("an unknown role is refused, not silently made a Researcher", async () => {
    const ctx = createContext();
    await addMember(ctx, { username: "owner_one" }, "stranger_one", "super_user");
    assert.ok(refused(ctx), JSON.stringify(ctx.ws.sent));
    assert.ok(!ctx.project.members.some((m) => m.username === "stranger_one"));
});

test("a non-member cannot learn who is already in the project", async () => {
    // Ordering matters twice over: answering "already a member" before the
    // permission check hands a stranger a membership oracle, and reading
    // project.members before it is initialised throws on an old document.
    const ctx = createContext();
    const models = ctx.api.mongoose;
    // The account being added has to resolve — the code looks it up before
    // deciding anything.
    ctx.api.mongoose = {
        model: (name) =>
            name === "User"
                ? fakeModels({ User: [{ username: "newcomer_one" }] }).models.User
                : models.model(name),
    };

    await addMember(ctx, { username: "outsider_one" }, "newcomer_one", "researcher");
    assert.ok(refused(ctx), JSON.stringify(ctx.ws.sent));
    assert.match(ctx.ws.sent[0].message ?? "", /not authorized/);

    delete ctx.project.members;
    ctx.ws.sent.length = 0;
    await addMember(ctx, { username: "outsider_one" }, "newcomer_one", "researcher");
    assert.ok(refused(ctx), "a members-less document must still be refused, not crash");
});
