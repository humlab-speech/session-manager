const test = require("node:test");
const assert = require("node:assert");
const {
    ORIGIN_UPLOAD,
    ORIGIN_RECORDING,
    sessionSources,
    fileOrigin,
    bundleName,
    filesOfOrigin,
    withRecordings,
    withUploads,
    promptItemCodes,
    findUploadNameClashes,
    findTakesClashingWithUploads,
} = require("../src/sessionFiles");

const mixedSession = {
    dataSource: "record",
    files: [
        { name: "interview.wav", size: 500, origin: ORIGIN_UPLOAD },
        { name: "prompt_1.wav", size: 100, origin: ORIGIN_RECORDING },
    ],
};

test("files without an origin belong to the session's only source", () => {
    assert.strictEqual(
        fileOrigin({ name: "a.wav" }, { dataSource: "record" }),
        ORIGIN_RECORDING,
    );
    assert.strictEqual(
        fileOrigin({ name: "a.wav" }, { dataSource: "upload" }),
        ORIGIN_UPLOAD,
    );
    assert.strictEqual(fileOrigin({ name: "a.wav" }, {}), ORIGIN_UPLOAD);
    assert.strictEqual(
        fileOrigin(
            { name: "a.wav", origin: ORIGIN_UPLOAD },
            { dataSource: "record" },
        ),
        ORIGIN_UPLOAD,
    );
});

test("bundle names follow import_mediaFiles", () => {
    assert.strictEqual(bundleName("my file.wav"), "my_file");
    assert.strictEqual(bundleName("prompt_1"), "prompt_1");
    assert.strictEqual(bundleName("a.b.wav"), "a.b");
});

test("an import replaces the recordings and keeps the uploads", () => {
    const files = withRecordings(mixedSession, [
        { name: "prompt_1.wav", size: 150 },
        { name: "prompt_2.wav", size: 200 },
    ]);
    assert.deepStrictEqual(files, [
        { name: "interview.wav", size: 500, origin: ORIGIN_UPLOAD },
        { name: "prompt_1.wav", size: 150, origin: ORIGIN_RECORDING },
        { name: "prompt_2.wav", size: 200, origin: ORIGIN_RECORDING },
    ]);
});

test("an import into a legacy recorded session replaces its whole list", () => {
    const legacy = {
        dataSource: "record",
        files: [{ name: "prompt_1.wav" }, { name: "prompt_9.wav" }],
    };
    assert.deepStrictEqual(
        withRecordings(legacy, [{ name: "prompt_1.wav", size: 1 }]),
        [{ name: "prompt_1.wav", size: 1, origin: ORIGIN_RECORDING }],
    );
});

test("an import never touches a legacy upload session's files", () => {
    const legacy = { dataSource: "upload", files: [{ name: "a.wav" }] };
    assert.deepStrictEqual(withRecordings(legacy, []), [
        { name: "a.wav", origin: ORIGIN_UPLOAD },
    ]);
});

test("a save keeps the stored list, sizes included, and adds new uploads", () => {
    const files = withUploads(mixedSession, [{ name: "notes.wav", size: 7 }]);
    assert.deepStrictEqual(files, [
        { name: "interview.wav", size: 500, origin: ORIGIN_UPLOAD },
        { name: "prompt_1.wav", size: 100, origin: ORIGIN_RECORDING },
        { name: "notes.wav", size: 7, origin: ORIGIN_UPLOAD },
    ]);
});

test("a save never adds a second file for an existing bundle", () => {
    const files = withUploads(mixedSession, [
        { name: "prompt_1.wav", size: 9 },
        { name: "new.wav", size: 1 },
        { name: "new.wav", size: 2 },
    ]);
    assert.deepStrictEqual(
        files.map((f) => [f.name, f.size]),
        [
            ["interview.wav", 500],
            ["prompt_1.wav", 100],
            ["new.wav", 1],
        ],
    );
});

test("filesOfOrigin infers the origin of legacy entries", () => {
    const legacy = { dataSource: "record", files: [{ name: "p.wav" }] };
    assert.strictEqual(filesOfOrigin(legacy, ORIGIN_RECORDING).length, 1);
    assert.strictEqual(filesOfOrigin(legacy, ORIGIN_UPLOAD).length, 0);
});

test("promptItemCodes collects every prompt's item code", () => {
    const script = {
        sections: [
            {
                groups: [
                    {
                        promptItems: [
                            { itemcode: "prompt_1" },
                            { itemcode: "prompt_2" },
                        ],
                    },
                ],
            },
            { groups: [{ promptItems: [{ itemcode: "extra" }, {}] }] },
        ],
    };
    assert.deepStrictEqual(promptItemCodes(script), [
        "prompt_1",
        "prompt_2",
        "extra",
    ]);
    assert.deepStrictEqual(promptItemCodes(null), []);
});

test("uploads clash with stored files, each other and prompts", () => {
    const clashes = findUploadNameClashes(
        { files: [{ name: "my file.wav" }] },
        ["my_file.wav", "fresh.wav", "fresh.wav", "prompt_3.wav", "ok.wav"],
        ["prompt_3"],
    );
    assert.deepStrictEqual(clashes, [
        { name: "my_file.wav", reason: "existing" },
        { name: "fresh.wav", reason: "duplicate" },
        { name: "prompt_3.wav", reason: "prompt" },
    ]);
});

test("uploads without clashes pass", () => {
    assert.deepStrictEqual(
        findUploadNameClashes({ files: [] }, ["a.wav", "b.wav"], ["c"]),
        [],
    );
});

test("takes that would replace an uploaded file are found", () => {
    assert.deepStrictEqual(
        findTakesClashingWithUploads(mixedSession, [
            "interview.wav",
            "prompt_1.wav",
        ]),
        ["interview.wav"],
    );
    // A legacy recorded session holds only recordings.
    assert.deepStrictEqual(
        findTakesClashingWithUploads(
            { dataSource: "record", files: [{ name: "p.wav" }] },
            ["p.wav"],
        ),
        [],
    );
});

test("legacy sessions use the one source their dataSource names", () => {
    assert.deepStrictEqual(sessionSources({ dataSource: "upload" }), {
        upload: true,
        record: false,
    });
    assert.deepStrictEqual(sessionSources({ dataSource: "record" }), {
        upload: false,
        record: true,
    });
    assert.deepStrictEqual(sessionSources({}), { upload: true, record: false });
});

test("the source flags override dataSource", () => {
    assert.deepStrictEqual(
        sessionSources({
            dataSource: "upload",
            uploadEnabled: true,
            recordEnabled: true,
        }),
        { upload: true, record: true },
    );
    assert.deepStrictEqual(
        sessionSources({ dataSource: "record", uploadEnabled: true }),
        { upload: true, record: true },
    );
});
