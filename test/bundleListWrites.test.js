/**
 * A bundle-list write that fails has to fail visibly.
 *
 * `_saveBundleLists()` called `save()` without awaiting it, so its caller could
 * not see a rejected write: `createProject` did not await the helper either and
 * answered the save as stored, and `saveBundleLists` answered "OK" after a loop
 * whose awaits resolved early. The rejection surfaced as an unhandled error in
 * the log while the user was told their assignment was saved.
 */
const test = require("node:test");
const assert = require("node:assert");
const {
    fakeModels,
    createApiServer,
    wsRecorder,
} = require("../test-helpers/fake-mongoose.js");
const ApiServer = require("../src/ApiServer.class");

const brokenSave = (message = "database write failed") => {
    const { models } = fakeModels({ BundleList: [] });
    models.BundleList.prototype.save = async () => {
        throw new Error(message);
    };
    return models.BundleList;
};

const context = (BundleList) => {
    const api = createApiServer(ApiServer);
    api.mongoose = { model: (name) => (name === "BundleList" ? BundleList : null) };
    api.app = {
        absRootPath: "/tmp",
        addLog() {},
        hsApiAccessToken: "token",
    };
    return { api, ws: wsRecorder() };
};

const refused = (ws) =>
    ws.sent.some(
        (m) => m.result === false || JSON.stringify(m).includes('"result":false'),
    );
const answeredOk = (ws) =>
    ws.sent.some((m) => m.result === "OK" || m.result === true);

test("_saveBundleLists propagates a rejected write", async () => {
    const ctx = context(brokenSave());
    await assert.rejects(
        () => ctx.api._saveBundleLists("some_user", "p1", []),
        /database write failed/,
        "the failed save was invisible to its caller",
    );
});

test("saveBundleLists refuses instead of answering OK", async () => {
    const ctx = context(brokenSave());
    // Both authorisation helpers stubbed to pass: anything else and the command
    // is refused before it reaches the write, which is a refusal that proves
    // nothing about error handling.
    ctx.api.requireBundleListProject = async () => ({ id: "p1", name: "Project One" });
    ctx.api.resolveBundleListOwner = () => "some_user";

    await ctx.api.saveBundleLists(ctx.ws, { username: "some_user" }, {
        cmd: "saveBundleLists",
        requestId: "r1",
        projectId: "p1",
        bundleLists: [{ username: "some_user", bundles: [] }],
    });

    assert.ok(refused(ctx.ws), `no refusal sent: ${JSON.stringify(ctx.ws.sent)}`);
    assert.ok(!answeredOk(ctx.ws), "it still said OK over a failed write");
});

test("fetchBundleList refuses when the list it just made cannot be stored", async () => {
    const ctx = context(brokenSave());
    ctx.api.requireBundleListProject = async () => ({ id: "p1", name: "Project One" });
    ctx.api.resolveBundleListOwner = () => "some_user";
    await ctx.api.fetchBundleList(ctx.ws, { username: "some_user" }, {
        cmd: "fetchBundleList",
        requestId: "r1",
        projectId: "p1",
        createIfMissing: true,
    });
    assert.ok(refused(ctx.ws), `no refusal sent: ${JSON.stringify(ctx.ws.sent)}`);
});

test("the system commit sets identity per-commit, not in the user's repo", () => {
    // simple-git's addConfig writes .git/config in the project checkout and
    // stays there: the user's own later commits go out as "VISP system".
    const src = require("node:fs")
        .readFileSync(require("node:path").join(__dirname, "../src/ApiServer.class.js"), "utf8")
        .split("async commitProjectBeforeReplacingBundles")[1]
        .split("\n    }")[0];
    assert.ok(src, "the function moved");
    assert.ok(!/\.addConfig\(/.test(src), "identity is still written into the repo");
    assert.match(src, /GIT_AUTHOR_NAME/, "no per-commit identity");
    assert.match(src, /GIT_COMMITTER_EMAIL/, "committer identity missing (git needs both)");
});

test("fetchBundleList answers when the lookup itself fails", async () => {
    // Guarding only the write left findOne outside: its rejection had nothing
    // above it (the dispatcher catch only logs), so the process died with no
    // frame sent and the dialog waited forever.
    const { models } = fakeModels({ BundleList: [] });
    models.BundleList.findOne = async () => {
        throw new Error("database unreachable");
    };
    const ctx = context(models.BundleList);
    ctx.api.requireBundleListProject = async () => ({ id: "p1", name: "Project One" });
    ctx.api.resolveBundleListOwner = () => "some_user";

    await ctx.api.fetchBundleList(ctx.ws, { username: "some_user" }, {
        cmd: "fetchBundleList",
        requestId: "r1",
        projectId: "p1",
    });

    assert.ok(refused(ctx.ws), `no refusal: ${JSON.stringify(ctx.ws.sent)}`);
    assert.match(
        JSON.stringify(ctx.ws.sent),
        /could not be loaded/,
        "a database failure must not be reported as an authorization refusal",
    );
});

test("a failed bundle-list write stops the create before anything exists", async () => {
    const ctx = context(brokenSave());
    const happened = [];
    ctx.api.validateProjectForm = () => true;
    ctx.api.getProjectMetadataFromPayload = () => ({});
    ctx.api.getProjectWideMetadataFromPayload = () => ({});
    ctx.api.prepareSessionUploads = async () => new Map();
    ctx.api.initProjectDirectory = async () => happened.push("directory");
    ctx.api._saveBundleLists = async () => {
        throw new Error("database write failed");
    };
    ctx.api.sendProjectSaveFailure = (ws, msg, message) => {
        happened.push("refused");
        ws.send(JSON.stringify({ result: false, message }));
    };
    const Project = {
        create: async () => happened.push("project-doc"),
        findOne: async () => null,
    };
    ctx.api.mongoose = {
        model: (name) => (name === "BundleList" ? brokenSave() : Project),
    };

    await ctx.api.createProject(ctx.ws, { username: "some_user" }, {
        cmd: "createProject",
        requestId: "r1",
        project: { projectName: "Project One", sessions: [] },
    });

    assert.ok(happened.includes("refused"), `not refused: ${happened}`);
    assert.ok(!happened.includes("project-doc"), "the project document was created anyway");
    assert.ok(!happened.includes("directory"), "the repository directory was created anyway");
});
