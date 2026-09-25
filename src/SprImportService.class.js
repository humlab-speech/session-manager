/**
 * Imports audio recorded with the online speech recorder (wsrng-server) into
 * project EMU-DBs.
 *
 * wsrng-server moves every uploaded take to
 *   /repositories/<projectId>/Data/speech_recorder_uploads/emudb-sessions/<sessionId>/<itemcode>.wav
 * and this service makes the EMU-DB match that directory. It works by
 * comparing state rather than reacting to events: each recording session
 * remembers a fingerprint of the uploads it last imported (sessions[].sprImport),
 * and any session whose uploads no longer match is imported again once they
 * have stopped changing. wsrng-server's POST to /api/importaudiofiles is only a
 * hint to check a session sooner. A lost hint, a restart of either service, a
 * re-take or a slow final upload therefore only delays an import, never loses it.
 *
 * An import only replaces bundles whose audio differs from the upload (or is
 * missing), compared byte for byte, so the annotations of every other bundle
 * in the session survive a re-take. The fingerprint is only a cheap
 * name/size/mtime check for deciding when to look, so an mtime change alone
 * (a restored backup, a fresh clone) costs a comparison, not the annotations.
 */

const fs = require("fs");
const { safePathComponent, safeJoinedPath } = require("./pathSecurity");

// Uploads must be unchanged for this long before importing. The SPR client
// sends COMPLETED before its final upload, and a participant may re-record.
const QUIET_MS = 10 * 1000;
// A session that was never completed (participant gave up, skipped prompts) is
// imported anyway once its uploads have been idle this long, so audio is never
// stranded.
const ABANDONED_MS = 30 * 60 * 1000;
const SCAN_INTERVAL_MS = 30 * 1000;
// Retry delays after a failed import of the same uploads; once exhausted the
// session stays failed until its uploads change (e.g. a new take).
const RETRY_DELAYS_MS = [60 * 1000, 5 * 60 * 1000, 30 * 60 * 1000];

function fingerprintUploads(uploads) {
    return uploads
        .map((u) => u.name + ":" + u.size + ":" + Math.round(u.mtimeMs))
        .sort()
        .join("|");
}

function sameFileContents(a, b) {
    try {
        if (fs.statSync(a).size !== fs.statSync(b).size) {
            return false;
        }
        return fs.readFileSync(a).equals(fs.readFileSync(b));
    } catch (err) {
        if (err.code === "ENOENT") {
            return false;
        }
        throw err;
    }
}

/**
 * Decide what to do about one recording session. Pure, so it can be tested
 * without a filesystem or database.
 *
 * @param {object} s
 * @param {Array<{name,size,mtimeMs}>} s.uploads   current upload directory contents
 * @param {object|undefined} s.sprImport           session's stored import state
 * @param {Array<{name,size}>} s.filesInDb         session's files list in Mongo
 * @param {boolean} s.bundlesPresent               every upload exists as an EMU-DB bundle
 * @param {boolean} s.hasQueuedItem                a pending/processing import exists
 * @param {boolean} s.sealed                       SPR session was completed
 * @param {number} s.now
 * @returns {{action: "none"|"wait"|"backfill"|"enqueue", reason: string, recheckAt?: number}}
 */
function decideSprImportAction(s) {
    if (s.uploads.length === 0) {
        return { action: "none", reason: "no uploads" };
    }
    const fingerprint = fingerprintUploads(s.uploads);
    const state = s.sprImport;
    if (state && state.fingerprint === fingerprint) {
        return { action: "none", reason: "up to date" };
    }
    if (s.hasQueuedItem) {
        return { action: "none", reason: "already queued" };
    }

    // Sessions imported before this service existed have no stored state.
    // Adopt any that were imported at least once, as they are, rather than
    // re-importing: back then deleting a file removed only its bundle, not the
    // upload, so re-importing could bring deleted recordings back.
    if (!state && s.filesInDb.length > 0) {
        const dbSizes = new Map(s.filesInDb.map((f) => [f.name, f.size]));
        const consistent =
            s.bundlesPresent &&
            s.uploads.every((u) => dbSizes.get(u.name) === u.size);
        return {
            action: "backfill",
            reason: consistent
                ? "already imported"
                : "imported before import tracking; uploads differ from the EMU-DB, leaving as is",
        };
    }

    if (
        state &&
        state.status === "failed" &&
        state.failedFingerprint === fingerprint
    ) {
        if (!state.nextRetryAt) {
            return {
                action: "none",
                reason: "import failed; retries exhausted",
            };
        }
        if (s.now < state.nextRetryAt) {
            return {
                action: "wait",
                reason: "retry backoff",
                recheckAt: state.nextRetryAt,
            };
        }
    }

    const newest = Math.max(...s.uploads.map((u) => u.mtimeMs));
    if (s.now - newest < QUIET_MS) {
        return {
            action: "wait",
            reason: "uploads still changing",
            recheckAt: newest + QUIET_MS,
        };
    }
    if (!s.sealed && s.now - newest < ABANDONED_MS) {
        return {
            action: "wait",
            reason: "recording session in progress",
            recheckAt: newest + ABANDONED_MS,
        };
    }
    return { action: "enqueue", reason: s.sealed ? "complete" : "abandoned" };
}

class SprImportService {
    constructor(app, apiServer) {
        this.app = app;
        this.apiServer = apiServer;
        this.checkTimers = new Map();
        this.scanning = false;
        this.processing = false;
    }

    get ImportQueueItem() {
        return this.apiServer.mongoose.model("ImportQueueItem");
    }

    get projectsCollection() {
        return this.apiServer.mongoose.model("Project").collection;
    }

    async start() {
        this.app.addLog("Starting SPR import service", "info");
        // An item left "processing" was interrupted by a restart; the import is
        // idempotent, so just run it again.
        const reset = await this.ImportQueueItem.updateMany(
            { status: "processing" },
            { $set: { status: "pending", updatedAt: new Date() } },
        );
        if (reset.modifiedCount > 0) {
            this.app.addLog(
                "Re-queued " + reset.modifiedCount + " interrupted import(s)",
                "warn",
            );
        }
        setInterval(() => this.scanAll(), SCAN_INTERVAL_MS);
        this.scanAll();
    }

    // Called when wsrng-server reports activity on a session. Checking right
    // away would usually find the uploads still settling, so wait out the
    // quiet period first.
    requestCheck(projectId, sessionId) {
        safePathComponent(projectId, "projectId");
        safePathComponent(sessionId, "sessionId");
        this.scheduleCheck(projectId, sessionId, Date.now() + QUIET_MS + 1000);
    }

    scheduleCheck(projectId, sessionId, at) {
        const key = projectId + "/" + sessionId;
        clearTimeout(this.checkTimers.get(key));
        const timer = setTimeout(
            () => {
                this.checkTimers.delete(key);
                this.checkSession(projectId, sessionId).catch((err) =>
                    this.app.addLog(
                        "SPR import check failed for session " +
                            sessionId +
                            ": " +
                            err.message,
                        "error",
                    ),
                );
            },
            Math.max(0, at - Date.now()),
        );
        this.checkTimers.set(key, timer);
    }

    async scanAll() {
        if (this.scanning || !this.apiServer.mongoose) {
            return;
        }
        this.scanning = true;
        try {
            const projects = await this.projectsCollection
                .find(
                    {
                        archived: { $ne: true },
                        "sessions.dataSource": "record",
                    },
                    { projection: { id: 1, sessions: 1 } },
                )
                .toArray();
            for (const project of projects) {
                for (const session of project.sessions || []) {
                    if (session.dataSource !== "record" || session.deleted) {
                        continue;
                    }
                    try {
                        await this.evaluate(project.id, session);
                    } catch (err) {
                        this.app.addLog(
                            "SPR import scan failed for session " +
                                session.id +
                                ": " +
                                err.message,
                            "error",
                        );
                    }
                }
            }
        } catch (err) {
            this.app.addLog("SPR import scan failed: " + err.message, "error");
        } finally {
            this.scanning = false;
        }
        this.processQueue();
    }

    async checkSession(projectId, sessionId) {
        const project = await this.projectsCollection.findOne(
            { id: projectId },
            { projection: { id: 1, sessions: 1 } },
        );
        const session = project?.sessions?.find((s) => s.id === sessionId);
        if (!session) {
            this.app.addLog(
                "SPR import check: session " +
                    sessionId +
                    " not found in project " +
                    projectId,
                "warn",
            );
            return;
        }
        await this.evaluate(projectId, session);
        this.processQueue();
    }

    async evaluate(projectId, session) {
        const uploads = this.listUploads(projectId, session.id);
        const state = session.sprImport;
        // Cheap early outs before touching the database.
        if (uploads.length === 0) {
            return;
        }
        if (state && state.fingerprint === fingerprintUploads(uploads)) {
            return;
        }

        const now = Date.now();
        const sprSession = await this.apiServer.fetchSprSession(session.id);
        const decision = decideSprImportAction({
            uploads,
            sprImport: state,
            filesInDb: session.files || [],
            bundlesPresent:
                !state &&
                this.missingBundles(projectId, session, uploads).length === 0,
            hasQueuedItem: !!(await this.ImportQueueItem.exists({
                projectId: projectId,
                sessionId: session.id,
                status: { $in: ["pending", "processing"] },
            })),
            sealed: !!sprSession?.sealed,
            now,
        });

        switch (decision.action) {
            case "backfill": {
                this.app.addLog(
                    "Adopting SPR session " +
                        session.id +
                        " into import tracking: " +
                        decision.reason,
                    decision.reason === "already imported" ? "info" : "warn",
                );
                await this.setImportState(projectId, session.id, {
                    status: "imported",
                    fingerprint: fingerprintUploads(uploads),
                    fileCount: uploads.length,
                    importedAt: null,
                    updatedAt: new Date(),
                });
                break;
            }
            case "wait":
                // Short waits get a timer; long ones are covered by the scan.
                if (decision.recheckAt - now <= SCAN_INTERVAL_MS) {
                    this.scheduleCheck(
                        projectId,
                        session.id,
                        decision.recheckAt,
                    );
                }
                break;
            case "enqueue":
                this.app.addLog(
                    "Queueing SPR import for session " +
                        session.id +
                        " (" +
                        decision.reason +
                        ")",
                    "info",
                );
                await new this.ImportQueueItem({
                    projectId: projectId,
                    sessionId: session.id,
                    status: "pending",
                    createdAt: new Date(),
                }).save();
                await this.setImportState(projectId, session.id, {
                    status: "pending",
                    updatedAt: new Date(),
                });
                break;
        }
    }

    // Drain the queue one item at a time. Imports of one project share its
    // EMU-DB, so they must not run concurrently.
    async processQueue() {
        if (this.processing || !this.apiServer.mongoose) {
            return;
        }
        this.processing = true;
        try {
            let item;
            while (
                (item = await this.ImportQueueItem.findOneAndUpdate(
                    { status: "pending" },
                    { $set: { status: "processing", updatedAt: new Date() } },
                    { sort: { createdAt: 1 }, new: true },
                ))
            ) {
                await this.processItem(item);
            }
        } catch (err) {
            this.app.addLog("SPR import queue error: " + err.message, "error");
        } finally {
            this.processing = false;
        }
    }

    async processItem(item) {
        const { projectId, sessionId } = item;
        this.app.addLog(
            "Processing import queue item " +
                item._id +
                " (project " +
                projectId +
                ", session " +
                sessionId +
                ")",
            "info",
        );
        // Snapshot what we are about to import. If a take lands mid-import, the
        // stored fingerprint won't match it and the next scan imports again.
        const uploads = this.listUploads(projectId, sessionId);
        const fingerprint = fingerprintUploads(uploads);
        await this.setImportState(projectId, sessionId, {
            status: "importing",
            updatedAt: new Date(),
        });

        try {
            let session = await this.findSession(projectId, sessionId);
            if (!session) {
                throw new Error("Session no longer exists in the project");
            }
            // Only takes whose bundle is missing or holds different audio are
            // (re)imported; the rest keep their bundles and annotations.
            const toImport = this.outdatedBundles(projectId, session, uploads);

            await this.apiServer.importAudioFiles(
                projectId,
                sessionId,
                toImport,
            );

            session = await this.findSession(projectId, sessionId);
            if (!session) {
                throw new Error(
                    "Session was removed from the project during import",
                );
            }
            const outdated = this.outdatedBundles(projectId, session, uploads);
            if (outdated.length > 0) {
                throw new Error(
                    "Import finished but the EMU-DB is missing these recordings: " +
                        outdated.join(", "),
                );
            }

            await this.setImportState(projectId, sessionId, {
                status: "imported",
                fingerprint,
                fileCount: uploads.length,
                importedAt: new Date(),
                error: null,
                attempts: 0,
                failedFingerprint: null,
                nextRetryAt: null,
                updatedAt: new Date(),
            });
            item.status = "completed";
            item.finishedAt = new Date();
            this.app.addLog("Import queue item completed: " + item._id, "info");
        } catch (err) {
            await this.recordFailure(projectId, sessionId, fingerprint, err);
            item.status = "failed";
            item.error = err.message;
        }
        item.updatedAt = new Date();
        await item.save();
    }

    async findSession(projectId, sessionId) {
        const project = await this.projectsCollection.findOne(
            { id: projectId },
            { projection: { sessions: 1 } },
        );
        return project?.sessions?.find((s) => s.id === sessionId);
    }

    // After a take was deliberately removed along with its bundle (deleteBundle),
    // record the remaining uploads as imported instead of re-importing.
    async markUploadsImported(projectId, sessionId) {
        const session = await this.findSession(projectId, sessionId);
        if (!session || session.sprImport?.status !== "imported") {
            return;
        }
        const uploads = this.listUploads(projectId, sessionId);
        await this.setImportState(projectId, sessionId, {
            fingerprint: fingerprintUploads(uploads),
            fileCount: uploads.length,
            updatedAt: new Date(),
        });
    }

    async recordFailure(projectId, sessionId, fingerprint, err) {
        const session = await this.findSession(projectId, sessionId);
        const previous = session?.sprImport || {};
        const attempts =
            previous.failedFingerprint === fingerprint
                ? (previous.attempts || 0) + 1
                : 1;
        const retryDelay = RETRY_DELAYS_MS[attempts - 1];
        const nextRetryAt = retryDelay ? Date.now() + retryDelay : null;

        this.app.addLog(
            "SPR import of session " +
                sessionId +
                " failed (attempt " +
                attempts +
                "): " +
                err.message +
                (nextRetryAt
                    ? "; retrying in " + retryDelay / 1000 + "s"
                    : "; giving up until new recordings arrive"),
            "error",
        );
        if (!session) {
            return;
        }
        await this.setImportState(projectId, sessionId, {
            status: "failed",
            error: err.message,
            attempts,
            failedFingerprint: fingerprint,
            nextRetryAt,
            updatedAt: new Date(),
        });

        if (!nextRetryAt) {
            try {
                await this.apiServer.notifyProjectMembers(projectId, {
                    type: "error",
                    message:
                        'Recordings in session "' +
                        session.name +
                        '" could not be imported. Please contact support.',
                    metadata: { sessionId, kind: "spr-import-failed" },
                });
            } catch (notifyErr) {
                this.app.addLog(
                    "Could not notify project members of failed import: " +
                        notifyErr.message,
                    "warn",
                );
            }
        }
    }

    // Updates sessions[].sprImport in place. An atomic positional update, so it
    // can't clobber (or be clobbered by) a concurrent save of other fields.
    async setImportState(projectId, sessionId, fields) {
        const set = {};
        for (const [key, value] of Object.entries(fields)) {
            set["sessions.$.sprImport." + key] = value;
        }
        await this.projectsCollection.updateOne(
            { id: projectId, "sessions.id": sessionId },
            { $set: set },
        );
    }

    uploadDir(projectId, sessionId) {
        safePathComponent(projectId, "projectId");
        safePathComponent(sessionId, "sessionId");
        return safeJoinedPath(
            "/repositories",
            projectId,
            "Data",
            "speech_recorder_uploads",
            "emudb-sessions",
            sessionId,
        );
    }

    // Latest take of each prompt. wsrng-server writes to a dot-prefixed temp
    // file and renames it into place, so partial files are skipped.
    listUploads(projectId, sessionId) {
        const dir = this.uploadDir(projectId, sessionId);
        let names;
        try {
            names = fs.readdirSync(dir);
        } catch (err) {
            if (err.code === "ENOENT") {
                return [];
            }
            throw err;
        }
        return names
            .filter((name) => name.endsWith(".wav") && !name.startsWith("."))
            .map((name) => {
                const stat = fs.statSync(dir + "/" + name);
                return { name, size: stat.size, mtimeMs: stat.mtimeMs };
            });
    }

    // createSessions.R imports each <name>.wav, unchanged, into
    // "<session name>_ses/<name>_bndl/<name>.wav".
    bundleWavPath(projectId, session, uploadName) {
        safePathComponent(session.name + "_ses", "session name");
        const base = uploadName.replace(/\.wav$/, "");
        return safeJoinedPath(
            "/repositories",
            projectId,
            "Data",
            "VISP_emuDB",
            session.name + "_ses",
            base + "_bndl",
            base + ".wav",
        );
    }

    // Uploads with no bundle in the EMU-DB.
    missingBundles(projectId, session, uploads) {
        return uploads
            .filter(
                (u) =>
                    !fs.existsSync(
                        this.bundleWavPath(projectId, session, u.name),
                    ),
            )
            .map((u) => u.name);
    }

    // Uploads whose bundle is missing or holds different audio.
    outdatedBundles(projectId, session, uploads) {
        const dir = this.uploadDir(projectId, session.id);
        return uploads
            .filter(
                (u) =>
                    !sameFileContents(
                        dir + "/" + u.name,
                        this.bundleWavPath(projectId, session, u.name),
                    ),
            )
            .map((u) => u.name);
    }
}

module.exports = SprImportService;
module.exports.decideSprImportAction = decideSprImportAction;
module.exports.fingerprintUploads = fingerprintUploads;
module.exports.sameFileContents = sameFileContents;
module.exports.QUIET_MS = QUIET_MS;
module.exports.ABANDONED_MS = ABANDONED_MS;
module.exports.RETRY_DELAYS_MS = RETRY_DELAYS_MS;
