/**
 * Tests for pathSecurity.js — path traversal protection utilities.
 *
 * Run with:  node src/pathSecurity.test.js
 * Exit code: 0 = all pass, 1 = failures
 */

const { safePathComponent, safeJoinedPath, safeMountSource } = require("./pathSecurity");

let passed = 0;
let failed = 0;

function assert(condition, testName) {
    if (condition) {
        passed++;
        console.log(`  ✅ ${testName}`);
    } else {
        failed++;
        console.log(`  ❌ ${testName}`);
    }
}

function assertThrows(fn, testName) {
    try {
        fn();
        failed++;
        console.log(`  ❌ ${testName} — expected Error but none thrown`);
    } catch (e) {
        if (e.message.includes("Path traversal blocked")) {
            passed++;
            console.log(`  ✅ ${testName}`);
        } else {
            failed++;
            console.log(`  ❌ ${testName} — unexpected error: ${e.message}`);
        }
    }
}

function assertDoesNotThrow(fn, testName) {
    try {
        fn();
        passed++;
        console.log(`  ✅ ${testName}`);
    } catch (e) {
        failed++;
        console.log(`  ❌ ${testName} — unexpected error: ${e.message}`);
    }
}

// ============================================================
// safePathComponent tests
// ============================================================
console.log("\n--- safePathComponent ---");

// Valid components
assertDoesNotThrow(() => safePathComponent("abc123", "test"), "alphanumeric");
assertDoesNotThrow(() => safePathComponent("some-project-id", "test"), "with hyphens");
assertDoesNotThrow(() => safePathComponent("user_at_uni_dot_se", "test"), "slugified eppn");
assertDoesNotThrow(() => safePathComponent("XkZ9q2mB", "test"), "nanoid-style");
assertDoesNotThrow(() => safePathComponent("My Project (1)", "test"), "spaces and parens");
assertDoesNotThrow(() => safePathComponent("recording.wav", "test"), "filename with dot");

// Path traversal attempts
assertThrows(() => safePathComponent("../etc/passwd", "test"), "reject ../etc/passwd");
assertThrows(() => safePathComponent("..\\windows\\system32", "test"), "reject ..\\windows");
assertThrows(() => safePathComponent("..", "test"), "reject bare ..");
assertThrows(() => safePathComponent(".", "test"), "reject bare .");
assertThrows(() => safePathComponent("foo/../bar", "test"), "reject embedded ..");
assertThrows(() => safePathComponent("foo/bar", "test"), "reject forward slash");
assertThrows(() => safePathComponent("foo\\bar", "test"), "reject backslash");
assertThrows(() => safePathComponent("foo\0bar", "test"), "reject null byte");
assertThrows(() => safePathComponent("", "test"), "reject empty string");
assertThrows(() => safePathComponent(123, "test"), "reject non-string (number)");
assertThrows(() => safePathComponent(null, "test"), "reject null");
assertThrows(() => safePathComponent(undefined, "test"), "reject undefined");

// ============================================================
// safeJoinedPath tests
// ============================================================
console.log("\n--- safeJoinedPath ---");

// Valid paths
assert(
    safeJoinedPath("/repositories", "abc123") === "/repositories/abc123",
    "simple join"
);
assert(
    safeJoinedPath("/repositories", "abc123", "Data", "VISP_emuDB") ===
        "/repositories/abc123/Data/VISP_emuDB",
    "multi-segment join"
);
assertDoesNotThrow(
    () => safeJoinedPath("/repositories", "abc123"),
    "valid root + component"
);

// Traversal attempts
assertThrows(
    () => safeJoinedPath("/repositories", ".."),
    "reject root + .."
);
assertThrows(
    () => safeJoinedPath("/repositories", "..", "etc", "passwd"),
    "reject root + ../etc/passwd"
);
assertThrows(
    () => safeJoinedPath("/repositories", "abc123", "..", "..", "etc"),
    "reject deep traversal back out"
);
assertThrows(
    () => safeJoinedPath("/repositories", "abc/../../../etc/passwd"),
    "reject traversal in single segment"
);

// Edge case: root itself is OK
assertDoesNotThrow(
    () => {
        const result = safeJoinedPath("/repositories");
        assert(result === "/repositories", "root-only resolves to root");
    },
    "root only"
);

// ============================================================
// safeMountSource tests
// ============================================================
console.log("\n--- safeMountSource ---");

const fakeRoot = "/home/user/Projects/visible-speech-deployment";

assert(
    safeMountSource(fakeRoot, "mounts/repositories/abc123") ===
        fakeRoot + "/mounts/repositories/abc123",
    "valid mount source"
);
assert(
    safeMountSource(fakeRoot, "mounts/apache/apache/uploads/user_at_uni/ctx123") ===
        fakeRoot + "/mounts/apache/apache/uploads/user_at_uni/ctx123",
    "valid upload mount source"
);

assertThrows(
    () => safeMountSource(fakeRoot, "../../etc/passwd"),
    "reject mount traversal"
);
assertThrows(
    () => safeMountSource(fakeRoot, "mounts/repositories/../../.."),
    "reject mount traversal via nested .."
);

// ============================================================
// Integration-style tests (simulating real call patterns)
// ============================================================
console.log("\n--- Integration-style tests ---");

// Simulate malicious projectId in deleteProject
assertThrows(() => {
    const projectId = "../../../etc";
    safePathComponent(projectId, "projectId");
    safeJoinedPath("/repositories", projectId);
}, "malicious projectId blocked at component level");

// Simulate malicious formContextId in upload path
assertThrows(() => {
    const username = "normal_user";
    const context = "../../secrets";
    safePathComponent(username, "username");
    safePathComponent(context, "formContextId");
}, "malicious formContextId blocked");

// Simulate malicious sessionName in receiveFileUpload
assertThrows(() => {
    const sessionName = "../../passwords";
    safePathComponent(sessionName, "sessionName");
}, "malicious sessionName blocked");

// Simulate normal nanoid-based values (should all pass)
assertDoesNotThrow(() => {
    const projectId = "V1StGXR8_Z5jdHi6B-myT";
    const sessionId = "kL7mNp2qR9";
    const username = "john_at_uni_dot_se";
    const formContextId = "Xk2mB_nQ9R";
    safePathComponent(projectId, "projectId");
    safePathComponent(sessionId, "sessionId");
    safePathComponent(username, "username");
    safePathComponent(formContextId, "formContextId");
    safeJoinedPath("/repositories", projectId);
    safeMountSource(fakeRoot, "mounts/repositories/" + projectId);
    safeMountSource(fakeRoot, "mounts/apache/apache/uploads/" + username + "/" + formContextId);
}, "typical real-world values pass all checks");

// ============================================================
// Summary
// ============================================================
console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
