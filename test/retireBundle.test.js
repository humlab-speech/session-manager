const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ApiServer = require("../src/ApiServer.class");

// An import that replaces a bundle also throws away what was annotated in it, and
// item codes come back into use, so the replaced bundle is moved aside instead of
// deleted. api.retireBundle only needs fs and app.addLog.
function createContext() {
    const api = Object.create(ApiServer.prototype);
    api.app = { addLog: () => {} };
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "visp-data-"));
    fs.mkdirSync(path.join(dataDir, "VISP_emuDB", "sess_ses"), {
        recursive: true,
    });
    return { api, dataDir };
}

function makeBundle(dataDir, name, content) {
    const dir = path.join(dataDir, "VISP_emuDB", "sess_ses", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "annotation.json"), content);
    return dir;
}

test("a replaced bundle is moved aside with its annotations, not deleted", async () => {
    const { api, dataDir } = createContext();
    makeBundle(dataDir, "prompt_2_bndl", "annotated work");

    const retired = await api.retireBundle(
        dataDir,
        "sess_ses",
        "prompt_2_bndl",
    );

    assert.ok(retired, "the retired bundle must be reported");
    assert.ok(
        !fs.existsSync(
            path.join(dataDir, "VISP_emuDB", "sess_ses", "prompt_2_bndl"),
        ),
        "gone from the session",
    );
    assert.equal(
        fs.readFileSync(path.join(retired, "annotation.json"), "utf8"),
        "annotated work",
    );

    // The point of the folder is that a researcher can open it in the project's
    // file browser, which refuses to serve hidden paths.
    const kept = path.basename(path.dirname(path.dirname(retired)));
    assert.equal(kept, "replaced-recordings");
    assert.ok(!kept.startsWith("."), "the folder must not be hidden");
});

test("nothing to replace is not an error", async () => {
    const { api, dataDir } = createContext();
    assert.equal(
        await api.retireBundle(dataDir, "sess_ses", "prompt_9_bndl"),
        null,
    );
});

test("two replacements of the same code both survive", async () => {
    const { api, dataDir } = createContext();
    makeBundle(dataDir, "prompt_1_bndl", "first");
    const first = await api.retireBundle(dataDir, "sess_ses", "prompt_1_bndl");
    makeBundle(dataDir, "prompt_1_bndl", "second");
    const second = await api.retireBundle(dataDir, "sess_ses", "prompt_1_bndl");

    assert.notEqual(first, second);
    assert.equal(
        fs.readFileSync(path.join(first, "annotation.json"), "utf8"),
        "first",
    );
    assert.equal(
        fs.readFileSync(path.join(second, "annotation.json"), "utf8"),
        "second",
    );
});

// The retired copies are a working-tree undo; committing them would permanently
// double a re-taken recording in the project's git history, and project repos have
// no .gitignore at all. api.ensureReplacedRecordingsIgnored writes the rule.
test("retired recordings are kept out of the project's git history", () => {
    const { api } = createContext();
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "visp-repo-"));

    api.ensureReplacedRecordingsIgnored(repoDir);
    api.ensureReplacedRecordingsIgnored(repoDir);
    let ignore = fs.readFileSync(path.join(repoDir, ".gitignore"), "utf8");
    assert.equal(ignore, "Data/replaced-recordings/\n");

    fs.writeFileSync(path.join(repoDir, ".gitignore"), "something/\n");
    api.ensureReplacedRecordingsIgnored(repoDir);
    api.ensureReplacedRecordingsIgnored(repoDir);
    ignore = fs.readFileSync(path.join(repoDir, ".gitignore"), "utf8");
    assert.equal(ignore, "something/\nData/replaced-recordings/\n");
});
