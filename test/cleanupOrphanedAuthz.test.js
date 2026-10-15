const test = require("node:test");
const assert = require("node:assert");

// cleanupOrphanedSessions deletes EmuDB session directories from disk and marks
// MongoDB sessions deleted. The dispatcher handed it `msg.data.projectId` and
// nothing else — no user, so no permission check — which meant any logged-in
// connection could name a foreign project id and purge recordings from it.
// Removing session directories is as destructive as removing a bundle, so it
// takes the same rule: canDeleteProject (ProjectAdmin of that project, or
// SysAdmin). The check lives inside the handler, so a caller that forgets to
// pass a user is refused rather than silently trusted.
const fs = require("fs-extra");

const touched = [];
const removed = [];
const originals = {
    existsSync: fs.existsSync,
    readdirSync: fs.readdirSync,
    statSync: fs.statSync,
    removeSync: fs.removeSync,
};

// One EmuDB directory on disk that no MongoDB session knows about: exactly what
// a cleanup removes. Nothing under /repositories is ever touched.
function stubDisk() {
    touched.length = 0;
    removed.length = 0;
    fs.existsSync = (p) => {
        touched.push(p);
        return true;
    };
    fs.readdirSync = (p) => {
        touched.push(p);
        return ["Ghost_ses"];
    };
    fs.statSync = (p) => {
        touched.push(p);
        return { isDirectory: () => true };
    };
    fs.removeSync = (p) => {
        removed.push(p);
    };
}

function unstubDisk() {
    Object.assign(fs, originals);
}

const {
    fakeModels,
    createApiServer,
} = require("../test-helpers/fake-mongoose.js");
const ApiServer = require("../src/ApiServer.class");

function createContext() {
    const saves = [];
    const { models, writes } = fakeModels({
        Project: [
            {
                id: "p1",
                // The project document is mutated and saved in place.
                markModified() {},
                save: async () => {
                    saves.push("sessions");
                },
                members: [
                    {
                        username: "owner_one",
                        role: ApiServer.PROJECT_ROLE_PROJECT_ADMIN,
                    },
                    {
                        username: "helper_one",
                        role: ApiServer.PROJECT_ROLE_RESEARCHER,
                    },
                ],
                sessions: [{ id: "s1", name: "Session 1" }],
            },
        ],
    });
    const api = createApiServer(ApiServer);
    api.mongoose = { model: (name) => models[name] };
    return { api, writes, saves };
}

const refused = (result) =>
    result.success === false &&
    result.removed.length === 0 &&
    result.errors.some((e) => /not authorized/i.test(e));

test("cleanupOrphanedSessions: a non-member is refused and the disk is never touched", async () => {
    stubDisk();
    try {
        const { api, writes, saves } = createContext();
        const result = await api.cleanupOrphanedSessions("p1", {
            username: "mallory",
        });
        assert.ok(refused(result), "must be refused, got: " + JSON.stringify(result));
        assert.deepStrictEqual(touched, [], "no filesystem access at all");
        assert.deepStrictEqual(removed, [], "nothing may be removed");
        assert.deepStrictEqual(saves, [], "nothing may be saved");
        assert.deepStrictEqual(writes, [], "nothing may be written");
    } finally {
        unstubDisk();
    }
});

test("cleanupOrphanedSessions: a Researcher is refused - removing sessions needs admin", async () => {
    stubDisk();
    try {
        const { api } = createContext();
        const result = await api.cleanupOrphanedSessions("p1", {
            username: "helper_one",
        });
        assert.ok(refused(result), "must be refused, got: " + JSON.stringify(result));
        assert.deepStrictEqual(removed, []);
    } finally {
        unstubDisk();
    }
});

test("cleanupOrphanedSessions: no user at all is refused, not trusted", async () => {
    stubDisk();
    try {
        const { api } = createContext();
        const result = await api.cleanupOrphanedSessions("p1", undefined);
        assert.ok(refused(result), "must be refused, got: " + JSON.stringify(result));
        assert.deepStrictEqual(removed, []);
    } finally {
        unstubDisk();
    }
});

test("cleanupOrphanedSessions: the project's own ProjectAdmin still cleans up", async () => {
    stubDisk();
    try {
        const { api } = createContext();
        const result = await api.cleanupOrphanedSessions("p1", {
            username: "owner_one",
        });
        assert.strictEqual(result.success, true, JSON.stringify(result));
        assert.deepStrictEqual(removed, ["/repositories/p1/Data/VISP_emuDB/Ghost_ses"]);
    } finally {
        unstubDisk();
    }
});

test("cleanupOrphanedSessions: a SysAdmin may clean up any project", async () => {
    stubDisk();
    try {
        const { api } = createContext();
        const result = await api.cleanupOrphanedSessions("p1", {
            username: "root_user",
            system_role: "sys_admin",
        });
        assert.strictEqual(result.success, true, JSON.stringify(result));
        assert.strictEqual(removed.length, 1);
    } finally {
        unstubDisk();
    }
});
