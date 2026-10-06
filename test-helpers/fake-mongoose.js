// Shared fakes for the test suite. This lives OUTSIDE test/ on purpose:
// `node --test test/` runs every file in that tree, helper included.
//
// The fakes model just enough of mongoose/rimraf for ApiServer handlers to
// run without a database or a real filesystem under /repositories.

// Strict equality matching: an object-shaped query value ({ $ne: ... }) matches
// nothing, like the real driver does for { id: { $ne: null } } on a string field.
function matches(doc, q) {
    return Object.entries(q).every(([k, v]) => doc[k] === v);
}

// deleteBundle/deleteProject remove directories through rimraf; stub it BEFORE
// ApiServer.class is required so its module-level destructure picks up the
// fake. No test may touch a real /repositories path. Returns the list of
// paths the code under test asked to remove.
function stubRimraf() {
    const rimraf = require("rimraf");
    const removedPaths = [];
    rimraf.nativeSync = (p) => {
        removedPaths.push(p);
        return true;
    };
    return removedPaths;
}

// One Model class per store entry over a plain array. findOne can be armed to
// throw (simulated database outage) and honors a sessions.$elemMatch
// projection like the real driver; updateOne and deleteOne record their
// queries so tests can assert that nothing (or exactly something) was written.
function fakeModels(store, { boom = null, writes = [], deleted = [] } = {}) {
    const models = {};
    for (const [name, docs] of Object.entries(store)) {
        class Model {
            constructor(fields) {
                Object.assign(this, fields);
            }
            save() {
                if (!docs.includes(this)) docs.push(this);
            }
            static async findOne(q, proj) {
                if (boom) throw boom;
                const doc = docs.find((d) => matches(d, q)) ?? null;
                if (doc && proj?.sessions?.$elemMatch?.id !== undefined) {
                    const want = proj.sessions.$elemMatch.id;
                    return {
                        ...doc,
                        sessions: (doc.sessions ?? []).filter(
                            (s) => s && s.id === want,
                        ),
                    };
                }
                return doc;
            }
            static async find(q) {
                return docs.filter((d) => matches(d, q));
            }
            static async updateOne(q, u) {
                writes.push([q, u]);
            }
            static async deleteOne(q) {
                deleted.push(q.id);
            }
        }
        models[name] = Model;
    }
    return { models, writes, deleted };
}

// The bare ApiServer instance most tests need: the prototype with an inert
// app, no server, no database. Callers hang whatever else off `api`.
function createApiServer(ApiServer, app = { addLog: () => {} }) {
    const api = Object.create(ApiServer.prototype);
    api.app = app;
    return api;
}

const wsRecorder = () => {
    const ws = { sent: [], send: (m) => ws.sent.push(JSON.parse(m)) };
    return ws;
};

module.exports = {
    matches,
    stubRimraf,
    fakeModels,
    createApiServer,
    wsRecorder,
};
