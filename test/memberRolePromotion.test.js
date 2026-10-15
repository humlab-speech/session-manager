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
