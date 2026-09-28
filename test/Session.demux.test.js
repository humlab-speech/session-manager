const test = require("node:test");
const assert = require("node:assert");
const Session = require("../src/Session.class");

function frame(streamType, text) {
    const payload = Buffer.from(text);
    const header = Buffer.alloc(8);
    header[0] = streamType;
    header.writeUInt32BE(payload.length, 4);
    return Buffer.concat([header, payload]);
}

test("frames are stripped and their payloads joined in order", () => {
    const out = Buffer.concat([
        frame(1, "log line\n"),
        frame(2, "warning\n"),
        frame(1, '{"code":200}'),
    ]);
    assert.strictEqual(
        Session.demuxExecOutput(out).toString(),
        'log line\nwarning\n{"code":200}',
    );
});

test("JSON longer than one frame survives", () => {
    const json = JSON.stringify({ body: "x".repeat(20000) });
    const out = Buffer.concat([
        frame(1, json.slice(0, 8192)),
        frame(1, json.slice(8192, 16384)),
        frame(1, json.slice(16384)),
    ]);
    assert.strictEqual(
        JSON.parse(Session.demuxExecOutput(out).toString()).body.length,
        20000,
    );
});

test("unframed output is returned as it is", () => {
    const raw = Buffer.from('{"code":200}');
    assert.strictEqual(Session.demuxExecOutput(raw).toString(), '{"code":200}');
    assert.strictEqual(Session.demuxExecOutput(Buffer.alloc(0)).length, 0);
});

test("a truncated last frame keeps the bytes that did arrive", () => {
    const out = Buffer.concat([
        frame(1, "complete "),
        frame(1, "truncated").subarray(0, 12),
    ]);
    const text = Session.demuxExecOutput(out).toString();
    assert.ok(text.startsWith("complete "));
});
