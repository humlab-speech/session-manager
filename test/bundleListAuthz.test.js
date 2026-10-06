const test = require("node:test");
const assert = require("node:assert");
const {
    fakeModels,
    createApiServer,
    wsRecorder,
} = require("../test-helpers/fake-mongoose.js");
const ApiServer = require("../src/ApiServer.class");

// fetchBundleList/saveBundleLists only need mongoose.model(), app.addLog() and
// the authz helpers, so a bare prototype instance with fakes is enough.
function createContext() {
    const store = {
        Project: [
            {
                id: "p1",
                members: [
                    { username: "alice", role: ApiServer.PROJECT_ROLE_PROJECT_ADMIN },
                    { username: "bob", role: ApiServer.PROJECT_ROLE_RESEARCHER },
                ],
            },
        ],
        User: [{ username: "alice" }, { username: "bob" }, { username: "mallory" }],
        BundleList: [],
    };
    const { models } = fakeModels(store);
    const api = createApiServer(ApiServer);
    api.mongoose = { model: (name) => models[name] };
    const ws = wsRecorder();
    return { api, ws, store };
}

const refused = (ws) =>
    ws.sent.length === 1 &&
    ws.sent[0].message === "Unauthorized" &&
    ws.sent[0].result === false;

test("fetchBundleList: non-member cannot read another user's list by naming them", async () => {
    const { api, ws, store } = createContext();
    await api.fetchBundleList(ws, { username: "mallory" }, {
        cmd: "fetchBundleList",
        requestId: "r1",
        username: "alice", // client-supplied identity must be ignored
        projectId: "p1",
    });
    assert.ok(refused(ws), "must be refused, got: " + JSON.stringify(ws.sent));
    assert.strictEqual(store.BundleList.length, 0, "nothing may be created");
});

test("fetchBundleList: object-shaped projectId is refused, not queried through", async () => {
    const { api, ws, store } = createContext();
    await api.fetchBundleList(ws, { username: "mallory" }, {
        cmd: "fetchBundleList",
        requestId: "r1",
        username: "alice",
        projectId: { $ne: null },
    });
    assert.ok(refused(ws), "must be refused, got: " + JSON.stringify(ws.sent));
    assert.strictEqual(store.BundleList.length, 0);
});

test("fetchBundleList: a member gets their own list", async () => {
    const { api, ws, store } = createContext();
    await api.fetchBundleList(ws, { username: "bob" }, {
        cmd: "fetchBundleList",
        requestId: "r1",
        projectId: "p1",
    });
    assert.strictEqual(store.BundleList.length, 1);
    assert.strictEqual(store.BundleList[0].owner, "bob");
    assert.strictEqual(ws.sent[0].data.data.owner, "bob");
});

test("saveBundleLists: non-member cannot write into a project", async () => {
    const { api, ws, store } = createContext();
    await api.saveBundleLists(ws, { username: "mallory" }, {
        cmd: "saveBundleLists",
        requestId: "r2",
        projectId: "p1",
        bundleLists: { a: { username: "alice", bundles: ["victim"] } },
    });
    assert.ok(refused(ws), "must be refused, got: " + JSON.stringify(ws.sent));
    assert.strictEqual(store.BundleList.length, 0, "no write may land");
});

test("saveBundleLists: a researcher may not write another member's list", async () => {
    const { api, ws, store } = createContext();
    await api.saveBundleLists(ws, { username: "bob" }, {
        cmd: "saveBundleLists",
        requestId: "r2",
        projectId: "p1",
        bundleLists: { a: { username: "alice", bundles: ["mine"] } },
    });
    assert.ok(refused(ws), "must be refused, got: " + JSON.stringify(ws.sent));
    assert.strictEqual(store.BundleList.length, 0, "no write may land, not even one owned by the caller");
});

test("saveBundleLists: a ProjectAdmin assigns a member's list (the distribution flow)", async () => {
    const { api, ws, store } = createContext();
    await api.saveBundleLists(ws, { username: "alice" }, {
        cmd: "saveBundleLists",
        requestId: "r2",
        projectId: "p1",
        bundleLists: {
            a: { username: "alice", bundles: ["mine"] },
            b: { username: "bob", bundles: ["theirs"] },
        },
    });
    assert.strictEqual(ws.sent[0].result, "OK");
    assert.strictEqual(store.BundleList.length, 2);
    assert.deepStrictEqual(
        store.BundleList.map((l) => l.owner + ":" + l.bundles[0]).sort(),
        ["alice:mine", "bob:theirs"],
    );
});

test("saveBundleLists: a ProjectAdmin may not write outside the project", async () => {
    const { api, ws, store } = createContext();
    await api.saveBundleLists(ws, { username: "alice" }, {
        cmd: "saveBundleLists",
        requestId: "r2",
        projectId: "p1",
        bundleLists: {
            a: { username: "bob", bundles: ["theirs"] },
            b: { username: "mallory", bundles: ["nope"] },
        },
    });
    assert.ok(refused(ws), "must be refused, got: " + JSON.stringify(ws.sent));
    assert.strictEqual(store.BundleList.length, 0, "the whole call fails, not just the bad entry");
});

test("saveBundleLists: a member writing their own list still works", async () => {
    const { api, ws, store } = createContext();
    await api.saveBundleLists(ws, { username: "bob" }, {
        cmd: "saveBundleLists",
        requestId: "r2",
        projectId: "p1",
        bundleLists: { a: { username: "bob", bundles: ["mine"] } },
    });
    assert.strictEqual(ws.sent[0].result, "OK");
    assert.strictEqual(store.BundleList[0].owner, "bob");
});

test("fetchBundleList: a ProjectAdmin reads a member's list, a researcher does not", async () => {
    const asAdmin = createContext();
    await asAdmin.api.fetchBundleList(asAdmin.ws, { username: "alice" }, {
        cmd: "fetchBundleList",
        requestId: "r1",
        username: "bob",
        projectId: "p1",
    });
    assert.strictEqual(asAdmin.store.BundleList[0].owner, "bob");

    const asMember = createContext();
    await asMember.api.fetchBundleList(asMember.ws, { username: "bob" }, {
        cmd: "fetchBundleList",
        requestId: "r1",
        username: "alice",
        projectId: "p1",
    });
    assert.ok(refused(asMember.ws), "must be refused, got: " + JSON.stringify(asMember.ws.sent));
    assert.strictEqual(asMember.store.BundleList.length, 0);
});

test("saveBundleLists: object-shaped projectId is refused", async () => {
    const { api, ws, store } = createContext();
    await api.saveBundleLists(ws, { username: "bob" }, {
        cmd: "saveBundleLists",
        requestId: "r2",
        projectId: { $ne: null },
        bundleLists: { a: { username: "bob", bundles: ["x"] } },
    });
    assert.ok(refused(ws), "must be refused, got: " + JSON.stringify(ws.sent));
    assert.strictEqual(store.BundleList.length, 0);
});
