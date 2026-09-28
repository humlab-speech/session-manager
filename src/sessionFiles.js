/**
 * A session's audio can come from two sources: files uploaded through the
 * project dialog, and takes recorded online and imported by SprImportService.
 * sessions[].files lists both. Each entry's `origin` says which source owns it,
 * so each source replaces only its own entries and never the other's.
 *
 * Every file becomes an EMU-DB bundle named after it, so bundle names must be
 * unique across both sources within a session.
 */
const path = require("path");

const ORIGIN_UPLOAD = "upload";
const ORIGIN_RECORDING = "recording";

/**
 * Which sources a session uses. Each can be switched on and off on its own;
 * sessions from before that have only `dataSource`, "upload" or "record".
 */
function sessionSources(session) {
    const legacyRecord = session.dataSource === "record";
    return {
        upload:
            typeof session.uploadEnabled === "boolean"
                ? session.uploadEnabled
                : !legacyRecord,
        record:
            typeof session.recordEnabled === "boolean"
                ? session.recordEnabled
                : legacyRecord,
    };
}

// Entries written before origins existed belong to the session's only source.
function fileOrigin(file, session) {
    if (file.origin === ORIGIN_UPLOAD || file.origin === ORIGIN_RECORDING) {
        return file.origin;
    }
    return session.dataSource === "record" ? ORIGIN_RECORDING : ORIGIN_UPLOAD;
}

// emuR's import_mediaFiles names a bundle after its file, spaces replaced by
// underscores.
function bundleName(fileName) {
    return path.parse(String(fileName)).name.replace(/ /g, "_");
}

function taggedFiles(session) {
    return (session.files || []).map((f) => ({
        ...f,
        origin: fileOrigin(f, session),
    }));
}

function filesOfOrigin(session, origin) {
    return taggedFiles(session).filter((f) => f.origin === origin);
}

// The file list after an import: the session's recordings are exactly
// `takes`; uploaded files are kept as they are.
function withRecordings(session, takes) {
    return filesOfOrigin(session, ORIGIN_UPLOAD).concat(
        takes.map((t) => ({ ...t, origin: ORIGIN_RECORDING })),
    );
}

// The file list after a dialog save: the stored list plus the files uploaded
// in this save. The stored list is authoritative; the dialog's copy may be
// stale and lacks sizes. An upload whose bundle already exists is skipped
// (validation refuses those before anything is written).
function withUploads(session, uploads) {
    const files = taggedFiles(session);
    const taken = new Set(files.map((f) => bundleName(f.name)));
    for (const upload of uploads) {
        const name = bundleName(upload.name);
        if (!taken.has(name)) {
            taken.add(name);
            files.push({ ...upload, origin: ORIGIN_UPLOAD });
        }
    }
    return files;
}

// The item codes of an SPR script; each take is imported as <itemcode>.wav.
function promptItemCodes(script) {
    const codes = [];
    for (const section of script?.sections || []) {
        for (const group of section.groups || []) {
            for (const item of group.promptItems || []) {
                if (item.itemcode) {
                    codes.push(String(item.itemcode));
                }
            }
        }
    }
    return codes;
}

/**
 * Uploads that can't become bundles because their name is taken: by a file
 * already in the session, by another upload in the same save, or by a prompt
 * of the session's recording script (whose take would replace the upload).
 *
 * @returns {Array<{name: string, reason: "existing"|"duplicate"|"prompt"}>}
 */
function findUploadNameClashes(session, uploadNames, itemCodes = []) {
    const existing = new Set(
        (session.files || []).map((f) => bundleName(f.name)),
    );
    const prompts = new Set(itemCodes.map((c) => bundleName(c)));
    const seen = new Set();
    const clashes = [];
    for (const name of uploadNames) {
        const bundle = bundleName(name);
        if (existing.has(bundle)) {
            clashes.push({ name, reason: "existing" });
        } else if (seen.has(bundle)) {
            clashes.push({ name, reason: "duplicate" });
        } else if (prompts.has(bundle)) {
            clashes.push({ name, reason: "prompt" });
        }
        seen.add(bundle);
    }
    return clashes;
}

// Takes that would replace an uploaded file's bundle.
function findTakesClashingWithUploads(session, takeNames) {
    const uploaded = new Set(
        filesOfOrigin(session, ORIGIN_UPLOAD).map((f) => bundleName(f.name)),
    );
    return takeNames.filter((name) => uploaded.has(bundleName(name)));
}

module.exports = {
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
};
