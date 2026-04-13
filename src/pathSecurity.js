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

module.exports = {
    safePathComponent,
    safeJoinedPath,
    safeMountSource,
};
