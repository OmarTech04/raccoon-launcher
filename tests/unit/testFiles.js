import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {module, test, assert, assertEqual, assertRejects} from './harness.js';
import {FilesProvider} from '../../lib/providers/files.js';

module('files');

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

    // Folder-mode fixtures: matching folders mixed with many matching files.
    mkdir('docs/projects');                          // exact folder name
    mkdir('work/clients/Projects Alpha');            // below non-matching parents
    mkdir('My Projects');                            // space in the name
    mkdir('تقارير/مشاريع');                          // Arabic folders
    write('projects-plan.txt');
    write('projects-todo.md');
    for (let i = 0; i < 12; i++)
        write(`many/projects-${String(i).padStart(2, '0')}.txt`);
    mkdir('.cache/projects-hidden-ancestor/projects-deeper');
    mkdir('.projects-hidden');
    symlink('work', 'projects-link');                // dir symlink with a matching name
    symlink(OUTSIDE, 'linked-outside');              // dir symlink leading outside
    GLib.mkdir_with_parents(`${OUTSIDE}/projects-outside`, 0o755);
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

// --- folder mode (directoriesOnly) -------------------------------------------

const FOLDERS = {directoriesOnly: true};

test('folders: only real directories are returned', async () => {
    const r = await provider().query('projects', {limit: 20, ...FOLDERS});
    const names = r.map(x => x.name).sort();
    assertEqual(JSON.stringify(names),
        JSON.stringify(['My Projects', 'Projects Alpha', 'projects'].sort()), names);
    for (const x of r) {
        const info = Gio.File.new_for_uri(x.uri).query_info('standard::type',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        assertEqual(info.get_file_type(), Gio.FileType.DIRECTORY, x.name);
    }
});

test('folders: matching files do not take result slots', async () => {
    // 14 matching files, 3 matching folders; with limit 3 all 3 folders fit.
    const r = await provider().query('projects', {limit: 3, ...FOLDERS});
    assertEqual(r.length, 3);
    assert(r.every(x => !x.name.endsWith('.txt') && !x.name.endsWith('.md')),
        r.map(x => x.name).join('|'));
});

test('folders: nested match found through non-matching parents, with its path', async () => {
    const r = await provider().query('alpha', {limit: 5, ...FOLDERS});
    assertEqual(r.length, 1);
    assertEqual(r[0].name, 'Projects Alpha');
    assert(r[0].description.endsWith('/work/clients'), r[0].description);
});

test('folders: hidden ancestors, hidden folders and symlinks are excluded and not traversed', async () => {
    const r = await provider().query('projects', {limit: 20, ...FOLDERS});
    const names = r.map(x => x.name);
    for (const bad of ['projects-hidden-ancestor', 'projects-deeper', '.projects-hidden',
        'projects-link', 'projects-outside'])
        assert(!names.includes(bad), `${bad} must be excluded: ${names}`);
    const outside = await provider().query('outside', {limit: 20, ...FOLDERS});
    assertEqual(outside.length, 0, 'symlinked directory not traversed');
});

test('folders: exact name ranks first; spaces and Arabic work; folder icon', async () => {
    const p = provider();
    const [top] = await p.query('projects', {limit: 3, ...FOLDERS});
    assertEqual(top.name, 'projects');
    assertEqual(top.gicon?.get_names?.()[0], 'folder');
    const [spaced] = await p.query('my projects', {limit: 3, ...FOLDERS});
    assertEqual(spaced.name, 'My Projects');
    const ar = await p.query('مشاريع', {limit: 3, ...FOLDERS});
    assertEqual(ar.length, 1);
    assertEqual(ar[0].name, 'مشاريع');
    assert(ar[0].description.endsWith('/تقارير'), ar[0].description);
    const parent = await p.query('تقارير', {limit: 3, ...FOLDERS});
    assertEqual(parent[0]?.name, 'تقارير');
});

test('folders: Enter opens the directory URI with the default handler', async () => {
    const p = provider();
    const [r] = await p.query('my projects', {limit: 1, ...FOLDERS});
    r.activate();
    assertEqual(p.launched.length, 1);
    assertEqual(Gio.File.new_for_uri(p.launched[0]).get_path(), `${ROOT}/My Projects`);
    assert(p.launched[0].includes('My%20Projects'), p.launched[0]);
});

test('folders: cancellation and incomplete metadata', async () => {
    const c = new Gio.Cancellable();
    c.cancel();
    await assertRejects(provider().query('projects', {cancellable: c, limit: 5, ...FOLDERS}),
        e => e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED));
    const r = await provider({limits: {maxEntries: 5}}).query('projects', {limit: 5, ...FOLDERS});
    assertEqual(r.incomplete, true);
    assertEqual(typeof r.unreadable, 'number');
});

test('files: ff mode still returns files and folders for the same query', async () => {
    const r = await provider().query('projects', {limit: 20});
    const names = r.map(x => x.name);
    assert(names.includes('projects-plan.txt') && names.includes('projects'), names.join('|'));
    assert(names.includes('projects-link'), 'ff keeps listing symlinks by name (not followed)');
});
