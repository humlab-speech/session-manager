const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ApiServer = require("../src/ApiServer.class");
const { createApiServer } = require("../test-helpers/fake-mongoose.js");

// convertAllInDirectoryToWav() reaches ffmpeg; a fake binary on PATH records
// the argv it actually received, and a hostile file name carries shell syntax
// that WOULD execute (creating PWNED) if the command went through /bin/sh.
test("conversion passes hostile file names as literal argv, never through a shell", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wavconv-"));
    const binDir = path.join(tmp, "bin");
    const argvLog = path.join(tmp, "argv.txt");
    const sessionDir = path.join(tmp, "emudb-sessions", "sess1");
    fs.mkdirSync(binDir);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
        path.join(binDir, "ffmpeg"),
        `#!/bin/sh\nprintf '%s\\n' "$@" >> '${argvLog}'\n`,
    );
    fs.chmodSync(path.join(binDir, "ffmpeg"), 0o755);

    // ';' defeats nothing on its own but proves literalness; '$(...)' breaks out
    // of the old double-quoted execSync string and would run touch (cwd = tmp).
    const hostile = "a;$(touch PWNED);b.mp3";
    const filePath = path.join(sessionDir, hostile);
    fs.writeFileSync(filePath, "x");

    const api = createApiServer(ApiServer);
    api.updateFileMetaDataOfConvertedFile = async () => {};

    const prevPath = process.env.PATH;
    const prevCwd = process.cwd();
    process.env.PATH = binDir + path.delimiter + prevPath;
    process.chdir(tmp);
    try {
        const results = await api.convertAllInDirectoryToWav("proj", tmp);
        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].result, "info");
        assert.ok(
            !fs.existsSync(path.join(tmp, "PWNED")),
            "shell metacharacters in the file name must not execute",
        );
        const argv = fs.readFileSync(argvLog, "utf8").trim().split("\n");
        // each argv line is one literal token: the whole hostile name arrives
        // intact as a single -i argument, quotes and all.
        assert.ok(argv.includes("-i"));
        assert.ok(argv.includes(filePath));
        assert.ok(
            argv.includes(
                path.join(sessionDir, "a;$(touch PWNED);b.wav"),
            ),
        );
    } finally {
        process.chdir(prevCwd);
        process.env.PATH = prevPath;
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
