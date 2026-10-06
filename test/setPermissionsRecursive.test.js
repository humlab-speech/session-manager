const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ApiServer = require("../src/ApiServer.class");

// setPermissionsRecursive only uses fs/path/console, so the instance can be
// built off the prototype without running the constructor (no DB/network).
const createApi = () => Object.create(ApiServer.prototype);

test("setPermissionsRecursive applies the mode to nested files and subdirectories", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "visp-perm-test-"));
    try {
        // A subdirectory holding a file, plus a file in the root. Everything
        // starts with a restrictive mode so a skipped chmod is observable.
        const sub = path.join(root, "sub");
        const deep = path.join(sub, "deep");
        fs.mkdirSync(sub);
        fs.mkdirSync(deep);
        const rootFile = path.join(root, "a.txt");
        const subFile = path.join(sub, "b.txt");
        const deepFile = path.join(deep, "c.txt");
        for (const f of [rootFile, subFile, deepFile]) fs.writeFileSync(f, "x");
        for (const d of [root, sub, deep]) fs.chmodSync(d, 0o700);
        for (const f of [rootFile, subFile, deepFile]) fs.chmodSync(f, 0o600);

        const mode = 0o755;
        await createApi().setPermissionsRecursive(root, mode);

        const permOf = (p) => fs.statSync(p).mode & 0o777;
        for (const d of [root, sub, deep]) {
            assert.strictEqual(permOf(d), mode, `directory ${path.relative(root, d)} should be ${mode}`);
        }
        for (const f of [rootFile, subFile, deepFile]) {
            assert.strictEqual(permOf(f), mode, `file ${path.relative(root, f)} should be ${mode}`);
        }
    } finally {
        // Restore traversal permission before removing so rm can descend.
        try {
            fs.chmodSync(path.join(root, "sub", "deep"), 0o755);
            fs.chmodSync(path.join(root, "sub"), 0o755);
        } catch (_) {}
        fs.rmSync(root, { recursive: true, force: true });
    }
});
