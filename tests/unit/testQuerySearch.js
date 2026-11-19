import Gio from 'gi://Gio';

import {module, test, assert, assertEqual, assertDeepEqual, assertRejects} from './harness.js';
import {Mode, parseQuery} from '../../lib/query.js';
import {SearchEngine} from '../../lib/search.js';
import {AiProvider} from '../../lib/providers/ai.js';
import {WebProvider, ENGINES} from '../../lib/providers/web.js';

module('query');

// --- parseQuery ---------------------------------------------------------------

const PARSE_CASES = [
    ['', Mode.DEFAULT, ''],
    [null, Mode.DEFAULT, ''],
    ['c', Mode.DEFAULT, 'c'],
    ['c ', Mode.AI, ''],
    ['c   ', Mode.AI, ''],
    ['c  hello  ', Mode.AI, 'hello'],
    ['C Hello', Mode.AI, 'Hello'],
    ['c\thello', Mode.AI, 'hello'],
    ['  c hi', Mode.AI, 'hi'],
    ['cat', Mode.DEFAULT, 'cat'],
    ['calc', Mode.DEFAULT, 'calc'],
    ['c ff x', Mode.AI, 'ff x'],
    ['ff', Mode.DEFAULT, 'ff'],
    ['f', Mode.DEFAULT, 'f'],
    ['ff ', Mode.FILES, ''],
    ['FF report', Mode.FILES, 'report'],
    ['ff  my report ', Mode.FILES, 'my report'],
    ['ffx', Mode.DEFAULT, 'ffx'],
    ['ff c ', Mode.FILES, 'c'],
    ['ff تقرير', Mode.FILES, 'تقرير'],
    ['g foo', Mode.DEFAULT, 'g foo'],
    ['  firefox  ', Mode.DEFAULT, 'firefox'],
    // Folder mode: "/" is a prefix on its own; only the first slash is removed.
    ['/', Mode.FOLDERS, ''],
    ['/ ', Mode.FOLDERS, ''],
    ['/Documents', Mode.FOLDERS, 'Documents'],
    ['/ Documents', Mode.FOLDERS, 'Documents'],
    ['/projects  ', Mode.FOLDERS, 'projects'],
    ['   /projects', Mode.FOLDERS, 'projects'],
    ['/تقارير', Mode.FOLDERS, 'تقارير'],
    ['/my projects', Mode.FOLDERS, 'my projects'],
    ['//x', Mode.FOLDERS, '/x'],
    ['/c hi', Mode.FOLDERS, 'c hi'],
    ['/ff x', Mode.FOLDERS, 'ff x'],
    // A slash inside another mode's payload stays payload text.
    ['c /projects', Mode.AI, '/projects'],
    ['ff /projects', Mode.FILES, '/projects'],
    ['ff /', Mode.FILES, '/'],
    ['g /x', Mode.DEFAULT, 'g /x'],
    ['a/b', Mode.DEFAULT, 'a/b'],
];

for (const [raw, mode, text] of PARSE_CASES) {
    test(`parseQuery(${JSON.stringify(raw)}) → ${mode} ${JSON.stringify(text)}`, () => {
        assertDeepEqual(parseQuery(raw), {mode, text});
    });
}

// --- SearchEngine ---------------------------------------------------------------

function fakeSettings(overrides = {}) {
    const values = {
        'max-results': 3,
        'enable-apps': true,
        'enable-calc': true,
        'enable-web': true,
        'enable-system': true,
        'enable-ai': true,
        'enable-files': true,
        'enable-folders': true,
        ...overrides,
    };
    return {
        get_int: k => values[k],
        get_boolean: k => values[k],
    };
}

function countingProvider(results) {
    const p = {
        calls: [],
        query(text) {
            p.calls.push(text);
            return results.map(r => ({...r}));
        },
    };
    return p;
}

function makeEngine(settingsOverrides = {}) {
    const apps = countingProvider([
        {id: 'a1', name: 'Firefox', score: 700},
        {id: 'a2', name: 'Files', score: 650},
        {id: 'a3', name: 'Fonts', score: 600},
        {id: 'a4', name: 'Foo', score: 100},
    ]);
    const sys = countingProvider([{id: 's1', name: 'Lock', score: 900}]);
    const opened = [];
    const ai = new AiProvider({open: t => {
        opened.push(t);
        return Promise.resolve();
    }});
    const aiQueries = [];
    const aiSpy = {query: t => {
        aiQueries.push(t);
        return ai.query(t);
    }};
    const files = {
        calls: [],
        query(text, opts) {
            files.calls.push({text, opts});
            return Promise.resolve([{id: 'f1', name: 'report.txt', score: 1}]);
        },
    };
    const engine = new SearchEngine(fakeSettings(settingsOverrides), {
        defaultProviders: [
            {key: 'enable-system', provider: sys},
            {key: 'enable-apps', provider: apps},
        ],
        aiProvider: aiSpy,
        filesProvider: files,
    });
    return {engine, apps, sys, files, aiQueries, opened};
}

test('default mode merges providers, ranks by score and applies max-results', async () => {
    const {engine} = makeEngine();
    const r = await engine.query('fi');
    assertDeepEqual(r.map(x => x.id), ['s1', 'a1', 'a2']);
});

test('ordinary "c" and "ff" stay default searches', async () => {
    const {engine, apps, aiQueries, files} = makeEngine();
    await engine.query('c');
    await engine.query('ff');
    assertDeepEqual(apps.calls, ['c', 'ff']);
    assertEqual(aiQueries.length, 0);
    assertEqual(files.calls.length, 0);
});

test('empty explicit modes return nothing and query no provider', async () => {
    const {engine, apps, aiQueries, files} = makeEngine();
    assertDeepEqual(await engine.query('c '), []);
    assertDeepEqual(await engine.query('ff   '), []);
    assertEqual(apps.calls.length, 0);
    assertEqual(aiQueries.length, 0);
    assertEqual(files.calls.length, 0);
});

test('AI mode returns only the AI preview, never merged app/system results', async () => {
    const {engine, apps, sys, opened} = makeEngine();
    const r = await engine.query('c lock the firefox');
    assertEqual(r.length, 1);
    assertEqual(r[0].id, 'ai-chatgpt');
    assert(r[0].name.includes('lock the firefox'), r[0].name);
    assertEqual(apps.calls.length, 0);
    assertEqual(sys.calls.length, 0);
    assertEqual(opened.length, 0, 'typing must not launch anything');
});

test('activating the AI preview opens exactly once with the payload', async () => {
    const {engine, opened} = makeEngine();
    const [result] = await engine.query('c   what is GNOME?  ');
    await result.activate();
    assertDeepEqual(opened, ['what is GNOME?']);
});

test('file mode passes payload, cancellable and max-results to the files provider only', async () => {
    const {engine, apps, files} = makeEngine();
    const c = new Gio.Cancellable();
    const r = await engine.query('ff my report ', c);
    assertEqual(r[0].id, 'f1');
    assertEqual(files.calls[0].text, 'my report');
    assertEqual(files.calls[0].opts.cancellable, c);
    assertEqual(files.calls[0].opts.limit, 3);
    assertEqual(apps.calls.length, 0);
});

test('disabled AI / file modes return nothing and do not fall back to other providers', async () => {
    const {engine, apps, aiQueries, files} = makeEngine({'enable-ai': false, 'enable-files': false});
    assertEqual(engine.isModeEnabled(Mode.AI), false);
    assertEqual(engine.isModeEnabled(Mode.FILES), false);
    assertDeepEqual(await engine.query('c hello'), []);
    assertDeepEqual(await engine.query('ff hello'), []);
    assertEqual(apps.calls.length, 0);
    assertEqual(aiQueries.length, 0);
    assertEqual(files.calls.length, 0);
});

test('provider toggles still apply in default mode', async () => {
    const {engine, apps} = makeEngine({'enable-apps': false});
    const r = await engine.query('fi');
    assertDeepEqual(r.map(x => x.id), ['s1']);
    assertEqual(apps.calls.length, 0);
});

test('a failing provider does not break the others', async () => {
    const engine = new SearchEngine(fakeSettings(), {
        defaultProviders: [
            {key: 'enable-calc', provider: {query: () => {
                throw new Error('boom (expected in test)');
            }}},
            {key: 'enable-apps', provider: countingProvider([{id: 'ok', score: 1}])},
        ],
    });
    const r = await engine.query('x');
    assertDeepEqual(r.map(x => x.id), ['ok']);
});

test('a cancelled default query rejects with CANCELLED', async () => {
    const {engine} = makeEngine();
    const c = new Gio.Cancellable();
    c.cancel();
    await assertRejects(engine.query('fi', c),
        e => e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED));
});

test('folder mode routes to the files provider, directories only, with the cancellable and limit', async () => {
    const {engine, apps, sys, files, aiQueries} = makeEngine();
    const c = new Gio.Cancellable();
    const r = await engine.query('  / my projects ', c);
    assertEqual(r[0].id, 'f1');
    assertEqual(files.calls.length, 1);
    assertEqual(files.calls[0].text, 'my projects');
    assertEqual(files.calls[0].opts.cancellable, c);
    assertEqual(files.calls[0].opts.limit, 3);
    assertEqual(files.calls[0].opts.directoriesOnly, true);
    assertEqual(apps.calls.length + sys.calls.length + aiQueries.length, 0,
        'no unrelated providers in folder mode');
});

test('ff mode does not request directories only', async () => {
    const {engine, files} = makeEngine();
    await engine.query('ff /projects');
    assertEqual(files.calls[0].text, '/projects');
    assert(!files.calls[0].opts.directoriesOnly);
});

test('empty "/" and "/ " query no provider', async () => {
    const {engine, apps, files, aiQueries} = makeEngine();
    assertDeepEqual(await engine.query('/'), []);
    assertDeepEqual(await engine.query('/   '), []);
    assertEqual(files.calls.length + apps.calls.length + aiQueries.length, 0);
});

test('folder and file modes are enabled independently', async () => {
    const off = makeEngine({'enable-folders': false});
    assertEqual(off.engine.isModeEnabled(Mode.FOLDERS), false);
    assertEqual(off.engine.isModeEnabled(Mode.FILES), true);
    assertDeepEqual(await off.engine.query('/projects'), []);
    assertEqual(off.files.calls.length + off.apps.calls.length + off.sys.calls.length, 0,
        'disabled folder mode does not fall back');
    await off.engine.query('ff projects');
    assertEqual(off.files.calls.length, 1, 'file mode still works');

    const filesOff = makeEngine({'enable-files': false});
    assertEqual(filesOff.engine.isModeEnabled(Mode.FOLDERS), true);
    assertDeepEqual(await filesOff.engine.query('ff projects'), []);
    await filesOff.engine.query('/projects');
    assertEqual(filesOff.files.calls.length, 1);
    assertEqual(filesOff.files.calls[0].opts.directoriesOnly, true);
});

// --- WebProvider ----------------------------------------------------------------

function fakeBrowser() {
    const b = {opened: [], openSearch: url => b.opened.push(url)};
    return b;
}

test('web prefixes build encoded URLs and open only on activation', () => {
    const browser = fakeBrowser();
    const web = new WebProvider(browser);
    for (const key of Object.keys(ENGINES)) {
        const [r] = web.query(`${key} hello world & more #1`);
        assertEqual(r.description, `${ENGINES[key].url}hello%20world%20%26%20more%20%231`);
    }
    assertEqual(browser.opened.length, 0, 'no launch while typing');
    const [g] = web.query('G  عربي ');
    g.activate();
    assertDeepEqual(browser.opened, [`${ENGINES.g.url}${encodeURIComponent('عربي')}`]);
});

test('web provider ignores bare / unknown prefixes', () => {
    const web = new WebProvider(fakeBrowser());
    assertDeepEqual(web.query('g'), []);
    assertDeepEqual(web.query('g '), []);
    assertDeepEqual(web.query('zz foo'), []);
    assertDeepEqual(web.query('google'), []);
});
