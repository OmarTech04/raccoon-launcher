import GLib from 'gi://GLib';

// Copy a file (not its path or contents) to the clipboard in the format GNOME
// Files reads for "Paste": MIME type x-special/gnome-copied-files with the
// UTF-8 payload "copy\n<uri>". Pasting in Files then copies the file there.
//
// The clipboard is injected so the encoding can be tested without a display;
// in GNOME Shell pass St.Clipboard.get_default() and
// St.ClipboardType.CLIPBOARD.

export const COPIED_FILES_MIME = 'x-special/gnome-copied-files';

// Gio's file URIs are percent-encoded ASCII: spaces, Arabic and even a newline
// in a file name appear as %XX escapes. Anything with raw whitespace, control
// or non-ASCII characters is not such a URI, and a raw CR/LF would inject an
// extra line (an extra file, or a different operation) into the payload.
const FILE_URI = /^file:\/\/[\x21-\x7e]*\/[\x21-\x7e]*$/;

export function isCopyableFileUri(uri) {
    if (typeof uri !== 'string' || !FILE_URI.test(uri))
        return false;
    try {
        return GLib.Uri.is_valid(uri, GLib.UriFlags.NONE);
    } catch {
        return false;
    }
}

/**
 * The exact clipboard payload for copying `uri`. The URI is used verbatim:
 * never decoded to a path or re-encoded.
 *
 * @param {string} uri - a file:// URI as produced by Gio.File.get_uri()
 * @returns {Uint8Array} UTF-8 bytes of "copy\n<uri>"
 */
export function copiedFilesPayload(uri) {
    if (!isCopyableFileUri(uri))
        throw new Error('Cannot copy: not a valid file URI');
    return new TextEncoder().encode(`copy\n${uri}`);
}

/**
 * Put `uri` on `clipboard` as a file to copy. Validates first, then writes
 * exactly once. Plain text is deliberately not set as well: a second
 * set_text()/set_content() would replace the file entry.
 *
 * @param {object} clipboard - St.Clipboard (or a test fake)
 * @param {number} clipboardType - St.ClipboardType.CLIPBOARD
 * @param {string} uri - file:// URI of the file or folder
 */
export function copyFileUri(clipboard, clipboardType, uri) {
    const payload = copiedFilesPayload(uri);
    clipboard.set_content(clipboardType, COPIED_FILES_MIME, new GLib.Bytes(payload));
}
