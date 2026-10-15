const test = require("node:test");
const assert = require("node:assert");

// SPR sessions (the wsrng "sessions" collection) are keyed by sessionId ALONE:
// sprSessionDelete's deleteOne filter and sprSessionUpdate's updateOne filter
// both match on {sessionId} only, and saveSessionsMongo hands them ids read
// out of the submitted form. Since 7ac00ef project members may save their own
// project, so a caller with edit rights on project P can name a sessionId that
// belongs to project Q and have the recorder's session record deleted or
// rewritten. A sessionId is client-built, so "those never collide" is not a
// property anyone checks. Every SPR document records the project it was made
// for (sprSessionCreate writes `project`), so both operations can — and here
// do — scope their filter to it, and saveSessionsMongo additionally ignores
// ids that are not in the project session list it already fetched.
const {
    createApiServer,
} = require("../test-helpers/fake-mongoose.js");
const ApiServer = require("../src/ApiServer.class");

// Plain driver semantics, no casting, no operators: equality on every field in
// the filter. deleteOne really removes, updateOne really applies $set, so
// "another project's session survived" is asserted on the data itself.
function sprDb(docs) {
    const filters = [];
    const match = (doc, q) =>
        Object.entries(q).every(([key, value]) => doc[key] === value);
    const db = {
        collection: () => ({
            async findOne(q) {
                filters.push(["findOne", q]);
                return docs.find((doc) => match(doc, q)) ?? null;
            },
            async updateOne(q, u) {
                filters.push(["updateOne", q]);
                docs.filter((doc) => match(doc, q)).forEach((doc) => {
                    Object.assign(doc, u.$set);
                });
            },
            async deleteOne(q) {
                filters.push(["deleteOne", q]);
                const i = docs.findIndex((doc) => match(doc, q));
                if (i >= 0) docs.splice(i, 1);
            },
            async insertOne(doc) {
                filters.push(["insertOne", doc]);
                docs.push(doc);
            },
        }),
    };
    return { db, filters, docs };
}

// p1 owns SPR session s1, p2 owns s2. `stored` is p1's own session list as the
// server fetched it — the list a save may act on.
function createContext(stored, sprDocs) {
    const { db, filters, docs } = sprDb(sprDocs);
    const api = createApiServer(ApiServer);
    api.connectToMongo = async () => db;
    api.sprImportService = { listUploads: () => [] };
    const mongoProject = {
        id: "p1",
        sessions: stored,
        markModified() {},
        save: async () => {},
    };
    api.mongoose = { model: () => ({ findOne: async () => mongoProject }) };
    return { api, filters, docs, mongoProject };
}

const storedSession = (id, extra) => ({
    id,
    name: "Session " + id,
    files: [],
    dataSource: "record",
    recordEnabled: true,
    sessionScript: "script_a",
    ...extra,
});

const formSession = (id, extra) => ({
    id,
    name: "Session " + id,
    dataSource: "record",
    recordEnabled: true,
    sessionScript: "script_a",
    ...extra,
});

// sprSessionDelete is fire-and-forget; flush the microtask queue so its raw
// call is observable either way.
const settle = () => new Promise((resolve) => setImmediate(resolve));

const filtersFor = (filters, op) =>
    filters.filter(([name]) => name === op).map(([, q]) => q);

test("a save that deletes a session of another project leaves that project's SPR session alone", async () => {
    const { api, filters, docs } = createContext(
        [storedSession("s1")],
        [
            { sessionId: "s1", project: "p1", script: "script_a" },
            { sessionId: "s2", project: "p2", script: "script_b" },
        ],
    );
    await api.saveSessionsMongo({
        id: "p1",
        sessions: [{ id: "s2", deleted: true }],
    });
    await settle();
    assert.strictEqual(
        docs.length,
        2,
        "p2's recording session must survive: " + JSON.stringify(docs),
    );
    for (const filter of filtersFor(filters, "deleteOne")) {
        assert.deepStrictEqual(
            filter,
            { sessionId: "s2", project: "p1" },
            "no delete may be issued on a bare sessionId",
        );
    }
});

test("a legitimate delete still deletes, and the filter names the project", async () => {
    const { api, filters, docs, mongoProject } = createContext(
        [storedSession("s1")],
        [{ sessionId: "s1", project: "p1", script: "script_a" }],
    );
    await api.saveSessionsMongo({
        id: "p1",
        sessions: [{ id: "s1", deleted: true }],
    });
    await settle();
    assert.deepStrictEqual(filtersFor(filters, "deleteOne"), [
        { sessionId: "s1", project: "p1" },
    ]);
    assert.strictEqual(docs.length, 0, "the project's own session is deleted");
    assert.strictEqual(mongoProject.sessions.length, 0);
});

test("a legitimate update still updates, and the filter names the project", async () => {
    const { api, filters, docs } = createContext(
        [storedSession("s1")],
        [{ sessionId: "s1", project: "p1", script: "script_a" }],
    );
    await api.saveSessionsMongo({
        id: "p1",
        sessions: [formSession("s1", { sessionScript: "script_b" })],
    });
    await settle();
    const updates = filtersFor(filters, "updateOne");
    assert.deepStrictEqual(updates, [{ sessionId: "s1", project: "p1" }]);
    assert.strictEqual(docs[0].script, "script_b");
});

test("ensure refuses to adopt a sessionId another project's SPR session holds", async () => {
    const { api, filters, docs } = createContext([], [
        { sessionId: "s2", project: "p2", script: "script_b" },
    ]);
    await api.sprSessionEnsure("p1", formSession("s2", { sessionScript: "x" }));
    await settle();
    assert.strictEqual(docs[0].project, "p2", "still p2's session");
    assert.strictEqual(docs[0].script, "script_b", "its script was not rewritten");
    assert.strictEqual(docs.length, 1, "no second document under the same id");
    assert.deepStrictEqual(filtersFor(filters, "updateOne"), []);
});

test("ensure creates and updates the project's own session", async () => {
    const { api, filters, docs } = createContext([], [
        { sessionId: "s2", project: "p2", script: "script_b" },
    ]);
    await api.sprSessionEnsure("p1", formSession("s1", { sessionScript: "x" }));
    await settle();
    assert.strictEqual(docs.length, 2, "p1's session was created");
    assert.deepStrictEqual(docs[1], {
        project: "p1",
        sessionId: "s1",
        script: "x",
        debugMode: false,
        type: "NORM",
        status: "CREATED",
        sealed: false,
        loadedDate: docs[1].loadedDate,
    });
    assert.deepStrictEqual(filtersFor(filters, "updateOne"), [
        { sessionId: "s1", project: "p1" },
    ]);
});
