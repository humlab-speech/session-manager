const test = require("node:test");
const assert = require("node:assert");
const ApiServer = require("../src/ApiServer.class");
const Session = require("../src/Session.class");
const { createApiServer } = require("../test-helpers/fake-mongoose.js");

// Contract: container-agent src/main.mjs copy-docs parses DOC_FILES with
// JSON.parse(process.env.DOC_FILES).map(f => (f && f.name) ? f.name : f)
// and copies only those entries from UPLOAD_PATH/docs into PROJECT_PATH/Documents.
// The entries are matched against the names ON DISK, which come from api.php's
// uploadFile() storing sanitize($fileMeta->filename) - not the browser's
// File.name that the webclient puts in projectFormData.docFiles.
const containerAgentParse = (envValue) =>
    JSON.parse(envValue).map((f) => (f && f.name ? f.name : f));

const parse = (formData) =>
    containerAgentParse(
        ApiServer.prototype
            .buildDocFilesEnv(formData)
            .slice("DOC_FILES=".length),
    );

test("buildDocFilesEnv yields a DOC_FILES allow list", () => {
    const api = createApiServer(ApiServer);
    const env = api.buildDocFilesEnv({
        docFiles: [{ name: "with space.pdf" }, { name: "consent.pdf" }],
    });
    assert.ok(env.startsWith("DOC_FILES="));
    assert.deepStrictEqual(
        containerAgentParse(env.slice("DOC_FILES=".length)),
        ["with_space.pdf", "consent.pdf"],
    );
    // No docFiles in payload -> no env var -> container-agent keeps old behaviour
    assert.strictEqual(api.buildDocFilesEnv({}), null);
    assert.strictEqual(api.buildDocFilesEnv(null), null);
    // Empty list is sent: user removed every document, nothing may be copied
    assert.strictEqual(api.buildDocFilesEnv({ docFiles: [] }), "DOC_FILES=[]");
});

test("DOC_FILES carries the sanitized disk name, not the browser name", () => {
    // api.php sanitize("consent report (v1).pdf") == "consent_report_v1.pdf",
    // which is the name sitting in UPLOAD_PATH/docs. Handing over the browser
    // name would match nothing and the kept document would vanish.
    assert.deepStrictEqual(
        parse({
            docFiles: [
                {
                    name: "consent report (v1).pdf",
                    size: 1,
                    type: "application/pdf",
                },
            ],
        }),
        ["consent_report_v1.pdf"],
    );
    // Mirrors api.php's character class: strip () , : ; & " ' etc, collapse
    // whitespace runs to _, leave the dot of the extension alone.
    assert.deepStrictEqual(
        parse({ docFiles: [{ name: "a,b (c): d;e & \"f\" 'g' <h>.pdf" }] }),
        ["ab_c_de_f_g_.pdf"],
    );
    // api.php's uploadFile() returns only "File uploaded successfully.", so the
    // payload never carries a stored name; the browser name is what has to be
    // sanitized (any stray storedName is ignored).
    assert.deepStrictEqual(
        parse({
            docFiles: [
                {
                    name: "consent report (v1).pdf",
                    storedName: "not-a-real-field.pdf",
                },
            ],
        }),
        ["consent_report_v1.pdf"],
    );
});

test("sanitizeFileName mirrors api.php's active mojibake strip entries", () => {
    const sanitize = (n) => ApiServer.prototype.sanitizeFileName(n);
    // api.php's $strip holds the double-encoded em dash "â€”" (bytes
    // c3 a2 e2 82 ac e2 80 9d = \u00e2\u20ac\u201d) as a whole sequence; its
    // characters are not stripped individually, so the whole sequence must
    // vanish - that is the disk name api.php's sanitize() produces for such an
    // upload. (The en dash entry is pinned in sanitizeEquivalence.test.js.)
    assert.strictEqual(
        sanitize("safety\u00e2\u20ac\u201dsummary.pdf"),
        "safetysummary.pdf",
    );
    // The entity entries of $strip stay inert in api.php ("&", "#", ";" are
    // stripped earlier in the same array), so "&#8212;" survives there as "8212;"
    // minus "&", "#", ";" -> "8212". The mirror matches by only stripping the
    // single characters.
    assert.strictEqual(sanitize("a&#8212;b.pdf"), "a8212b.pdf");
    // A well-formed em dash is untouched in api.php too.
    assert.strictEqual(
        sanitize("safety\u2014summary.pdf"),
        "safety\u2014summary.pdf",
    );
});

test("sanitizeFileName matches PHP strip_tags on an unterminated '<'", () => {
    // PHP: an unclosed "<" eats the rest of the string, it does not merely
    // leave the trailing text behind. ("a<b>c<d" itself is pinned in
    // sanitizeEquivalence.test.js.)
    assert.strictEqual(ApiServer.prototype.sanitizeFileName("a<b"), "a");
    assert.strictEqual(
        ApiServer.prototype.sanitizeFileName("rep<b>ort.pdf<x"),
        "report.pdf",
    );
});

test("copyUploadedDocs passes DOC_FILES intact to the container exec env (spawn stubbed)", async () => {
    const api = createApiServer(ApiServer);
    const session = Object.create(Session.prototype);
    session.app = { addLog: () => {} };
    let captured = null;
    session.runCommand = async (cmd, env) => {
        captured = { cmd, env };
        return '{"code":200,"body":"Copied 1 files"}';
    };

    const envVars = [
        "PROJECT_PATH=/home/jovyan/project",
        "UPLOAD_PATH=/home/uploads",
    ];
    const docFilesEnv = api.buildDocFilesEnv({
        docFiles: [{ name: "a b;rm -rf$.pdf" }],
    });
    if (docFilesEnv !== null) envVars.push(docFilesEnv);

    const result = await session.copyUploadedDocs(envVars);
    assert.strictEqual(JSON.parse(result).code, 200);
    assert.deepStrictEqual(captured.cmd, [
        "node",
        "/container-agent/main.js",
        "copy-docs",
    ]);
    // Env travels as an argv array (docker exec Env / execFileSync), never a
    // shell string, so quotes/spaces survive as one untouched entry.
    const docEntry = captured.env.find((e) => e.startsWith("DOC_FILES="));
    assert.strictEqual(
        captured.env.filter((e) => e.startsWith("DOC_FILES=")).length,
        1,
    );
    assert.deepStrictEqual(
        containerAgentParse(docEntry.slice("DOC_FILES=".length)),
        ["a_brm_-rf.pdf"],
    );
});
