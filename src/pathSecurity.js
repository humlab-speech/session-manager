/**
 * Path traversal protection utilities for session-manager.
 *
 * Validates that user-influenced path components (project IDs, usernames,
 * session names, form context IDs, etc.) cannot escape their intended
 * parent directory via "..", "/", null bytes, or other tricks.
 *
 * Two layers of protection:
 *   1. safePathComponent() — validates a single path segment (no slashes)
 *   2. safeJoinedPath()    — validates that a resolved path stays inside
 *                            an expected root directory
 */

const fs = require("fs");
const path = require("path");

/**
 * Validate that a string is safe to use as a single path component.
 * Rejects path separators, traversal sequences, and null bytes.
 *
 * @param {string} component - The value to validate (e.g. projectId, username)
 * @param {string} label     - Human-readable name for error messages
 * @returns {string} The validated component (unchanged)
 * @throws {Error} If the component contains illegal characters
 */
function safePathComponent(component, label) {
    if (typeof component !== "string" || component.length === 0) {
        throw new Error(`Path traversal blocked: ${label} must be a non-empty string`);
    }

    // Reject path separators, null bytes, and parent-directory traversal
    if (/[/\\\0]/.test(component)) {
        throw new Error(
            `Path traversal blocked: ${label} contains path separator or null byte`,
        );
    }
    if (component === ".." || component === ".") {
        throw new Error(
            `Path traversal blocked: ${label} is a relative directory reference`,
        );
    }
    if (component.includes("..")) {
        throw new Error(
            `Path traversal blocked: ${label} contains '..' sequence`,
        );
    }

    return component;
}

/**
 * Join path segments under an expected root and verify the result does
 * not escape that root. This is the second layer of defence — even if
 * safePathComponent() is accidentally skipped, this catches traversal.
 *
 * @param {string} root       - The trusted root directory (e.g. "/repositories")
 * @param {...string} segments - One or more path segments to join under root
 * @returns {string} The resolved absolute path
 * @throws {Error} If the resolved path escapes the root
 */
function safeJoinedPath(root, ...segments) {
    const resolvedRoot = path.resolve(root);
    const resolvedFull = path.resolve(root, ...segments);

    // The resolved path must start with root + "/" (or be exactly root)
    if (
        resolvedFull !== resolvedRoot &&
        !resolvedFull.startsWith(resolvedRoot + "/")
    ) {
        throw new Error(
            `Path traversal blocked: resolved path '${resolvedFull}' escapes root '${resolvedRoot}'`,
        );
    }

    return resolvedFull;
}

/**
 * Build a host-side mount source path, validated against the project root.
 * Combines absRootPath with a relative path and ensures the result stays
 * inside absRootPath.
 *
 * @param {string} absRootPath  - The ABS_ROOT_PATH (project deployment root)
 * @param {string} relativePath - The path relative to absRootPath
 * @returns {string} The validated absolute path
 * @throws {Error} If the resolved path escapes absRootPath
 */
function safeMountSource(absRootPath, relativePath) {
    return safeJoinedPath(absRootPath, relativePath);
}

/**
 * Thrown by readRegularTree for an entry that must not be read: anything that
 * is not a regular file, or that turned into one of those between the
 * directory listing and the open.
 */
class NonRegularFileError extends Error {
    constructor(entryName) {
        super("not a regular file: " + entryName);
        this.name = "NonRegularFileError";
        this.entry = entryName;
    }
}

/**
 * Read a directory tree into [{name, data}] without ever reading through a
 * link, for callers that are about to hand the tree to someone else (zipping
 * a bundle is the one that matters here).
 *
 * The project repository — and with it a bundle directory — is bind-mounted
 * read-write into the project members' own session containers, so a member can
 * put `take.wav -> /etc/passwd` inside a bundle they are entitled to download,
 * and adm-zip (statSync/readFileSync) would archive the link's TARGET and send
 * it back under plain membership authz.
 *
 * This is a reader rather than a check-then-act scan on purpose: the directory
 * belongs to the person who would plant the link, so anything that lists the
 * tree and then reads it in a second pass can be raced by that person simply
 * keeping `ln -sf` running. Here the type comes from the directory listing, and
 * the read itself goes through O_NOFOLLOW on the descriptor, so a link swapped
 * in afterwards is refused at open() instead of being followed.
 *
 * @param {string} root directory to read (a link at root is refused)
 * @returns {Array<{name: string, data: Buffer}>} names are root-relative, '/'-joined
 * @throws {NonRegularFileError} for the first entry that is not a plain file
 */
function readRegularTree(root) {
    // The root is listed by readdirSync, which follows it: without this a
    // member could name the bundle directory itself as a link and have the
    // whole target tree walked.
    if (!fs.lstatSync(root).isDirectory()) {
        throw new NonRegularFileError(root);
    }
    const files = [];
    const stack = [{ dir: root, prefix: "" }];
    while (stack.length > 0) {
        const { dir, prefix } = stack.pop();
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const name = prefix ? prefix + "/" + entry.name : entry.name;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                stack.push({ dir: full, prefix: name });
                continue;
            }
            if (!entry.isFile()) {
                // Symlinks, FIFOs, sockets, devices - and anything that
                // changed shape between listing and this iteration.
                throw new NonRegularFileError(name);
            }
            let fd;
            try {
                fd = fs.openSync(
                    full,
                    fs.constants.O_RDONLY |
                        fs.constants.O_NOFOLLOW |
                        fs.constants.O_NONBLOCK,
                );
            } catch (err) {
                // ELOOP: swapped to a link after the listing. Anything else
                // (EACCES, ENOENT, a socket) is a refusal too - this path is
                // read because someone asked for it, not out of curiosity.
                throw new NonRegularFileError(name);
            }
            try {
                if (!fs.fstatSync(fd).isFile()) {
                    throw new NonRegularFileError(name);
                }
                files.push({ name, data: fs.readFileSync(fd) });
            } finally {
                fs.closeSync(fd);
            }
        }
    }
    return files;
}

module.exports = {
    safePathComponent,
    safeJoinedPath,
    safeMountSource,
    readRegularTree,
    NonRegularFileError,
};
