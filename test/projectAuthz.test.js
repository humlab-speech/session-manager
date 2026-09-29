const test = require("node:test");
const assert = require("node:assert");
const ApiServer = require("../src/ApiServer.class");

// canDeleteProject only uses the role helpers, so a bare prototype instance is enough.
const api = Object.create(ApiServer.prototype);

const project = {
    id: "p1",
    members: [
        { username: "owner", role: ApiServer.PROJECT_ROLE_PROJECT_ADMIN },
        { username: "helper", role: ApiServer.PROJECT_ROLE_RESEARCHER },
        { username: "legacy" }, // stored before project roles existed
    ],
};

test("project admins may delete their project", () => {
    assert.strictEqual(
        api.canDeleteProject(project, { username: "owner" }),
        true,
    );
});

test("researchers and legacy members may not", () => {
    assert.strictEqual(
        api.canDeleteProject(project, { username: "helper" }),
        false,
    );
    assert.strictEqual(
        api.canDeleteProject(project, { username: "legacy" }),
        false,
    );
});

test("non-members may not", () => {
    assert.strictEqual(
        api.canDeleteProject(project, { username: "stranger" }),
        false,
    );
    assert.strictEqual(api.canDeleteProject(project, undefined), false);
});

test("sysadmins may delete any project", () => {
    const admin = { username: "root_user", system_role: "sys_admin" };
    assert.strictEqual(
        api.isSysAdminUser(admin),
        true,
        "fixture must be a sysadmin",
    );
    assert.strictEqual(api.canDeleteProject(project, admin), true);
});
