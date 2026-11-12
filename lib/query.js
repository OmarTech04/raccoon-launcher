// Parses the raw launcher text into an explicit mode and its payload.
//
// Mode prefixes are detected on the raw text *before* trimming, because the
// trailing space is what switches the mode: "c" and "ff" alone stay ordinary
// searches, while "c " and "ff " immediately enter AI / file-search mode even
// when the payload is still empty.

export const Mode = Object.freeze({
    DEFAULT: 'default',
    AI: 'ai',
    FILES: 'files',
});

const PREFIXES = [
    {prefix: 'ff', mode: Mode.FILES},
    {prefix: 'c', mode: Mode.AI},
];

/**
 * @param {string} rawText - the entry text exactly as typed
 * @returns {{mode: string, text: string}} mode and normalized payload
 */
export function parseQuery(rawText) {
    const raw = String(rawText ?? '');
    // Leading whitespace is never meaningful; trailing whitespace is, so only
    // the start is stripped before matching a prefix.
    const head = raw.trimStart();

    for (const {prefix, mode} of PREFIXES) {
        if (head.length > prefix.length &&
            head.slice(0, prefix.length).toLowerCase() === prefix &&
            /\s/.test(head[prefix.length]))
            return {mode, text: head.slice(prefix.length + 1).trim()};
    }

    return {mode: Mode.DEFAULT, text: raw.trim()};
}
