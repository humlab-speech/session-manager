/**
 * The app.* access code is a bearer credential — JupyterSession.class.js sets it
 * as JUPYTER_TOKEN, so a copy in a log file is a copy that routes in. It reached
 * the journal three ways: the routed request URL (`/?token=…`), whole session
 * objects handed to addLog, and messages interpolating the code by name.
 *
 * Narrow on purpose: `getSessionList()` and `getUserSessions()` hand the code to
 * its own owner over an authorized channel and must keep doing that. These
 * patterns are the logging shapes, not the returning shapes.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");
const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8");

const SessionManager = require(path.join(SRC, "SessionManager.class.js"));

test("a logged code is a reference, not the credential", () => {
    const mgr = Object.create(SessionManager.prototype);
    const code = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

    const ref = mgr.codeRef(code);
    assert.ok(ref.length <= 12, `reference too long to be safe: ${ref}`);
    assert.notStrictEqual(ref, code);
    assert.ok(!ref.includes(code.slice(6)), "reference leaks the tail");

    mgr.sessions = [
        {
            project: { id: "proj_1" },
            user: { username: "some_user" },
            hsApp: "jupyter",
            accessCode: code,
        },
    ];
    const logged = JSON.stringify(mgr.sessionSummaries());
    assert.ok(
        !logged.includes(code),
        "session summaries still carry the full access code",
    );
    assert.match(logged, /proj_1/, "summaries lost what they correlate to");
    assert.match(logged, /some_user/, "summaries lost the owner");
});

test("the logging shapes are gone from both files", () => {
    const banned = [
        ["Session.class.js", "addLog(req.url)"],
        ["SessionManager.class.js", "addLog(req.url)"],
        ["SessionManager.class.js", "addLog(this.sessions)"],
        ["SessionManager.class.js", "sessionAccessCode +"],
        ["SessionManager.class.js", "session.accessCode +"],
        ["Session.class.js", '+ this.accessCode'],
    ];
    for (const [file, needle] of banned) {
        assert.ok(
            !read(file).includes(needle),
            `${file} still logs a credential via: ${needle}`,
        );
    }
});

// The sweep continued after the first pass: the code also reached logs through
// an ownership-refusal message, the shutdown and creation notices, a reject
// reason the top-level handler logs, and two debug dumps of the container
// config (Env carries JUPYTER_TOKEN, the labels carry the code).
test("the second sweep's shapes are gone too", () => {
    const banned = [
        ["ApiServer.class.js", "attempted to access session \" +\n                    session.accessCode"],
        ["ApiServer.class.js", "session.accessCode +\n"],
        ["ApiServer.class.js", '+ msg.sessionAccessCode)'],
        ["ApiServer.class.js", "sending project access code (\" +\n                            session.accessCode +"],
        ["SessionManager.class.js", 'eject("Could not find session " + sessionId)'],
        ["Session.class.js", "${JSON.stringify(containerConfig)}"],
        ["Session.class.js", "${JSON.stringify(libpodSpec)}"],
    ];
    for (const [file, needle] of banned) {
        assert.ok(!read(file).includes(needle), `${file} still logs: ${needle}`);
    }
});

test("logSafe redacts a credential by value, wherever it sits", () => {
    const Session = require(path.join(SRC, "Session.class.js"));
    const code = "ZQ8k3mT9pLw7vR2nX5yH4dJ6cF1bG0sA";
    const s = Object.create(Session.prototype);
    Object.assign(s, {
        accessCode: code,
        app: { sessMan: Object.create(SessionManager.prototype) },
    });

    const dumped = s.logSafe({
        Env: ["JUPYTER_TOKEN=" + code, "PATH=/usr/bin"],
        Labels: { "visp.accessCode": code },
        nested: { socket: `/sessions/${code}/ui.sock` },
    });

    assert.ok(!dumped.includes(code), "the credential survived redaction");
    assert.match(dumped, /#code/, "redaction lost the correlation handle");
    assert.match(dumped, /PATH=\/usr\/bin/, "redaction destroyed unrelated config");
});
