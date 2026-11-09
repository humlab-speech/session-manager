/**
 * Rules for creating the annotation level TRATT transcribes into, from TRATT's
 * launch dialog (createTrattLevel in ApiServer).
 *
 * TRATT replaces every item of one level when it saves, so the level must be a
 * SEGMENT level that takes part in no link (the webclient's models/TrattLevels.ts
 * offers levels on the same rule, and TRATT checks it again on open). A level
 * created here is always such a level: SEGMENT, and linked to nothing.
 */

// The same rule as the project dialog's level-name field (sessions-form):
// letters, digits, space, hyphen and underscore, at most 30 characters. Leading
// or trailing spaces are refused rather than trimmed, so the name stored is the
// name the user saw.
const LEVEL_NAME_PATTERN = /^[A-Za-z0-9 _-]{1,30}$/;

/**
 * Why `name` cannot be a new level next to `existingLevels` (the project's
 * annotationLevels), or null when it can. Names are compared case-insensitively:
 * two levels that differ only in case are allowed by EMU but impossible to tell
 * apart in TRATT's and Artic's level lists.
 */
function trattLevelNameProblem(name, existingLevels) {
    if (
        typeof name !== "string" ||
        !LEVEL_NAME_PATTERN.test(name) ||
        name.trim() !== name
    ) {
        return "A level name is 1-30 letters, digits, spaces, hyphens or underscores";
    }
    const lower = name.toLowerCase();
    const clash = (existingLevels ?? []).find(
        (level) => String(level?.name ?? "").toLowerCase() === lower,
    );
    if (clash) {
        return 'The project already has a level named "' + clash.name + '"';
    }
    return null;
}

/**
 * What the EMU-DB's DBconfig says about level `name`:
 *   "missing" - no such level;
 *   "usable"  - an unlinked SEGMENT level, which is what TRATT needs;
 *   otherwise why it exists but cannot be used.
 * A level can be in the DBconfig without being in MongoDB (a save that failed
 * halfway, or a level made in a Jupyter session), so creation checks here too.
 */
function trattLevelState(dbConfig, name) {
    const level = (dbConfig?.levelDefinitions ?? []).find(
        (def) => def?.name === name,
    );
    if (!level) {
        return "missing";
    }
    if (String(level.type ?? "").toUpperCase() !== "SEGMENT") {
        return (
            "The EMU-DB already has a " +
            level.type +
            ' level named "' +
            name +
            '"'
        );
    }
    const linked = (dbConfig?.linkDefinitions ?? []).some(
        (link) => link?.superlevelName === name || link?.sublevelName === name,
    );
    if (linked) {
        return (
            'The EMU-DB already has a level named "' +
            name +
            '", linked to other levels'
        );
    }
    return "usable";
}

module.exports = { LEVEL_NAME_PATTERN, trattLevelNameProblem, trattLevelState };
