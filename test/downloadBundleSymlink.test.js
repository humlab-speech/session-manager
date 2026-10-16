// downloadBundle refuses a bundle tree that is not made of plain files
// (finding F1). The bundle directory sits in the project repository, which is
// bind-mounted read-write into the project members' own session containers, so
// any member of a project can plant a symlink inside a bundle they are allowed
// to download. Pre-fix the zip was built with adm-zip's own walk, which follows
// links, so the link's TARGET CONTENT went back to them base64 - across the
// other projects and the staged uploads the session-manager container mounts.
//
// Runs against a temp tree through api.projectReposRoot; no test here creates,
// needs or touches a real /repositories, so `npm test` passes on a deployed
// box (the version this replaces mkdir'ed /repositories and asserted it was
// empty, which fails outright wherever real projects live).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const AdmZip = require("adm-zip");

const {
    fakeModels,
    createApiServer,
    wsRecorder,
} = require("../test-helpers/fake-mongoose.js");

const ApiServer = require("../src/ApiServer.class");

const CANARY = "CONTENT-THAT-MUST-NEVER-LEAVE-THE-SERVER";

function context() {
    const store = {
        Project: [
            {
                id: "p1",
                members: [{ username: "some_user", role: ApiServer.PROJECT_ROLE_RESEARCHER }],
                sessions: [{ id: "s1", name: "ses1", files: [{ name: "b1" }] }],
            },
        ],
    };
    const { models } = fakeModels(store);
    const api = createApiServer(ApiServer);
    api.mongoose = { model: (name) => models[name] };

    // <root>/p1/Data/VISP_emuDB/ses1_ses/b1_bndl is what the handler resolves.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-tree-"));
    api.projectReposRoot = root;
    const bundleDir = path.join(root, "p1", "Data", "VISP_emuDB", "ses1_ses", "b1_bndl");
    fs.mkdirSync(bundleDir, { recursive: true });

    // The link target, somewhere a project member could not otherwise read.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-tree-"));
    const canary = path.join(outside, "other-project.wav");
    fs.writeFileSync(canary, CANARY);

    const ws = wsRecorder();
    // requireBundleIds reads these from msg.data, like every other bundle cmd.
    const msg = {
        cmd: "downloadBundle",
        requestId: "r1",
        data: { projectId: "p1", sessionId: "s1", fileName: "b1" },
    };
    const run = () => api.downloadBundle(ws, { username: "some_user" }, msg);
    const cleanup = () => {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    };
    return { api, ws, bundleDir, canary, run, cleanup };
}

function nothingLeaked(ws) {
    const sent = JSON.stringify(ws.sent);
    return !sent.includes(CANARY) && !sent.includes(Buffer.from(CANARY).toString("base64"));
}

test("a symlink planted in the bundle is refused, and its target never reaches the client", async () => {
    const ctx = context();
    fs.writeFileSync(path.join(ctx.bundleDir, "take1.wav"), "regular content");
    fs.symlinkSync(ctx.canary, path.join(ctx.bundleDir, "take2.wav"));

    await ctx.run();
    ctx.cleanup();

    assert.equal(ctx.ws.sent.length, 1, `expected one frame, got: ${JSON.stringify(ctx.ws.sent)}`);
    assert.equal(ctx.ws.sent[0].result, false, "the refusal must not be reported as a success");
    assert.equal(ctx.ws.sent[0].progress, "end", "a refusal must still end the command");
    assert.ok(nothingLeaked(ctx.ws), "the link target's content was sent to the client");
    assert.match(ctx.ws.sent[0].message, /could not be zipped/i, `unhelpful message: ${ctx.ws.sent[0].message}`);
});

test("positive control: a bundle of regular files still downloads, entries and all", async () => {
    const ctx = context();
    fs.writeFileSync(path.join(ctx.bundleDir, "take1.wav"), "AAA");
    fs.mkdirSync(path.join(ctx.bundleDir, "sub"));
    fs.writeFileSync(path.join(ctx.bundleDir, "sub", "take2.wav"), "BBB");

    await ctx.run();
    ctx.cleanup();

    assert.equal(ctx.ws.sent.length, 1, `expected one frame, got: ${JSON.stringify(ctx.ws.sent)}`);
    assert.equal(ctx.ws.sent[0].result, true, `refused a clean bundle: ${JSON.stringify(ctx.ws.sent[0])}`);
    const zip = new AdmZip(Buffer.from(ctx.ws.sent[0].data.file, "base64"));
    const entries = zip.getEntries().map((e) => e.entryName).sort();
    assert.deepEqual(entries, ["sub/take2.wav", "take1.wav"]);
    assert.equal(zip.readAsText("take1.wav"), "AAA");
});