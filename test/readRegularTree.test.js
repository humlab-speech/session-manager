// The guard behind downloadBundle's refusal (finding F1): a bundle directory
// is inside the project repository, which is bind-mounted read-write into the
// members' own session containers, so a member can plant a symlink in a bundle
// they are entitled to download. adm-zip reads through links, so the pre-fix
// code archived the link's TARGET and sent it back under plain membership
// authz - across whatever else the session-manager container mounts.
//
// readRegularTree is a reader rather than a scan: the attacker owns the
// directory, so a check-then-zip pass can be raced by whoever can edit it.
// These tests run in a temp directory; nothing here needs, creates or touches
// a real /repositories, so `npm test` works on a deployed box.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { execFileSync } = require("node:child_process");

const { readRegularTree, NonRegularFileError } = require("../src/pathSecurity.js");

// node's fs has no mkfifo in every build, and a FIFO is the case that used to
// hang the whole process (readFileSync waits forever for a writer).
let canMkfifo = true;
try {
    execFileSync("mkfifo", [path.join(os.tmpdir(), "probe-" + process.pid + "-fifo")]);
    fs.unlinkSync(path.join(os.tmpdir(), "probe-" + process.pid + "-fifo"));
} catch (err) {
    canMkfifo = false;
}

function tree(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "regular-tree-"));
    for (const [name, content] of Object.entries(files)) {
        const full = path.join(root, name);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        if (content === "@symlink-to-outside") {
            const target = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
            fs.writeFileSync(path.join(target, "secret.txt"), "CONTENT OUTSIDE THE TREE");
            fs.symlinkSync(path.join(target, "secret.txt"), full);
        } else if (content === "@fifo") {
            execFileSync("mkfifo", [full]);
                } else {
            fs.writeFileSync(full, content);
        }
    }
    return root;
}

test("a tree of regular files is read whole, with root-relative names", () => {
    const root = tree({ "a.wav": "AAA", "sub/b.wav": "BBB" });
    const read = readRegularTree(root);
    assert.deepEqual(
        read.map((f) => f.name + ":" + f.data.toString()).sort(),
        ["a.wav:AAA", "sub/b.wav:BBB"],
    );
    fs.rmSync(root, { recursive: true, force: true });
});

test("a symlink in the tree is refused, not read", () => {
    const root = tree({ "a.wav": "AAA", "evil.wav": "@symlink-to-outside" });
    assert.throws(
        () => readRegularTree(root),
        (err) => err instanceof NonRegularFileError && /evil\.wav/.test(err.message),
    );
    fs.rmSync(root, { recursive: true, force: true });
});

test("the bundle directory itself being a symlink is refused", () => {
    // The listing follows the root, so this needs its own check: without it the
    // whole target tree is walked and returned.
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), "outside-root-"));
    fs.writeFileSync(path.join(outer, "secret.txt"), "CONTENT OUTSIDE THE TREE");
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "regular-tree-"));
    fs.symlinkSync(outer, path.join(parent, "b1_bndl"));
    assert.throws(() => readRegularTree(path.join(parent, "b1_bndl")), NonRegularFileError);
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(outer, { recursive: true, force: true });
});

test(
    "a FIFO is refused (and pre-fix, reading one hung the process)",
    { skip: !canMkfifo },
    () => {
    const root = tree({ "a.wav": "AAA", "pipe": "@fifo" });
    assert.throws(() => readRegularTree(root), NonRegularFileError);
    fs.rmSync(root, { recursive: true, force: true });
    }
);

test("a subdirectory swapped for a link after the listing is refused", () => {
    // The race the path-based walk could not close: the listing sees `sub` as
    // a real directory, and between that listing and the walk entering it the
    // member renames it away and plants `sub -> outside`. Deterministic here:
    // the swap happens inside the very first readdir, i.e. exactly in the
    // window the race opens.
    const root = tree({ "sub/real.wav": "REAL" });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "OTHER PROJECT DATA");
    const realSub = path.join(root, "sub");
    const originalReaddir = fs.readdirSync;
    let swapped = false;
    fs.readdirSync = function (p, opts) {
        const entries = originalReaddir(p, opts);
        if (!swapped) {
            swapped = true;
            fs.renameSync(realSub, realSub + ".gone");
            fs.symlinkSync(outside, realSub);
        }
        return entries;
    };
    try {
        assert.throws(
            () => readRegularTree(root),
            (err) => err instanceof NonRegularFileError && /sub/.test(err.message),
        );
    } finally {
        fs.readdirSync = originalReaddir;
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
});

test("a symlink in the path above the root is refused", () => {
    // lstat on the root alone cannot see this: <parent>/link is a symlink to
    // another project's data, and the bundle sits "below" it. An fd-walk
    // anchored at "/" opens `link` through its parent's descriptor with
    // O_NOFOLLOW and refuses it there.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
    fs.mkdirSync(path.join(outside, "bundle"));
    fs.writeFileSync(path.join(outside, "bundle", "ok.wav"), "OTHER PROJECT DATA");
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "regular-tree-"));
    fs.symlinkSync(outside, path.join(parent, "link"));
    assert.throws(
        () => readRegularTree(path.join(parent, "link", "bundle")),
        (err) => err instanceof NonRegularFileError && /link/.test(err.message),
    );
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
});
