const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs-extra");

const {
    fakeModels,
    createApiServer,
    wsRecorder,
} = require("../test-helpers/fake-mongoose.js");
const ApiServer = require("../src/ApiServer.class");
const { trattLevelNameProblem, trattLevelState } = require("../src/trattLevel");

// --- the rules ---------------------------------------------------------------

test("trattLevelNameProblem: accepts a name like the project dialog does", () => {
    assert.strictEqual(trattLevelNameProblem("Transcription", []), null);
    assert.strictEqual(trattLevelNameProblem("Ortho words_2-b", []), null);
});

test("trattLevelNameProblem: refuses bad names", () => {
    for (const bad of [
        "",
        " Transcription",
        "Transcription ",
        "a/b",
        "../x",
        "x".repeat(31),
        undefined,
        { $ne: null },
    ]) {
        assert.ok(trattLevelNameProblem(bad, []), JSON.stringify(bad));
    }
});

test("trattLevelNameProblem: refuses a name the project has, in any case", () => {
    const problem = trattLevelNameProblem("transcription", [
        { name: "Transcription", type: "ITEM" },
    ]);
    assert.match(problem, /already has a level named "Transcription"/);
});

test("trattLevelState: missing, usable, wrong type, linked", () => {
    const dbConfig = {
        levelDefinitions: [
            { name: "Word", type: "ITEM" },
            { name: "Phonetic", type: "SEGMENT" },
            { name: "Free", type: "SEGMENT" },
        ],
        linkDefinitions: [{ superlevelName: "Word", sublevelName: "Phonetic" }],
    };
    assert.strictEqual(trattLevelState(dbConfig, "Transcription"), "missing");
    assert.strictEqual(trattLevelState(dbConfig, "Free"), "usable");
    assert.match(trattLevelState(dbConfig, "Word"), /ITEM level/);
    assert.match(trattLevelState(dbConfig, "Phonetic"), /linked/);
    assert.strictEqual(trattLevelState({}, "x"), "missing");
});

// --- createTrattLevel ---------------------------------------------------------

function createContext({ dbConfigs }) {
    const store = {
        Project: [
            {
                id: "p1",
                members: [
                    {
                        username: "alice",
                        role: ApiServer.PROJECT_ROLE_PROJECT_ADMIN,
                    },
                    {
                        username: "bob",
                        role: ApiServer.PROJECT_ROLE_RESEARCHER,
                    },
                ],
                annotationLevels: [
                    { name: "Word", type: "ITEM" },
                    { name: "Phonetic", type: "SEGMENT" },
                ],
                annotationLinks: [{ superLevel: "Word", subLevel: "Phonetic" }],
            },
        ],
    };
    const { models, writes } = fakeModels(store);
    const api = createApiServer(ApiServer);
    api.mongoose = { model: (name) => models[name] };
    api.projectRolesCache = Object.fromEntries(
        ApiServer.DEFAULT_PROJECT_ROLES.map((role) => [role.name, role]),
    );
    api.systemRolesCache = Object.fromEntries(
        ApiServer.DEFAULT_SYSTEM_ROLES.map((role) => [role.name, role]),
    );

    // Each DBconfig read returns the next config in the list (the last one
    // repeats), so a test can say what the EMU-DB holds before and after.
    const reads = [];
    const realRead = fs.readFileSync;
    fs.readFileSync = (p, ...rest) => {
        if (typeof p === "string" && p.startsWith("/repositories/")) {
            reads.push(p);
            const config =
                dbConfigs[Math.min(reads.length, dbConfigs.length) - 1];
            return JSON.stringify(config);
        }
        return realRead(p, ...rest);
    };
    const restore = () => {
        fs.readFileSync = realRead;
    };

    const containerRuns = [];
    api.runTrattLevelContainer = async (project, user, name, levels) => {
        containerRuns.push({ projectId: project.id, name, levels });
    };
    const commits = [];
    api.commitTrattLevel = async (projectId, user, name) => {
        commits.push({ projectId, name });
    };
    const ws = wsRecorder();
    return { api, ws, writes, reads, containerRuns, commits, restore };
}

const before = {
    levelDefinitions: [
        { name: "Word", type: "ITEM" },
        { name: "Phonetic", type: "SEGMENT" },
    ],
    linkDefinitions: [{ superlevelName: "Word", sublevelName: "Phonetic" }],
};
const after = {
    ...before,
    levelDefinitions: [
        ...before.levelDefinitions,
        { name: "Transcription", type: "SEGMENT" },
    ],
};

const request = (data) => ({
    cmd: "createTrattLevel",
    requestId: "r1",
    data: { projectId: "p1", name: "Transcription", ...data },
});

const refused = (ws, why) =>
    ws.sent.length === 1 &&
    ws.sent[0].result === false &&
    ws.sent[0].requestId === "r1" &&
    ws.sent[0].message.includes(why);

test("createTrattLevel: a researcher creates the level in the EMU-DB and MongoDB", async (t) => {
    const ctx = createContext({ dbConfigs: [before, after] });
    t.after(ctx.restore);
    await ctx.api.createTrattLevel(ctx.ws, { username: "bob" }, request());

    assert.deepStrictEqual(ctx.ws.sent, [
        {
            type: "cmd-result",
            cmd: "createTrattLevel",
            requestId: "r1",
            progress: "end",
            result: true,
            data: { level: { name: "Transcription", type: "SEGMENT" } },
        },
    ]);
    assert.strictEqual(ctx.containerRuns.length, 1);
    // The canvases order comes from the DBconfig plus the new level.
    assert.deepStrictEqual(ctx.containerRuns[0].levels, [
        { name: "Word", type: "ITEM" },
        { name: "Phonetic", type: "SEGMENT" },
        { name: "Transcription", type: "SEGMENT" },
    ]);
    assert.deepStrictEqual(ctx.writes, [
        [
            { id: "p1", "annotationLevels.name": { $ne: "Transcription" } },
            {
                $push: {
                    annotationLevels: {
                        name: "Transcription",
                        type: "SEGMENT",
                    },
                },
            },
        ],
    ]);
    assert.deepStrictEqual(ctx.commits, [
        { projectId: "p1", name: "Transcription" },
    ]);
    assert.ok(
        ctx.reads.every(
            (p) => p === "/repositories/p1/Data/VISP_emuDB/VISP_DBconfig.json",
        ),
    );
});

test("createTrattLevel: a non-member is refused before anything is read", async (t) => {
    const ctx = createContext({ dbConfigs: [before] });
    t.after(ctx.restore);
    await ctx.api.createTrattLevel(ctx.ws, { username: "mallory" }, request());
    assert.ok(refused(ctx.ws, "cannot edit"), JSON.stringify(ctx.ws.sent));
    assert.strictEqual(ctx.reads.length, 0);
    assert.strictEqual(ctx.containerRuns.length, 0);
    assert.strictEqual(ctx.writes.length, 0);
});

test("createTrattLevel: an unknown project is refused like a foreign one", async (t) => {
    const ctx = createContext({ dbConfigs: [before] });
    t.after(ctx.restore);
    await ctx.api.createTrattLevel(
        ctx.ws,
        { username: "alice" },
        request({ projectId: "nope" }),
    );
    assert.ok(refused(ctx.ws, "cannot edit"), JSON.stringify(ctx.ws.sent));
});

test("createTrattLevel: object-shaped ids and bad names are refused", async (t) => {
    const ctx = createContext({ dbConfigs: [before] });
    t.after(ctx.restore);
    await ctx.api.createTrattLevel(
        ctx.ws,
        { username: "alice" },
        request({ projectId: { $ne: null } }),
    );
    assert.ok(refused(ctx.ws, "could not be created"));

    const ctx2 = createContext({ dbConfigs: [before] });
    t.after(ctx2.restore);
    await ctx2.api.createTrattLevel(
        ctx2.ws,
        { username: "alice" },
        request({ name: "../etc" }),
    );
    assert.ok(refused(ctx2.ws, "A level name is"));
    assert.strictEqual(ctx2.containerRuns.length, 0);
});

test("createTrattLevel: a name the project already has is refused", async (t) => {
    const ctx = createContext({ dbConfigs: [before] });
    t.after(ctx.restore);
    await ctx.api.createTrattLevel(
        ctx.ws,
        { username: "alice" },
        request({ name: "phonetic" }),
    );
    assert.ok(refused(ctx.ws, 'level named "Phonetic"'));
    assert.strictEqual(ctx.containerRuns.length, 0);
    assert.strictEqual(ctx.writes.length, 0);
});

test("createTrattLevel: a same-named level only the EMU-DB has, of the wrong type, is refused", async (t) => {
    const itemInDb = {
        ...before,
        levelDefinitions: [
            ...before.levelDefinitions,
            { name: "Transcription", type: "ITEM" },
        ],
    };
    const ctx = createContext({ dbConfigs: [itemInDb] });
    t.after(ctx.restore);
    await ctx.api.createTrattLevel(ctx.ws, { username: "alice" }, request());
    assert.ok(refused(ctx.ws, "ITEM level"), JSON.stringify(ctx.ws.sent));
    assert.strictEqual(ctx.containerRuns.length, 0);
    assert.strictEqual(ctx.writes.length, 0);
});

test("createTrattLevel: a usable level only the EMU-DB has is adopted, no container", async (t) => {
    const ctx = createContext({ dbConfigs: [after] });
    t.after(ctx.restore);
    await ctx.api.createTrattLevel(ctx.ws, { username: "alice" }, request());
    assert.strictEqual(ctx.ws.sent[0].result, true);
    assert.strictEqual(ctx.containerRuns.length, 0);
    assert.strictEqual(ctx.writes.length, 1);
});

test("createTrattLevel: when R did not create the level, nothing is written and the lock is released", async (t) => {
    const ctx = createContext({ dbConfigs: [before, before] });
    t.after(ctx.restore);
    await assert.rejects(
        ctx.api.createTrattLevel(ctx.ws, { username: "alice" }, request()),
        /was not created/,
    );
    assert.strictEqual(ctx.writes.length, 0);
    assert.strictEqual(ctx.commits.length, 0);
    assert.strictEqual(ctx.api.trattLevelCreations.size, 0);
});

test("createTrattLevel: a second creation in the same project waits its turn", async (t) => {
    const ctx = createContext({ dbConfigs: [before, after] });
    t.after(ctx.restore);
    let release;
    ctx.api.runTrattLevelContainer = () =>
        new Promise((resolve) => {
            release = resolve;
        });
    const first = ctx.api.createTrattLevel(
        ctx.ws,
        { username: "alice" },
        request(),
    );
    await new Promise((resolve) => setImmediate(resolve));
    const ws2 = wsRecorder();
    await ctx.api.createTrattLevel(ws2, { username: "bob" }, request());
    assert.ok(refused(ws2, "already being created"), JSON.stringify(ws2.sent));
    release();
    await first;
    assert.strictEqual(ctx.ws.sent[0].result, true);
});
