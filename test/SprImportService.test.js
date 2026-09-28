const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
    decideSprImportAction,
    fingerprintUploads,
    sameFileContents,
    QUIET_MS,
    ABANDONED_MS,
} = require("../src/SprImportService.class");

const NOW = 1_800_000_000_000;

function upload(name, ageMs, size = 1000) {
    return { name, size, mtimeMs: NOW - ageMs };
}

function decide(overrides) {
    return decideSprImportAction({
        uploads: [],
        sprImport: undefined,
        filesInDb: [],
        bundlesPresent: false,
        hasQueuedItem: false,
        sealed: true,
        now: NOW,
        ...overrides,
    });
}

test("nothing to do without uploads", () => {
    assert.strictEqual(decide({}).action, "none");
});

test("imports a completed session once uploads have settled", () => {
    const d = decide({ uploads: [upload("prompt_1.wav", QUIET_MS + 1)] });
    assert.strictEqual(d.action, "enqueue");
});

test("waits while uploads are still changing, even if completed", () => {
    // The SPR client sends COMPLETED before its final upload.
    const d = decide({
        uploads: [
            upload("prompt_1.wav", QUIET_MS * 3),
            upload("prompt_2.wav", 1000),
        ],
    });
    assert.strictEqual(d.action, "wait");
    assert.strictEqual(d.recheckAt, NOW - 1000 + QUIET_MS);
});

test("does not import an in-progress session", () => {
    const d = decide({
        uploads: [upload("prompt_1.wav", QUIET_MS * 3)],
        sealed: false,
    });
    assert.strictEqual(d.action, "wait");
});

test("imports an abandoned session so its audio is not stranded", () => {
    const d = decide({
        uploads: [upload("prompt_1.wav", ABANDONED_MS + 1)],
        sealed: false,
    });
    assert.strictEqual(d.action, "enqueue");
    assert.strictEqual(d.reason, "abandoned");
});

test("up to date when the uploads match the last import", () => {
    const uploads = [upload("prompt_1.wav", QUIET_MS * 3)];
    const d = decide({
        uploads,
        sprImport: { status: "imported", fingerprint: fingerprintUploads(uploads) },
    });
    assert.strictEqual(d.action, "none");
});

test("re-imports when a take is re-recorded after import", () => {
    const imported = [upload("prompt_1.wav", QUIET_MS * 10, 1000)];
    const d = decide({
        uploads: [upload("prompt_1.wav", QUIET_MS * 2, 1200)],
        sprImport: { status: "imported", fingerprint: fingerprintUploads(imported) },
    });
    assert.strictEqual(d.action, "enqueue");
});

test("does not queue a session twice", () => {
    const d = decide({
        uploads: [upload("prompt_1.wav", QUIET_MS * 3)],
        hasQueuedItem: true,
    });
    assert.strictEqual(d.action, "none");
});

test("fingerprint ignores directory listing order", () => {
    const a = upload("prompt_1.wav", 5000);
    const b = upload("prompt_2.wav", 6000);
    assert.strictEqual(fingerprintUploads([a, b]), fingerprintUploads([b, a]));
});

test("adopts a consistent legacy session without re-importing", () => {
    const d = decide({
        uploads: [upload("prompt_1.wav", ABANDONED_MS * 2, 500)],
        filesInDb: [{ name: "prompt_1.wav", size: 500 }],
        bundlesPresent: true,
    });
    assert.strictEqual(d.action, "backfill");
    assert.strictEqual(d.reason, "already imported");
});

test("adopts an inconsistent legacy session as is, to avoid resurrecting deletions", () => {
    const d = decide({
        uploads: [
            upload("prompt_1.wav", ABANDONED_MS * 2),
            upload("prompt_2.wav", ABANDONED_MS * 2),
        ],
        filesInDb: [{ name: "prompt_1.wav", size: 1000 }],
        bundlesPresent: false,
    });
    assert.strictEqual(d.action, "backfill");
    assert.notStrictEqual(d.reason, "already imported");
});

test("imports a legacy session that was never imported", () => {
    const d = decide({ uploads: [upload("prompt_1.wav", QUIET_MS + 1)] });
    assert.strictEqual(d.action, "enqueue");
});

test("backs off after a failed import of the same uploads", () => {
    const uploads = [upload("prompt_1.wav", QUIET_MS * 3)];
    const fp = fingerprintUploads(uploads);
    const failed = {
        status: "failed",
        failedFingerprint: fp,
        attempts: 1,
        nextRetryAt: NOW + 60000,
    };
    assert.strictEqual(decide({ uploads, sprImport: failed }).action, "wait");
    assert.strictEqual(
        decide({ uploads, sprImport: { ...failed, nextRetryAt: NOW - 1 } }).action,
        "enqueue",
    );
    assert.strictEqual(
        decide({ uploads, sprImport: { ...failed, nextRetryAt: null } }).action,
        "none",
    );
});

test("a new take after exhausted retries tries again", () => {
    const old = [upload("prompt_1.wav", QUIET_MS * 10, 1000)];
    const d = decide({
        uploads: [upload("prompt_1.wav", QUIET_MS * 2, 1300)],
        sprImport: {
            status: "failed",
            failedFingerprint: fingerprintUploads(old),
            attempts: 4,
            nextRetryAt: null,
        },
    });
    assert.strictEqual(d.action, "enqueue");
});

test("compares bundle audio by content, not by metadata", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spr-import-test-"));
    try {
        const upload = path.join(dir, "upload.wav");
        const bundle = path.join(dir, "bundle.wav");
        fs.writeFileSync(upload, "RIFF-take-2");
        fs.writeFileSync(bundle, "RIFF-take-2");
        // A different mtime alone (restored backup, fresh clone) is not a change.
        fs.utimesSync(bundle, new Date(0), new Date(0));
        assert.strictEqual(sameFileContents(upload, bundle), true);

        fs.writeFileSync(bundle, "RIFF-take-1");
        assert.strictEqual(sameFileContents(upload, bundle), false);

        assert.strictEqual(
            sameFileContents(upload, path.join(dir, "missing.wav")),
            false,
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
