const test = require("node:test");
const assert = require("node:assert");

// Same story as inviteCodeInjection.test.js, one layer up: saveSessionsMongo
// takes the client-built formSession.id and hands it to the raw wsrng SPR
// driver through sprSessionDelete (deleteOne filter) and sprSessionEnsure
// (findOne filter plus the updateOne/update it performs). Neither
// validateProjectForm nor prepareSessionUploads type-checks the id, so an
// object-shaped value such as {"$ne": null} reaches the driver as query
// operators. The fake below has the driver's naive operator semantics:
// against unfixed code it matches EVERY SPR session and deletes/rewrites it.

const {
    createApiServer,
} = require("../test-helpers/fake-mongoose.js");
const ApiServer = require("../src/ApiServer.class");

// Naive driver semantics (see inviteCodeInjection.test.js): bare values
// compare by equality, {$ne: v} evaluates as an operator. Deliberately NOT
// the strict-equality fake-mongoose matches() — that models Mongoose casting.
function naiveMatch(doc, q) {
    return Object.entries(q).every(([k, v]) => {
        if (v !== null && typeof v === "object" && !Array.isArray(v)) {
            return Object.entries(v).every(([op, operand]) => {
                if (op === "$ne") return doc[k] !== operand;
                return false;
            });
        }
        return doc[k] === v;
    });
}

// Unlike the invite-code fake, deleteOne really removes the matched document,
// so "nothing may match or be deleted" is asserted on the data itself.
function rawSprDb(sprSessions) {
    const calls = [];
    const writes = [];
    const list = sprSessions;
    const db = {
        collection(name) {
            return {
                async findOne(q) {
                    calls.push([name, q]);
                    return list.find((d) => naiveMatch(d, q)) ?? null;
                },
                async updateOne(q, u) {
                    calls.push([name, q]);
                    writes.push([name, u]);
                },
                async deleteOne(q) {
                    calls.push([name, q]);
                    const i = list.findIndex((d) => naiveMatch(d, q));
                    if (i >= 0) list.splice(i, 1);
                    writes.push([name, null]);
                },
                async insertOne(d) {
                    calls.push([name, d]);
                    writes.push([name, d]);
                    list.push(d);
                },
            };
        },
    };
    return { db, calls, writes, list };
}

function createContext(mongoSessions, sprSessions) {
    const { db, calls, writes, list } = rawSprDb(sprSessions);
    const api = createApiServer(ApiServer);
    api.connectToMongo = async () => db;
    api.sprImportService = { listUploads: () => [] };
    const mongoProject = {
        id: "p1",
        sessions: mongoSessions,
        markModified() {},
        save: async () => {},
    };
    api.mongoose = {
        model: () => ({ findOne: async () => mongoProject }),
    };
    return { api, calls, writes, list, mongoProject };
}

// sprSessionDelete is called without await (fire-and-forget); flush the
// microtask queue so its raw call is observable either way.
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("saveSessionsMongo: {\"$ne\":null} delete id is refused before any SPR db call", async () => {
    const { api, calls, writes, list, mongoProject } = createContext(
        [{ id: "s1", name: "Session 1", files: [] }],
        [{ sessionId: "s1", project: "p1" }],
    );
    await assert.rejects(
        () =>
            api.saveSessionsMongo({
                id: "p1",
                sessions: [{ deleted: true, id: { $ne: null } }],
            }),
        "the save must be refused",
    );
    await settle();
    assert.strictEqual(calls.length, 0, "no raw query may be issued");
    assert.strictEqual(writes.length, 0, "no write may land");
    assert.strictEqual(list.length, 1, "the SPR session must still exist");
    assert.strictEqual(mongoProject.sessions.length, 1);
});

test("saveSessionsMongo: {\"$ne\":null} on a new recording session never reaches ensure/update", async () => {
    const { api, calls, writes, list } = createContext(
        [],
        [{ sessionId: "s1", project: "p1" }],
    );
    await assert.rejects(
        () =>
            api.saveSessionsMongo({
                id: "p1",
                sessions: [
                    {
                        new: true,
                        id: { $ne: null },
                        name: "Session 2",
                        dataSource: "record",
                        recordEnabled: true,
                    },
                ],
            }),
    );
    await settle();
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(writes.length, 0);
    assert.strictEqual(
        list.length,
        1,
        "the naive $ne filter would have matched and rewritten every session",
    );
});

test("saveSessionsMongo: a legitimate string id still deletes its SPR session", async () => {
    const { api, calls, writes, list, mongoProject } = createContext(
        [{ id: "s1", name: "Session 1", files: [] }],
        [{ sessionId: "s1", project: "p1" }],
    );
    await api.saveSessionsMongo({
        id: "p1",
        sessions: [{ deleted: true, id: "s1" }],
    });
    await settle();
    assert.deepStrictEqual(calls[0], ["sessions", { sessionId: "s1" }]);
    assert.strictEqual(list.length, 0, "the real session is deleted");
    assert.ok(writes.length > 0);
    assert.strictEqual(mongoProject.sessions.length, 0);
});

test("saveSessionsMongo: a legitimate string id still updates its SPR session", async () => {
    const { api, calls, writes, list } = createContext(
        [
            {
                id: "s1",
                name: "Session 1",
                files: [],
                dataSource: "record",
                recordEnabled: true,
                sessionScript: "script_a",
            },
        ],
        [{ sessionId: "s1", project: "p1", script: "script_a" }],
    );
    await api.saveSessionsMongo({
        id: "p1",
        sessions: [
            {
                id: "s1",
                name: "Session 1",
                dataSource: "record",
                recordEnabled: true,
                sessionScript: "script_a",
            },
        ],
    });
    await settle();
    assert.ok(calls.length > 0, "the SPR lookup must happen");
    assert.deepStrictEqual(calls[0][1], { sessionId: "s1" });
    const update = writes.find(([name, u]) => name === "sessions" && u?.$set);
    assert.ok(update, "the SPR session must be updated");
    assert.strictEqual(list[0].script, "script_a");
});

test("saveSessionsMongo: undefined id on a new session keeps working and never touches the SPR db", async () => {
    const { api, calls, writes, list, mongoProject } = createContext(
        [],
        [{ sessionId: "s1", project: "p1" }],
    );
    await api.saveSessionsMongo({
        id: "p1",
        sessions: [
            { new: true, name: "Session 3", dataSource: "upload" },
        ],
    });
    await settle();
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(writes.length, 0);
    assert.strictEqual(list.length, 1, "the unrelated SPR session is untouched");
    assert.strictEqual(
        mongoProject.sessions.length,
        1,
        "the upload-only session is still stored",
    );
});
