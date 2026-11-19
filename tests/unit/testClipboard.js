import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {module, test, assert, assertEqual} from './harness.js';
import {COPIED_FILES_MIME, copiedFilesPayload, copyFileUri, isCopyableFileUri}
    from '../../lib/fileClipboard.js';
import {FilesProvider} from '../../lib/providers/files.js';
import {AiProvider} from '../../lib/providers/ai.js';
import {WebProvider} from '../../lib/providers/web.js';

module('clipboard');

const CLIPBOARD = 1;   // St.ClipboardType.CLIPBOARD (St is not loaded here)

function fakeClipboard() {
    const writes = [];
    return {
        writes,
        set_content: (type, mime, bytes) => writes.push({type, mime, bytes: bytes.toArray()}),
        set_text: () => {
            throw new Error('set_text must not be used for file copies');
        },
    };
}

function decode(bytes) {
    return new TextDecoder().decode(bytes);
}

test('clipboard: one write, CLIPBOARD selection, gnome-copied-files MIME, exact bytes', () => {
    const cb = fakeClipboard();
    const uri = 'file:///home/u/Report%202024.pdf';
    copyFileUri(cb, CLIPBOARD, uri);
    assertEqual(cb.writes.length, 1);
    assertEqual(cb.writes[0].type, CLIPBOARD);
    assertEqual(cb.writes[0].mime, 'x-special/gnome-copied-files');
    assertEqual(COPIED_FILES_MIME, 'x-special/gnome-copied-files');
    assertEqual(decode(cb.writes[0].bytes), `copy\n${uri}`);
    assert(!decode(cb.writes[0].bytes).startsWith('cut'), 'copy, never cut');
    assertEqual(cb.writes[0].bytes.length, 5 + uri.length, 'no trailing bytes');
});

test('clipboard: URIs from Gio keep their identity (spaces, Arabic, punctuation, encoded newline)', () => {
    const paths = [
        '/tmp/My Files/تقرير ملف, (v1) #2 & co%.txt',
        '/tmp/a\nb.txt',
        '/tmp/q?x=1;y',
        '/tmp/مجلد المشاريع',
    ];
    for (const path of paths) {
        const uri = Gio.File.new_for_path(path).get_uri();
        const cb = fakeClipboard();
        copyFileUri(cb, CLIPBOARD, uri);
        const text = decode(cb.writes[0].bytes);
        const lines = text.split('\n');
        assertEqual(lines.length, 2, `exactly two lines for ${JSON.stringify(path)}`);
        assertEqual(lines[0], 'copy');
        assertEqual(lines[1], uri, 'URI preserved verbatim, not decoded or re-encoded');
        assertEqual(Gio.File.new_for_uri(lines[1]).get_path(), path, 'resolves to the same file');
    }
});

test('clipboard: invalid input is rejected before touching the clipboard', () => {
    const bad = [undefined, null, 42, '', '/home/u/file.txt', 'http://example.com/x',
        'file://', 'file:///a\nfile:///b', 'file:///a\r', 'file:///a\ncut',
        'file:///a b', 'file:///تقرير', 'file:///a\tb', 'file:///a\u0000'];
    for (const uri of bad) {
        const cb = fakeClipboard();
        let threw = false;
        try {
            copyFileUri(cb, CLIPBOARD, uri);
        } catch {
            threw = true;
        }
        assert(threw, `must reject ${JSON.stringify(uri)}`);
        assertEqual(cb.writes.length, 0, `no write for ${JSON.stringify(uri)}`);
        assert(!isCopyableFileUri(uri));
    }
    assert(isCopyableFileUri('file:///a%0Ab'), 'an encoded newline in a name is fine');
});

test('clipboard: payload helper matches what is written', () => {
    const uri = Gio.File.new_for_path('/tmp/x y').get_uri();
    assertEqual(decode(copiedFilesPayload(uri)), `copy\n${uri}`);
});

test('clipboard: filesystem results are copyable; copying does not open them', async () => {
    const root = GLib.dir_make_tmp('raccoon-clip-XXXXXX');
    try {
        GLib.mkdir_with_parents(`${root}/Copy Me Folder`, 0o755);
        GLib.file_set_contents(`${root}/copy me.txt`, 'x');
        const launched = [];
        const p = new FilesProvider({root: Gio.File.new_for_path(root), launchUri: u => launched.push(u)});
        const results = [
            ...await p.query('copy me', {limit: 5}),
            ...await p.query('copy me', {limit: 5, directoriesOnly: true}),
        ];
        assertEqual(results.length, 3);
        for (const r of results) {
            assertEqual(r.canCopy, true, r.name);
            const cb = fakeClipboard();
            copyFileUri(cb, CLIPBOARD, r.uri);
            assertEqual(decode(cb.writes[0].bytes), `copy\n${r.uri}`);
        }
        assertEqual(launched.length, 0, 'copy never calls the open action');
    } finally {
        for (const n of ['copy me.txt', 'Copy Me Folder'])
            Gio.File.new_for_path(`${root}/${n}`).delete(null);
        Gio.File.new_for_path(root).delete(null);
    }
});

test('clipboard: other result types have no file-copy capability', () => {
    const ai = new AiProvider({open: () => Promise.resolve()}).query('hello');
    const web = new WebProvider({openSearch: () => {}}).query('g hello');
    for (const r of [...ai, ...web])
        assert(!r.canCopy, `${r.id} must not be copyable`);
});
