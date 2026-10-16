const test = require("node:test");
const assert = require("node:assert");
const ApiServer = require("../src/ApiServer.class");

// Item codes name the recorded takes (<code>.wav in the session's upload dir), so
// a number that has been handed out must never come back into service. saveSprScripts
// stores this high-water mark on the script; the editor seeds from it.
const items = (...codes) => codes.map((code) => ({ itemcode: code }));

test("the mark never walks back when prompts are deleted or emptied", () => {
    const stored = { itemcodeSeq: 7 };
    // The saved script now only carries prompt_1..prompt_3.
    assert.equal(
        ApiServer.nextItemcodeSeq(
            stored,
            3,
            items("prompt_1", "prompt_2", "prompt_3"),
        ),
        7,
    );
});

test("a number counted by the editor is kept even if no prompt was saved with it", () => {
    assert.equal(
        ApiServer.nextItemcodeSeq({ itemcodeSeq: 3 }, 12, items("prompt_2")),
        12,
    );
});

test("the codes actually saved raise the mark", () => {
    assert.equal(
        ApiServer.nextItemcodeSeq(
            { itemcodeSeq: 3 },
            3,
            items("prompt_3", "prompt_12"),
        ),
        12,
    );
});

test("codes that are not prompt_N neither raise nor lower it", () => {
    assert.equal(
        ApiServer.nextItemcodeSeq(
            { itemcodeSeq: 9 },
            undefined,
            items("wordlist", "", undefined),
        ),
        9,
    );
});

test("a script without a mark starts from its own prompts", () => {
    assert.equal(
        ApiServer.nextItemcodeSeq(
            null,
            undefined,
            items("prompt_4", "prompt_5"),
        ),
        5,
    );
    assert.equal(ApiServer.nextItemcodeSeq(undefined, undefined, undefined), 0);
});
