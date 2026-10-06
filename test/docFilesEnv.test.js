const test = require("node:test");
const assert = require("node:assert");
const ApiServer = require("../src/ApiServer.class");
const Session = require("../src/Session.class");

// Contract: container-agent src/main.mjs copy-docs parses DOC_FILES with
// JSON.parse(process.env.DOC_FILES).map(f => (f && f.name) ? f.name : f)
// and copies only those entries from UPLOAD_PATH/docs into PROJECT_PATH/Documents.
const containerAgentParse = (envValue) =>
    JSON.parse(envValue).map((f) => (f && f.name ? f.name : f));

test("buildDocFilesEnv yields a DOC_FILES JSON allow list", () => {
    const api = Object.create(ApiServer.prototype);
    const env = api.buildDocFilesEnv({
        docFiles: [{ name: "with space.pdf" }, { name: "consent.pdf" }],
    });
    assert.ok(env.startsWith("DOC_FILES="));
    assert.deepStrictEqual(containerAgentParse(env.slice("DOC_FILES=".length)), [
        "with space.pdf",
        "consent.pdf",
    ]);
    // No docFiles in payload -> no env var -> container-agent keeps old behaviour
    assert.strictEqual(api.buildDocFilesEnv({}), null);
    assert.strictEqual(api.buildDocFilesEnv(null), null);
    // Empty list is sent: user removed every document, nothing may be copied
    assert.strictEqual(api.buildDocFilesEnv({ docFiles: [] }), "DOC_FILES=[]");
});

test("copyUploadedDocs passes DOC_FILES intact to the container exec env (spawn stubbed)", async () => {
    const api = Object.create(ApiServer.prototype);
    const session = Object.create(Session.prototype);
    session.app = { addLog: () => {} };
    let captured = null;
    session.runCommand = async (cmd, env) => {
        captured = { cmd, env };
        return '{"code":200,"body":"Copied 1 files"}';
    };

    const envVars = [
        "PROJECT_PATH=/home/jovyan/project",
        "UPLOAD_PATH=/home/uploads",
    ];
    const docFilesEnv = api.buildDocFilesEnv({
        docFiles: [{ name: "a b;rm -rf$.pdf" }],
    });
    if (docFilesEnv !== null) envVars.push(docFilesEnv);

    const result = await session.copyUploadedDocs(envVars);
    assert.strictEqual(JSON.parse(result).code, 200);
    assert.deepStrictEqual(captured.cmd, [
        "node",
        "/container-agent/main.js",
        "copy-docs",
    ]);
    // Env travels as an argv array (docker exec Env / execFileSync), never a
    // shell string, so quotes/spaces survive as one untouched entry.
    const docEntry = captured.env.find((e) => e.startsWith("DOC_FILES="));
    assert.strictEqual(
        captured.env.filter((e) => e.startsWith("DOC_FILES=")).length,
        1,
    );
    assert.deepStrictEqual(containerAgentParse(docEntry.slice("DOC_FILES=".length)), [
        "a b;rm -rf$.pdf",
    ]);
});
