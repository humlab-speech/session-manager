const test = require("node:test");
const assert = require("node:assert");
const ApiServer = require("../src/ApiServer.class");

// The whole point of sanitizeFileName is that api.php's sanitize() decides the name
// an upload gets on disk (uploadFileName() applies no other transform), so any name
// sanitized differently here names a file that does not exist - and copy-docs then
// refuses the save over an invisible character. JS trims and matches \s per code
// point; PHP trims and matches \s per byte (ASCII only). These vectors are where the
// two disagreed.
function createApi() {
    const api = Object.create(ApiServer.prototype);
    api.app = { addLog: () => {} };
    return api;
}

test("sanitizeFileName matches PHP's whitespace semantics", () => {
    const api = createApi();
    const cases = {
        "a\u00a0b": "a\u00a0b", // NBSP survives, exactly as api.php writes it
        "\u00a0consent report": "\u00a0consent_report", // leading NBSP is not PHP trim's set
        "a \u00a0 b": "a_\u00a0_b", // ASCII spaces collapse alone, NBSP does not join in
        "a\u2028b": "a\u2028b", // line separator is not PHP whitespace
        "a\ufeffb": "a\ufeffb", // nor is a BOM
        "a\u3000b": "a\u3000b", // nor an ideographic space
        "a\u200b\u00a0b": "a\u200b\u00a0b", // zero-width space likewise
        "a\fb": "a_b", // but form feed and vertical tab ARE PCRE \s...
        "a\vb": "a_b",
        "\fa": "_a", // ...and are NOT PHP trim's set, so they reach the collapse
        "a \t\n b": "a_b",
        "  spaced  ": "spaced",
        "": "",
    };
    for (const [input, expected] of Object.entries(cases)) {
        assert.equal(
            api.sanitizeFileName(input),
            expected,
            JSON.stringify(input),
        );
    }
});

test("the strip list and the tag rules are unchanged by the whitespace fix", () => {
    const api = createApi();
    assert.equal(
        api.sanitizeFileName("consent report (v1).pdf"),
        "consent_report_v1.pdf",
    );
    assert.equal(api.sanitizeFileName("a<b>c<d"), "ac"); // strip_tags eats to EOF on an unterminated "<"
    // the mojibake en/em dash entries of api.php's $strip
    assert.equal(api.sanitizeFileName("â€“dash"), "dash");
});

test("every character the trim class claims is actually trimmed", () => {
    // The collapse class is pinned by the a\fb / a\vb vectors above; without these
    // the trim class could drop \r, \v or \0 and the suite would not notice.
    const api = createApi();
    const cases = {
        "\ra": "a",
        "\va": "a",
        "\u0000a": "a",
        "\fa": "_a", // form feed is NOT in PHP's trim() set, so it reaches the collapse
        "\f": "_", // a name that is only a form feed collapses to one underscore
        " \f ": "_", // trimmed around, then collapsed
        "a\r\nb": "a_b",
        "a  b": "a  b", // two NBSP: nothing collapses, nothing trims
        "\u2028a\u2029": "\u2028a\u2029",
    };
    for (const [input, expected] of Object.entries(cases)) {
        assert.equal(
            api.sanitizeFileName(input),
            expected,
            JSON.stringify(input),
        );
    }
});
