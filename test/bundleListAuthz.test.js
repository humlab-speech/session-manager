const test = require("node:test");
const assert = require("node:assert");
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
    const models = {};
    for (const [name, docs] of Object.entries(store)) {
        class Model {
            constructor(fields) {
                Object.assign(this, fields);
            }
            save() {
                if (!docs.includes(this)) docs.push(this);
            }
            // strict equality matching: a NoSQL-shaped query value ({ $ne: ... })
            // matches nothing, like the real driver does for { id: { $ne: null } }
            // against a string field.
            static async findOne(q) {
                return docs.find((d) => matches(d, q)) ?? null;
            }
            static async find(q) {
                return docs.filter((d) => matches(d, q));
            }
        }
        models[name] = Model;
    }
    const api = Object.create(ApiServer.prototype);
    api.mongoose = { model: (name) => models[name] };
    api.app = { addLog: () => {} };
    const ws = { sent: [], send: (m) => ws.sent.push(JSON.parse(m)) };
    return { api, ws, store };
}

function matches(doc, q) {
    return Object.entries(q).every(([k, v]) => doc[k] === v);
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

test("saveBundleLists: writes are owned by the connection user, not the spoofed username", async () => {
    const { api, ws, store } = createContext();
    await api.saveBundleLists(ws, { username: "bob" }, {
        cmd: "saveBundleLists",
        requestId: "r2",
        projectId: "p1",
        bundleLists: { a: { username: "alice", bundles: ["mine"] } },
    });
    assert.strictEqual(ws.sent[0].result, "OK");
    assert.strictEqual(store.BundleList.length, 1);
    assert.strictEqual(store.BundleList[0].owner, "bob");
    assert.deepStrictEqual(store.BundleList[0].bundles, ["mine"]);
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
