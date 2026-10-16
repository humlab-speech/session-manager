const test = require("node:test");
const assert = require("node:assert");
const { createApiServer, wsRecorder } = require("../test-helpers/fake-mongoose.js");
const ApiServer = require("../src/ApiServer.class");

// The signed-out detection on the webclient side reads data.data.reason while
// other handlers read the top level. The server emits both; if either position
// regresses, the signed-out UI silently stops firing (that bug shipped for
// whole releases). This test pins the wire shape from the server side.

function deny(reason) {
    const api = createApiServer(ApiServer);
    const ws = wsRecorder();
    api.denyAccess(ws, { requestId: "r1", cmd: "saveProject" }, reason);
    return ws.sent[0];
}

test("denyAccess: reason at BOTH positions, parseable frame", () => {
    const frame = deny("authentication");
    assert.strictEqual(frame.type, "cmd-result");
    assert.strictEqual(frame.result, false);
    assert.strictEqual(frame.reason, "authentication");
    assert.strictEqual(frame.data.reason, "authentication");
    assert.strictEqual(frame.statusCode, 401);
});

test("denyAccess: authorization variant keeps 403 + both positions", () => {
    const frame = deny("authorization");
    assert.strictEqual(frame.reason, "authorization");
    assert.strictEqual(frame.data.reason, "authorization");
    assert.strictEqual(frame.statusCode, 403);
});

test("denyAccess: default reason stays authorization", () => {
    const api = createApiServer(ApiServer);
    const ws = wsRecorder();
    api.denyAccess(ws, { requestId: "r1", cmd: "x" });
    assert.strictEqual(ws.sent[0].reason, "authorization");
    assert.strictEqual(ws.sent[0].data.reason, "authorization");
});
