import {module, test, assert, assertEqual, assertDeepEqual} from './harness.js';
import {
    AI_ENTRY_URL, BrowserLauncher, buildAiUrl, buildBrowserArgv, isFirefoxAppId,
} from '../../lib/browser.js';

module('browser');

test('AI URL uses the supplied Temporary Chat entry and percent-encodes the prompt', () => {
    assertEqual(AI_ENTRY_URL, 'https://chatgpt.com/?temporary-chat=true');
    const prompt = 'a b&c=d#e?f+g/h';
    const url = buildAiUrl(prompt);
    assertEqual(url, 'https://chatgpt.com/?temporary-chat=true&q=a%20b%26c%3Dd%23e%3Ff%2Bg%2Fh');
});

function queryParam(url, name) {
    const query = url.slice(url.indexOf('?') + 1);
    for (const pair of query.split('&')) {
        const [k, v = ''] = pair.split('=');
        if (decodeURIComponent(k) === name)
            return decodeURIComponent(v);
    }
    return null;
}

test('AI URL round-trips Unicode, Arabic, newlines and shell metacharacters as data', () => {
    for (const prompt of ['ما هو جنوم؟', 'Café ✓ 日本', 'line1\nline2', '$(rm -rf ~); `id` | "x" \'y\'']) {
        const url = buildAiUrl(prompt);
        assert(/^[\x21-\x7e]+$/.test(url), `URL must be plain ASCII without spaces: ${url}`);
        assertEqual(queryParam(url, 'q'), prompt);
        assertEqual(queryParam(url, 'temporary-chat'), 'true');
    }
});

test('argv construction keeps the URL a single argument (native Firefox)', () => {
    const url = 'https://www.google.com/search?q=a%20b%3B%20%24(id)';
    assertDeepEqual(buildBrowserArgv('firefox %u', ['--new-tab', url]),
        ['firefox', '--new-tab', url]);
    assertDeepEqual(buildBrowserArgv('/usr/bin/firefox --name firefox %U %i', ['--new-window', url]),
        ['/usr/bin/firefox', '--name', 'firefox', '--new-window', url]);
    assertDeepEqual(buildBrowserArgv('firefox', ['--new-tab', url]),
        ['firefox', '--new-tab', url]);
    assertDeepEqual(buildBrowserArgv('"/opt/my firefox/firefox" %u', ['x']),
        ['/opt/my firefox/firefox', 'x']);
});

test('argv construction handles Flatpak file-forwarding command lines', () => {
    const cmd = '/usr/bin/flatpak run --branch=stable --arch=x86_64 --command=firefox ' +
        '--file-forwarding org.mozilla.firefox @@u %u @@';
    assertDeepEqual(buildBrowserArgv(cmd, ['--new-window', 'https://x/?q=1']), [
        '/usr/bin/flatpak', 'run', '--branch=stable', '--arch=x86_64', '--command=firefox',
        '--file-forwarding', 'org.mozilla.firefox', '--new-window', 'https://x/?q=1',
    ]);
});

test('Firefox app-id detection', () => {
    for (const id of ['org.mozilla.firefox.desktop', 'firefox.desktop', 'firefox-esr.desktop'])
        assert(isFirefoxAppId(id), id);
    for (const id of ['com.google.Chrome.desktop', 'chatgpt.desktop', null, 'notfirefoxish.txt'])
        assert(!isFirefoxAppId(id), String(id));
});

function fakeApp(id, cmd) {
    return {get_id: () => id, get_commandline: () => cmd};
}

function fakeEnv({defaultApp, windows = [], installed = []} = {}) {
    const env = {
        spawned: [],
        activated: [],
        launchedDefault: [],
        getDefaultHandler: () => defaultApp,
        findApp: id => installed.find(a => a.get_id() === id) ?? null,
        spawn: argv => env.spawned.push(argv),
        launchDefault: url => env.launchedDefault.push(url),
        listAppWindows: () => windows,
        activateWindow: w => env.activated.push(w),
    };
    return env;
}

const FIREFOX = fakeApp('org.mozilla.firefox.desktop', 'firefox %u');
const CHROME = fakeApp('com.google.Chrome.desktop', '/usr/bin/google-chrome-stable %U');
const URL_ = 'https://www.google.com/search?q=x';

test('non-Firefox default browser keeps the generic default-handler launch', () => {
    const env = fakeEnv({defaultApp: CHROME});
    assertEqual(new BrowserLauncher(env).openSearch(URL_), 'default');
    assertDeepEqual(env.launchedDefault, [URL_]);
    assertEqual(env.spawned.length, 0);
});

test('Firefox search opens a new tab in the most recent normal window, not the AI window', () => {
    const ai = {name: 'ai'}, normal1 = {name: 'n1'}, normal2 = {name: 'n2'};
    const env = fakeEnv({defaultApp: FIREFOX, windows: [ai, normal1, normal2]});
    const b = new BrowserLauncher(env);
    b.isManagedWindow = w => w === ai;
    assertEqual(b.openSearch(URL_), 'tab');
    assertDeepEqual(env.activated, [normal1]);
    assertDeepEqual(env.spawned, [['firefox', '--new-tab', URL_]]);
});

test('Firefox search with only the AI window open uses a new window', () => {
    const ai = {name: 'ai'};
    const env = fakeEnv({defaultApp: FIREFOX, windows: [ai]});
    const b = new BrowserLauncher(env);
    b.isManagedWindow = w => w === ai;
    assertEqual(b.openSearch(URL_), 'window');
    assertEqual(env.activated.length, 0);
    assertDeepEqual(env.spawned, [['firefox', '--new-window', URL_]]);
});

test('Firefox search with Firefox closed starts it normally', () => {
    const env = fakeEnv({defaultApp: FIREFOX, windows: []});
    new BrowserLauncher(env).openSearch(URL_);
    assertEqual(env.activated.length, 0);
    assertDeepEqual(env.spawned, [['firefox', '--new-tab', URL_]]);
});

test('AI window launch uses Firefox even if another browser is the default', () => {
    const env = fakeEnv({defaultApp: CHROME, installed: [FIREFOX]});
    const id = new BrowserLauncher(env).openNewWindow('https://chatgpt.com/?temporary-chat=true&q=x');
    assertEqual(id, 'org.mozilla.firefox.desktop');
    assertDeepEqual(env.spawned, [['firefox', '--new-window', 'https://chatgpt.com/?temporary-chat=true&q=x']]);
});

test('AI window launch fails clearly without Firefox', () => {
    const env = fakeEnv({defaultApp: CHROME});
    let msg = '';
    try {
        new BrowserLauncher(env).openNewWindow('https://x');
    } catch (e) {
        msg = e.message;
    }
    assert(/Firefox is not installed/.test(msg), msg);
    assertEqual(env.spawned.length, 0);
});
