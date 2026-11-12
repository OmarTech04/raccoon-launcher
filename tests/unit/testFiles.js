import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {test, assert, assertEqual, assertRejects} from './harness.js';
import {FilesProvider} from '../../lib/providers/files.js';

// Fixture: a temporary directory standing in for $HOME. Never the real home.
let ROOT = null;

function write(rel, contents = 'x') {
    const path = GLib.build_filenamev([ROOT, rel]);
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    GLib.file_set_contents(path, contents);
    return path;
}

function mkdir(rel) {
    const path = GLib.build_filenamev([ROOT, rel]);
    GLib.mkdir_with_parents(path, 0o755);
    return path;
}

function symlink(target, rel) {
    Gio.File.new_for_path(GLib.build_filenamev([ROOT, rel])).make_symbolic_link(target, null);
}

let OUTSIDE = null;

function setUp() {
    if (ROOT)
        return;
    ROOT = GLib.dir_make_tmp('raccoon-files-XXXXXX');
    OUTSIDE = GLib.dir_make_tmp('raccoon-outside-XXXXXX');
    GLib.file_set_contents(`${OUTSIDE}/report-outside.txt`, 'x');

    write('Report 2024.pdf');
    write('report-final.txt');
    write('notes.md');
    write('تقرير الميزانية.txt');
    write('Café menu.txt');          // NFC
    write('Café list.txt');         // NFD
    write('.hidden-report.txt');
    write('.secret/report-inside-hidden.txt');
    write('docs/sub dir/deep report.odt');
    mkdir('docs/Reports');
    write('locked/report-locked.txt');
    GLib.chmod(`${ROOT}/locked`, 0o000);
    symlink('.', 'loop');                   // directory symlink loop
    symlink(OUTSIDE, 'outside');            // symlink leaving the root
    symlink('report-final.txt', 'link-report.txt');
    for (let i = 0; i < 30; i++)
        write(`many/file-${String(i).padStart(2, '0')}-report.txt`);
}

function rmrf(path) {
    const file = Gio.File.new_for_path(path);
    const info = file.query_info('standard::type', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    if (info.get_file_type() === Gio.FileType.DIRECTORY) {
        GLib.chmod(path, 0o755);
        const e = file.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        let child;
        while ((child = e.next_file(null)))
            rmrf(GLib.build_filenamev([path, child.get_name()]));
    }
    file.delete(null);
}

export function tearDown() {
    if (ROOT)
        rmrf(ROOT);
    if (OUTSIDE)
        rmrf(OUTSIDE);
    ROOT = OUTSIDE = null;
}

function provider(opts = {}) {
    setUp();
    const launched = [];
    const p = new FilesProvider({
        root: Gio.File.new_for_path(ROOT),
        launchUri: uri => launched.push(uri),
        ...opts,
    });
    p.launched = launched;
    return p;
}

test('files: respects the result limit and ranks best first', async () => {
    const r = await provider().query('report', {limit: 5});
    assertEqual(r.length, 5);
    for (let i = 1; i < r.length; i++)
        assert(r[i - 1].score >= r[i].score, 'sorted by score');
    assert(r.every(x => x.name.toLowerCase().includes('report')));
});

test('files: skips hidden entries, symlinked directories and unreadable dirs', async () => {
    const r = await provider().query('report', {limit: 200});
    const names = r.map(x => x.name);
    for (const bad of ['.hidden-report.txt', 'report-inside-hidden.txt',
        'report-outside.txt', 'report-locked.txt'])
        assert(!names.includes(bad), `${bad} must be excluded`);
    for (const good of ['Report 2024.pdf', 'report-final.txt', 'deep report.odt',
        'Reports', 'link-report.txt'])
        assert(names.includes(good), `${good} expected in ${names}`);
    assertEqual(new Set(r.map(x => x.uri)).size, r.length, 'no duplicates through the loop symlink');
    assertEqual(names.filter(n => n.startsWith('file-')).length, 30);
    if (GLib.get_user_name() !== 'root')
        assert(r.unreadable >= 1, 'unreadable directory counted, search continued');
    assertEqual(r.incomplete, false);
});

test('files: shows the filename and its directory path', async () => {
    const [deep] = await provider().query('deep report', {limit: 3});
    assertEqual(deep.name, 'deep report.odt');
    const home = GLib.get_home_dir();
    let expected = `${ROOT}/docs/sub dir`;
    if (expected.startsWith(`${home}/`))
        expected = `~${expected.slice(home.length)}`;
    assertEqual(deep.description, expected);
});

test('files: Arabic and Unicode (NFC/NFD) names match and open by URI', async () => {
    const p = provider();
    const [ar] = await p.query('تقرير', {limit: 3});
    assertEqual(ar.name, 'تقرير الميزانية.txt');
    ar.activate();
    assertEqual(Gio.File.new_for_uri(p.launched[0]).get_path(), `${ROOT}/تقرير الميزانية.txt`);

    const cafe = await p.query('café', {limit: 5});
    assertEqual(cafe.length, 2, `both normalization forms match: ${cafe.map(x => x.name)}`);
    const nfd = await p.query('café', {limit: 5});
    assertEqual(nfd.length, 2);
});

test('files: multi-word queries match all words; exact names rank first', async () => {
    const p = provider();
    const [top] = await p.query('report 2024', {limit: 3});
    assertEqual(top.name, 'Report 2024.pdf');
    const [deep] = await p.query('odt deep', {limit: 3});
    assertEqual(deep.name, 'deep report.odt');
    const [notes] = await p.query('notes', {limit: 3});
    assertEqual(notes.name, 'notes.md');
});

test('files: activation opens the file URI with the default handler (spaces encoded)', async () => {
    const p = provider();
    const [r] = await p.query('Report 2024', {limit: 1});
    r.activate();
    assert(p.launched[0].startsWith('file://') && p.launched[0].includes('Report%202024.pdf'),
        p.launched[0]);
});

test('files: a cancelled search rejects with CANCELLED', async () => {
    const c = new Gio.Cancellable();
    c.cancel();
    await assertRejects(provider().query('report', {cancellable: c, limit: 5}),
        e => e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED));
});

test('files: cancelling mid-traversal rejects and stops', async () => {
    const c = new Gio.Cancellable();
    const promise = provider().query('report', {cancellable: c, limit: 5});
    GLib.idle_add(GLib.PRIORITY_HIGH, () => {
        c.cancel();
        return GLib.SOURCE_REMOVE;
    });
    await assertRejects(promise,
        e => e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED));
});

test('files: traversal limits mark results incomplete', async () => {
    const r = await provider({limits: {maxEntries: 5}}).query('report', {limit: 5});
    assertEqual(r.incomplete, true);
});

test('files: empty query returns nothing without traversing', async () => {
    const r = await provider().query('   ', {limit: 5});
    assertEqual(r.length, 0);
});
