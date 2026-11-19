// Parses the raw launcher text into an explicit mode and its payload.
//
// Mode prefixes are detected on the raw text *before* trimming, because the
// trailing space is what switches the mode: "c" and "ff" alone stay ordinary
// searches, while "c " and "ff " immediately enter AI / file-search mode even
// when the payload is still empty.
//
// A leading "/" enters folder-search mode on its own, without a space: "/"
// shows guidance, "/projects" and "/ projects" both search folder names for
// "projects". It is a mode prefix, not a path: only the first slash is
// removed. A slash inside another mode's payload ("c /x", "ff /x") is payload
// text, because the prefix is only looked for at the start.

export const Mode = Object.freeze({
    DEFAULT: 'default',
    AI: 'ai',
    FILES: 'files',
    FOLDERS: 'folders',
});

const PREFIXES = [
    {prefix: 'ff', mode: Mode.FILES},
    {prefix: 'c', mode: Mode.AI},
];

/**
 * Leading whitespace is ignored. For "c " / "ff " the prefix and the one
 * whitespace character after it are removed; for "/" only the slash is
 * removed. The remaining payload is trimmed.
 *
 * @param {string} rawText - the entry text exactly as typed
 * @returns {{mode: string, text: string}} mode (a Mode value) and the
 *   normalized payload
 */
export function parseQuery(rawText) {
    const raw = String(rawText ?? '');
    // Leading whitespace is never meaningful; trailing whitespace is, so only
    // the start is stripped before matching a prefix.
    const head = raw.trimStart();

    // "/" is a mode prefix by itself; it does not need a following space.
    // Strip only this first slash, then trim the payload.
    if (head.startsWith('/'))
        return {mode: Mode.FOLDERS, text: head.slice(1).trim()};

    for (const {prefix, mode} of PREFIXES) {
        if (head.length > prefix.length &&
            head.slice(0, prefix.length).toLowerCase() === prefix &&
            /\s/.test(head[prefix.length]))
            return {mode, text: head.slice(prefix.length + 1).trim()};
    }

    return {mode: Mode.DEFAULT, text: raw.trim()};
}
