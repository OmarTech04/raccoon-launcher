// Test-only driver for tools/smoketest.sh. Runs inside a private headless
// GNOME Shell next to the real, unmodified Raccoon Launcher extension and
// drives it through its real entry point (enable/disable via the extension
// manager), a compositor virtual keyboard and pointer, and — when
// RACCOON_TEST_FIREFOX=1 — a real Firefox using a disposable profile and
// local stand-in pages. Results go to $RACCOON_TEST_OUT.
//
// System actions are only looked up, never activated.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const UUID = 'raccoonlauncher@shimafallah.github.io';

const results = [];
let outPath = null;
// Disabling an extension makes GNOME Shell disable and re-enable every
// extension enabled after it ("rebase"), which includes this driver.
let started = false;

function record(ok, name, detail = '') {
    const line = `RACCOON_TEST ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`;
    results.push({ok, line});
    console.log(line);
}

function check(cond, name, detail = '') {
    record(!!cond, name, detail);
    return !!cond;
}

function flush(done) {
    const failed = results.filter(r => !r.ok).length;
    const text = `${results.map(r => r.line).join('\n')}\n${done
        ? `RACCOON_TEST DONE ${failed === 0 ? 'PASS' : 'FAIL'} ${results.length - failed}/${results.length}\n`
        : ''}`;
    if (outPath)
        GLib.file_set_contents(outPath, text);
    if (done)
        console.log('RACCOON_TEST DONE');
}

function sleep(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

async function waitFor(pred, timeoutMs, step = 50) {
    const end = GLib.get_monotonic_time() + timeoutMs * 1000;
    for (;;) {
        let v;
        try {
            v = pred();
        } catch {
            v = false;
        }
        if (v)
            return v;
        if (GLib.get_monotonic_time() > end)
            return null;
        // eslint-disable-next-line no-await-in-loop
        await sleep(step);
    }
}

class Input {
    constructor() {
        const seat = global.stage.context.get_backend().get_default_seat();
        this.kbd = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        this.ptr = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    }

    async key(keyval) {
        const t = GLib.get_monotonic_time();
        this.kbd.notify_keyval(t, keyval, Clutter.KeyState.PRESSED);
        this.kbd.notify_keyval(t + 1000, keyval, Clutter.KeyState.RELEASED);
        await sleep(40);
    }

    async type(text) {
        for (const ch of text)
            // eslint-disable-next-line no-await-in-loop
            await this.key(Clutter.unicode_to_keysym(ch.codePointAt(0)));
    }

    async click(x, y) {
        const t = GLib.get_monotonic_time();
        this.ptr.notify_absolute_motion(t, x, y);
        await sleep(40);
        this.ptr.notify_button(t + 1000, Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        this.ptr.notify_button(t + 2000, Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
        await sleep(80);
    }

    destroy() {
        this.kbd.run_dispose();
        this.ptr.run_dispose();
    }
}

function ext() {
    return Main.extensionManager.lookup(UUID);
}

async function setEnabled(enabled) {
    if (enabled)
        Main.extensionManager.enableExtension(UUID);
    else
        Main.extensionManager.disableExtension(UUID);
    const want = enabled ? ExtensionState.ACTIVE : ExtensionState.INACTIVE;
    return waitFor(() => ext()?.state === want, 10000);
}

function backdrops() {
    return Main.layoutManager.uiGroup.get_children()
        .filter(a => a.has_style_class_name?.('raccoon-backdrop'));
}

async function results_(overlay, pred = r => r.length > 0, timeoutMs = 3000) {
    return waitFor(() => pred(overlay._results) && overlay._results, timeoutMs);
}

// --- overlay / search ------------------------------------------------------

async function testOverlay(input) {
    const inst = ext().stateObj;
    const overlay = inst._overlay;

    // The headless shell may start in the overview, which holds its own grab.
    const baseModal = Main.modalCount;
    overlay.open();
    await sleep(200);
    const bd = overlay._backdrop;
    check(overlay.isOpen && bd.visible && bd.mapped, 'open: backdrop visible and mapped',
        `isOpen=${overlay.isOpen} visible=${bd.visible} mapped=${bd.mapped}`);
    check(Main.modalCount === baseModal + 1, 'open: modal grab held',
        `modalCount=${Main.modalCount} base=${baseModal}`);

    const monitor = global.display.get_current_monitor();
    const wa = Main.layoutManager.getWorkAreaForMonitor(monitor);
    const [bx, by] = overlay.get_transformed_position();
    const [bw, bh] = overlay.get_transformed_size();
    check(bx >= wa.x && by >= wa.y && bx + bw <= wa.x + wa.width && by + bh <= wa.y + wa.height,
        'open: box inside the current monitor work area',
        `box=${bx},${by} ${bw}x${bh} wa=${wa.x},${wa.y} ${wa.width}x${wa.height}`);

    // Default search through real typing.
    await input.type('fi');
    let r = await results_(overlay);
    check(r && overlay._entry.get_text() === 'fi' && !overlay._modeBadge.visible,
        'default: typing "fi" shows ordinary results', `n=${r?.length}`);

    // "c" alone stays ordinary search; "c " switches immediately.
    overlay._entry.set_text('');
    const ai = inst._aiWindow;
    const realOpen = ai.open;
    const aiCalls = [];
    ai.open = prompt => {
        aiCalls.push(prompt);
        return Promise.resolve({confirmed: true});
    };
    try {
        await input.type('c');
        await sleep(150);
        check(!overlay._modeBadge.visible && overlay._results.every(x => x.id !== 'ai-chatgpt'),
            '"c" alone is ordinary search');
        await input.type(' ');
        await sleep(150);
        check(overlay._modeBadge.visible && overlay._modeBadge.text === 'ChatGPT' &&
            overlay._results.length === 0 && overlay._hint.visible,
        '"c " switches to AI mode immediately with guidance',
        `badge=${overlay._modeBadge.visible}/${overlay._modeBadge.text} n=${overlay._results.length} hint=${overlay._hint.text}`);
        await input.key(Clutter.KEY_Return);
        check(overlay.isOpen && aiCalls.length === 0, 'empty AI prompt: Enter does nothing');

        await input.type('hello world');
        r = await results_(overlay);
        check(r?.length === 1 && r[0].id === 'ai-chatgpt' && r[0].name.includes('hello world'),
            'AI preview shown while typing', r?.map(x => x.name).join('|'));
        check(aiCalls.length === 0, 'no browser launch / submission while typing');

        await input.key(Clutter.KEY_Return);
        await sleep(200);
        check(aiCalls.length === 1 && aiCalls[0] === 'hello world',
            'Enter activates AI exactly once', JSON.stringify(aiCalls));
        check(!overlay.isOpen && !overlay._backdrop.visible && Main.modalCount === baseModal,
            'AI activation closes overlay and releases the grab first',
            `modalCount=${Main.modalCount} base=${baseModal}`);
        await input.key(Clutter.KEY_Return);
        check(aiCalls.length === 1, 'a second Enter after close does nothing');

        // A rejected async activation must be caught and reported.
        ai.open = () => Promise.reject(new Error('expected test failure'));
        const notified = [];
        overlay._reportActivationError = (res, e) => notified.push(e.message);
        overlay.open();
        overlay._entry.set_text('c will fail');
        await results_(overlay);
        await input.key(Clutter.KEY_Return);
        await sleep(200);
        check(notified.length === 1 && notified[0] === 'expected test failure',
            'rejected async activation is caught and reported');
        delete overlay._reportActivationError;
    } finally {
        ai.open = realOpen;
    }

    // File search (fixture files live in the sandbox $HOME).
    overlay.open();
    const files = inst._engine.filesProvider;
    const realQuery = files.query.bind(files);
    let fileQueries = 0;
    files.query = (...args) => {
        fileQueries++;
        return realQuery(...args);
    };
    try {
        await input.type('ff');
        await sleep(150);
        check(!overlay._modeBadge.visible, '"ff" alone is ordinary search');
        await input.type(' ');
        await sleep(300);
        check(overlay._modeBadge.text === 'Files' && overlay._modeBadge.visible &&
            overlay._results.length === 0 && /file name/.test(overlay._hint.text) && fileQueries === 0,
        '"ff " switches to file mode with guidance and no traversal',
        `hint=${overlay._hint.text} queries=${fileQueries}`);

        await input.type('report');
        check(overlay._hint.text.startsWith('Searching'), 'file search shows loading feedback');
        r = await results_(overlay);
        check(fileQueries === 1, 'typing is debounced into one filesystem search', `queries=${fileQueries}`);
        const names = (r ?? []).map(x => x.name);
        check(names.includes('Report 2024.pdf') && names.includes('deep report.odt') &&
            !names.some(n => n.startsWith('.')) && !names.includes('report-inside-hidden.txt'),
        'file results: names + paths, hidden excluded', names.join('|'));
        const deep = r?.find(x => x.name === 'deep report.odt');
        check(deep?.description === '~/Documents/sub dir', 'file result shows its path',
            deep?.description);

        overlay._entry.set_text('ff تقرير');
        r = await results_(overlay, x => x.length > 0 && x[0].name.startsWith('تقرير'));
        check(r, 'Arabic filename search', r?.map(x => x.name).join('|'));

        // Stale results: a slow earlier query must not overwrite a newer one.
        overlay._entry.set_text('ff report');
        await sleep(250);
        overlay._entry.set_text('ff notes');
        r = await results_(overlay, x => x.length > 0);
        await sleep(600);
        check(overlay._results.length === 1 && overlay._results[0].name === 'notes.md',
            'stale file results are discarded', overlay._results.map(x => x.name).join('|'));

        const settings = inst._settings;
        settings.set_int('max-results', 3);
        overlay._entry.set_text('ff file');
        r = await results_(overlay);
        check(r?.length === 3, 'file search respects max-results', `n=${r?.length}`);

        // Scroll the selection into view with many results.
        settings.set_int('max-results', 20);
        overlay._entry.set_text('ff file-');
        r = await results_(overlay, x => x.length === 20);
        await sleep(200);
        for (let i = 0; i < 15; i++)
            // eslint-disable-next-line no-await-in-loop
            await input.key(Clutter.KEY_Down);
        await sleep(500);
        check(overlay._selected === 15 && overlay._scroll.vadjustment.value > 0,
            'arrow navigation scrolls the selection into view',
            `selected=${overlay._selected} scroll=${overlay._scroll.vadjustment.value}`);
        settings.reset('max-results');

        // Enter opens the selected file with its default handler.
        const launched = [];
        const realLaunch = files._launchUri;
        files._launchUri = uri => launched.push(uri);
        overlay._entry.set_text('ff Report 2024');
        await results_(overlay);
        await input.key(Clutter.KEY_Return);
        files._launchUri = realLaunch;
        check(launched.length === 1 &&
            Gio.File.new_for_uri(launched[0]).get_path() === `${GLib.get_home_dir()}/Report 2024.pdf`,
        'Enter opens the selected file once by URI', launched.join(' '));

        overlay.open();
        settings.set_boolean('enable-files', false);
        overlay._entry.set_text('ff report');
        await sleep(400);
        check(overlay._results.length === 0 && /turned off/.test(overlay._hint.text),
            'disabled file mode shows a disabled state, no fallback', overlay._hint.text);
        settings.set_boolean('enable-ai', false);
        overlay._entry.set_text('c hello');
        await sleep(200);
        check(overlay._results.length === 0 && /AI mode is turned off/.test(overlay._hint.text),
            'disabled AI mode shows a disabled state, no fallback', overlay._hint.text);
        settings.reset('enable-files');
        settings.reset('enable-ai');

        // Close while a search is pending: nothing may touch the closed UI.
        overlay._entry.set_text('ff report');
        overlay.close();
        await sleep(600);
        check(!overlay.isOpen && overlay._results.length === 0,
            'closing cancels pending file search');
    } finally {
        delete files.query;
    }

    // Calculator, web, system (looked up only).
    overlay.open();
    overlay._entry.set_text('2+3*4');
    r = await results_(overlay, x => x[0]?.id === 'calc');
    check(r?.[0]?.name === '14', 'calculator result', r?.[0]?.name);
    overlay._entry.set_text('g hello world');
    r = await results_(overlay, x => x[0]?.id === 'web-g');
    check(r?.[0]?.description === 'https://www.google.com/search?q=hello%20world',
        'web prefix result', r?.[0]?.description);
    for (const [q, name, method] of [['restart', 'Restart', 'activateRestart'],
        ['log out', 'Log Out', 'activateLogout'], ['suspend', 'Suspend', 'activateSuspend'],
        ['power off', 'Power Off', 'activatePowerOff'], ['lock', 'Lock Screen', 'activateLockScreen']]) {
        overlay._entry.set_text(q);
        // eslint-disable-next-line no-await-in-loop
        r = await results_(overlay, x => x.some(y => y.name === name));
        check(r?.some(x => x.name === name) &&
            typeof SystemActions.getDefault()[method] === 'function',
        `system action "${name}" offered (not triggered)`);
    }

    // Escape and outside click close the overlay.
    await input.key(Clutter.KEY_Escape);
    check(!overlay.isOpen && !overlay._backdrop.visible, 'Escape closes the overlay');
    overlay.open();
    await sleep(200);
    await input.click(wa.x + 5, wa.y + wa.height - 5);
    check(!overlay.isOpen && !overlay._backdrop.visible, 'outside click closes the overlay');
    overlay.toggle();
    const a = overlay.isOpen;
    overlay.toggle();
    check(a && !overlay.isOpen, 'toggle opens and closes');
}

// --- folder mode ("/") -------------------------------------------------------

function isRealDirectory(uri) {
    try {
        return Gio.File.new_for_uri(uri).query_info('standard::type',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
            .get_file_type() === Gio.FileType.DIRECTORY;
    } catch {
        return false;
    }
}

async function testFolders(input) {
    const inst = ext().stateObj;
    const overlay = inst._overlay;
    const settings = inst._settings;
    const files = inst._engine.filesProvider;
    const calls = [];
    const realQuery = files.query.bind(files);
    files.query = (text, opts) => {
        calls.push({text, directoriesOnly: !!opts?.directoriesOnly});
        return realQuery(text, opts);
    };
    const launched = [];
    const realLaunch = files._launchUri;
    files._launchUri = uri => launched.push(uri);

    try {
        overlay.open();
        await sleep(100);

        // "/" switches immediately, shows guidance, and does not traverse.
        await input.type('/');
        await sleep(400);
        check(overlay._modeBadge.visible && overlay._modeBadge.text === 'Folders' &&
            overlay.has_style_class_name('raccoon-mode-folders') &&
            overlay._results.length === 0 && /folder name/.test(overlay._hint.text) &&
            calls.length === 0,
        'folders: "/" switches to folder mode with guidance and no traversal',
        `badge=${overlay._modeBadge.text} hint=${overlay._hint.text} calls=${calls.length}`);

        // Typing is debounced into one directory-only search.
        await input.type('projects');
        check(overlay._hint.text.startsWith('Searching'), 'folders: loading feedback while searching');
        let r = await results_(overlay);
        await sleep(300);
        check(calls.length === 1 && calls[0].text === 'projects' && calls[0].directoriesOnly,
            'folders: typing is debounced into one directory-only search', JSON.stringify(calls));
        const names = (r ?? []).map(x => x.name).sort();
        check(JSON.stringify(names) === JSON.stringify(['Client Projects', 'Projects']) &&
            r.every(x => isRealDirectory(x.uri)),
        'folders: only real, non-hidden directories (no files, no symlinks)', names.join('|'));
        const client = r?.find(x => x.name === 'Client Projects');
        check(client?.description === '~/Work' && client?.gicon?.get_names?.()[0] === 'folder',
            'folders: parent path and folder icon shown', `${client?.description}`);

        // Navigation still works on folder results; Enter opens exactly once.
        const before = overlay._selected;
        await input.key(Clutter.KEY_Down);
        check(overlay._selected === (before + 1) % r.length, 'folders: arrow navigation');
        const target = overlay._results[overlay._selected];
        await input.key(Clutter.KEY_Return);
        await sleep(200);
        check(launched.length === 1 && launched[0] === target.uri && !overlay.isOpen,
            'folders: Enter opens the selected folder exactly once', launched.join(' '));
        await input.key(Clutter.KEY_Return);
        check(launched.length === 1, 'folders: second Enter after close does nothing');

        // Arabic folder names.
        overlay.open();
        overlay._entry.set_text('/مشاريع');
        r = await results_(overlay, x => x.length > 0 && x[0].name === 'مشاريع');
        check(r && r[0].description === '~/تقارير', 'folders: Arabic folder name and path',
            r?.map(x => `${x.name} ${x.description}`).join('|'));

        // Switching between modes cancels and rejects stale results.
        calls.length = 0;
        overlay._entry.set_text('ff projects');
        await sleep(250);
        overlay._entry.set_text('/projects');
        r = await results_(overlay, x => x.length > 0);
        await sleep(600);
        check(overlay._results.length > 0 && overlay._results.every(x => isRealDirectory(x.uri)),
            'folders: ff → / switch shows only folder results',
            overlay._results.map(x => x.name).join('|'));
        overlay._entry.set_text('/projects plan');
        await sleep(50);
        overlay._entry.set_text('ff projects plan');
        r = await results_(overlay, x => x.length > 0);
        await sleep(600);
        check(overlay._results.length === 1 && overlay._results[0].name === 'projects-plan.txt',
            'folders: / → ff switch shows file results, stale folder search discarded',
            overlay._results.map(x => x.name).join('|'));
        overlay._entry.set_text('/projects');
        await sleep(50);
        overlay._entry.set_text('c hello');
        await sleep(600);
        check(overlay._results.length === 1 && overlay._results[0].id === 'ai-chatgpt',
            'folders: switching to AI mode cancels the pending folder search');
        overlay._entry.set_text('/');
        await sleep(400);
        check(overlay._results.length === 0 && /folder name/.test(overlay._hint.text),
            'folders: back to "/" clears results and shows guidance');

        // Independent setting, live refresh.
        overlay._entry.set_text('/projects');
        await results_(overlay, x => x.length > 0);
        settings.set_boolean('enable-folders', false);
        await sleep(300);
        check(overlay._results.length === 0 && /Folder search is turned off/.test(overlay._hint.text),
            'folders: disabling the setting refreshes to a disabled state', overlay._hint.text);
        overlay._entry.set_text('ff projects plan');
        r = await results_(overlay, x => x.length > 0);
        check(r?.[0]?.name === 'projects-plan.txt', 'folders: file mode unaffected by the folder setting');
        settings.set_boolean('enable-files', false);
        overlay._entry.set_text('/projects');
        await sleep(300);
        check(/Folder search is turned off/.test(overlay._hint.text) && overlay._results.length === 0,
            'folders: disabled folder mode does not fall back');
        settings.reset('enable-files');
        settings.set_boolean('enable-folders', true);
        r = await results_(overlay, x => x.length > 0);
        check(r && r.every(x => isRealDirectory(x.uri)),
            'folders: re-enabling refreshes the open launcher with folder results');
        settings.reset('enable-folders');
        overlay.close();
    } finally {
        delete files.query;
        files._launchUri = realLaunch;
        settings.reset('enable-folders');
        settings.reset('enable-files');
    }
}

async function testLifecycle() {
    const inst = ext().stateObj;
    const baseModal = Main.modalCount;
    inst._overlay.open();
    inst._overlay._entry.set_text('ff report');
    await sleep(100);   // let a frame pass; the 200 ms file-search debounce is still pending
    check(inst._overlay._debounceId !== 0, 'file search still pending before disable');
    check(await setEnabled(false), 'disable (with overlay open and search pending)');
    await sleep(500);
    check(backdrops().length === 0, 'disable removes the overlay actors', `n=${backdrops().length}`);
    check(Main.modalCount <= baseModal, 'disable releases the modal grab',
        `modalCount=${Main.modalCount} base=${baseModal}`);
    check(!Main.wm._allowedKeybindings?.['toggle-launcher'], 'disable removes the keybinding');
    check(!ext().error, 'no extension error after disable', ext().error);

    check(await setEnabled(true), 're-enable');
    const inst2 = ext().stateObj;
    check(backdrops().length === 1, 'exactly one overlay after re-enable', `n=${backdrops().length}`);
    inst2._overlay.open();
    await sleep(100);
    check(inst2._overlay.isOpen && inst2._overlay._backdrop.visible, 're-enabled overlay opens');
    inst2._overlay.close();
    check(!inst2._overlay._backdrop.visible, 're-enabled overlay closes');
}

// --- real Firefox (disposable profile, local stand-in pages) ----------------

function pageUrl(name, query = '') {
    const dir = GLib.getenv('RACCOON_TEST_PAGES');
    return Gio.File.new_for_path(`${dir}/${name}`).get_uri() + query;
}

function windowByTitle(re) {
    return global.display.list_all_windows().find(w => re.test(w.get_title() ?? ''));
}

async function testFirefox(input) {
    const inst = ext().stateObj;
    const browser = inst._browser;
    const ai = inst._aiWindow;
    const fakeUrl = p => pageUrl('fakechat.html', `?temporary-chat=true&q=${encodeURIComponent(p)}`);

    // 1. Start Firefox normally with a "normal" window (no instance running yet).
    browser._env.spawn(['firefox', '--new-window', pageUrl('normal.html')]);
    const normal = await waitFor(() => windowByTitle(/NORMAL WINDOW/), 90000, 200);
    if (!check(normal, 'firefox: normal window started'))
        return;
    const normalApp = browser._env.appIdForWindow(normal);
    check(normalApp === browser.getFirefox()?.get_id(), 'firefox: window tracked as the Firefox app',
        `${normalApp} vs ${browser.getFirefox()?.get_id()}`);
    const normalRect0 = normal.get_frame_rect();
    await sleep(1500);

    // Diagnostic: does keyboard input from the compositor reach Firefox yet?
    // (A failing run here first exposed a system-modal welcome dialog.)
    browser._env.spawn(['firefox', '--new-window', pageUrl('keytest.html')]);
    const kt = await waitFor(() => windowByTitle(/KEYTEST|^KEY /), 30000, 100);
    if (kt) {
        Main.activateWindow(kt);
        await waitFor(() => global.display.focus_window === kt, 3000);
        // Wait for the page itself to report focus before typing.
        await waitFor(() => /\+F/.test(kt.get_title()), 5000, 100);
        await sleep(300);
        // Return is the key the launcher injects. (Letter keys from the
        // virtual keyboard were intermittently not delivered to a freshly
        // started Firefox in this headless setup; Return was.)
        for (let i = 0; i < 3 && !/KEY Enter/.test(kt.get_title()); i++) {
            // eslint-disable-next-line no-await-in-loop
            await input.key(Clutter.KEY_Return);
            // eslint-disable-next-line no-await-in-loop
            await sleep(800);
        }
        if (!/KEY Enter/.test(kt.get_title())) {
            // Explain a failed precondition: which shell UI holds the keyboard?
            const labels = a => [a.text ?? '', ...(a.get_children?.() ?? []).flatMap(labels)].filter(Boolean);
            console.log(`RACCOON_DIAG stageFocus=${global.stage.key_focus} actionMode=${Main.actionMode} modal=${Main.modalCount}`);
            for (const a of Main.layoutManager.uiGroup.get_children().filter(c => c.visible && c.reactive))
                console.log(`RACCOON_DIAG visible: ${a} ${JSON.stringify(labels(a).slice(0, 4))}`);
        }
        // Informational only: the behaviours below are asserted directly.
        console.log(`RACCOON_TEST NOTE key-test window ${/KEY Enter/.test(kt.get_title())
            ? 'received' : 'did not receive'} Return shortly after Firefox started ("${kt.get_title()}")`);
        kt.delete(global.display.get_current_time_roundtrip());
        await waitFor(() => !global.display.list_all_windows().includes(kt), 5000);
    } else {
        check(false, 'firefox precondition: key-test window opened');
    }

    // 2. Full AI flow through the real overlay, real keys, real controller,
    //    with only the URL pointed at the local stand-in page.
    ai._buildUrl = fakeUrl;
    const prompt = 'ما هو GNOME? a&b=c #1 + "quotes"';
    const overlay = inst._overlay;
    overlay.open();
    await input.type('c ');
    overlay._entry.set_text(`c ${prompt}`);
    await results_(overlay);
    const before = new Set(global.display.list_all_windows());
    await input.key(Clutter.KEY_Return);
    check(!overlay.isOpen, 'firefox: overlay closed before launch');

    const managed = await waitFor(() => ai.window, 30000, 100);
    if (!check(managed && managed !== normal && !before.has(managed),
        'firefox: new AI window identified (not the normal window)'))
        return;
    const submitted = await waitFor(() => /SUBMITTED/.test(managed.get_title()) && managed.get_title(), 30000, 100);
    check(submitted && submitted.startsWith(`SUBMITTED 1 TEMP: ${prompt}`),
        'firefox: prompt transferred (Unicode/symbols intact) and submitted once', submitted);

    const wa = Main.layoutManager.getWorkAreaForMonitor(managed.get_monitor());
    const f = managed.get_frame_rect();
    const expectW = Math.min(900, wa.width - 48), expectH = Math.min(650, wa.height - 48);
    const cx = wa.x + wa.width / 2, cy = wa.y + wa.height / 2;
    check(Math.abs(f.width - expectW) <= 2 && Math.abs(f.height - expectH) <= 2 &&
        Math.abs(f.x + f.width / 2 - cx) <= 2 && Math.abs(f.y + f.height / 2 - cy) <= 2 &&
        !managed.is_maximized(),
    'firefox: AI window centred at ~900×650 within the work area',
    `frame=${f.x},${f.y} ${f.width}x${f.height} wa=${wa.x},${wa.y} ${wa.width}x${wa.height}`);
    check(global.display.focus_window === managed, 'firefox: AI window focused');
    const nr = normal.get_frame_rect();
    check(nr.x === normalRect0.x && nr.y === normalRect0.y && nr.width === normalRect0.width &&
        nr.height === normalRect0.height, 'firefox: normal window geometry untouched');
    await sleep(4000);
    check(/^SUBMITTED 1 /.test(managed.get_title()), 'firefox: no duplicate submission after retries',
        managed.get_title());

    // 3. Web search with both windows open, AI window focused.
    const r = browser.openSearch(pageUrl('search.html', '?q=routing'));
    const routed = await waitFor(() => /SEARCH routing/.test(normal.get_title()), 20000, 100);
    check(r === 'tab' && routed && /SUBMITTED/.test(managed.get_title()),
        'firefox: search opens in the normal window, not the AI window',
        `path=${r} normal="${normal.get_title()}" ai="${managed.get_title()}"`);

    // 4. Escape in the normal window does not close anything.
    Main.activateWindow(normal);
    await waitFor(() => global.display.focus_window === normal, 3000);
    await input.key(Clutter.KEY_Escape);
    await sleep(800);
    check(ai.window === managed && global.display.list_all_windows().includes(normal),
        'firefox: Escape elsewhere leaves both windows open');

    // 5. Escape in the AI window closes only it.
    Main.activateWindow(managed);
    await waitFor(() => global.display.focus_window === managed, 3000);
    await sleep(200);
    await input.key(Clutter.KEY_Escape);
    const gone = await waitFor(() => !global.display.list_all_windows().includes(managed), 5000);
    check(gone && ai.window === null, 'firefox: Escape closes the focused AI window');
    check(global.display.list_all_windows().includes(normal), 'firefox: normal window still open (Firefox alive)');

    // 6. Each question replaces the previous AI window only.
    const p2 = ai.open('second question');
    const w2 = await waitFor(() => ai.window, 30000, 100);
    await p2.catch(e => record(false, 'firefox: second open', e.message));
    const p3 = ai.open('third question');
    const w3 = await waitFor(() => ai.window && ai.window !== w2 && ai.window, 30000, 100);
    const res3 = await p3.catch(e => ({error: e.message}));
    await sleep(1000);
    const all = global.display.list_all_windows();
    check(w2 && w3 && !all.includes(w2) && all.includes(w3) && all.includes(normal),
        'firefox: new question closes only the previous AI window',
        `w2 open=${all.includes(w2)} w3 open=${all.includes(w3)} normal=${all.includes(normal)}`);
    check(/SUBMITTED 1 TEMP: third question/.test(w3?.get_title() ?? '') && res3?.confirmed === true,
        'firefox: replacement window submitted its own prompt', `${w3?.get_title()} ${JSON.stringify(res3)}`);

    // 7. Disable keeps the AI window (screen lock also disables) and
    //    leaves Escape to Firefox afterwards.
    check(await setEnabled(false), 'firefox: disable with AI window open');
    await sleep(500);
    check(global.display.list_all_windows().includes(w3), 'firefox: disable does not close the AI window');
    Main.activateWindow(w3);
    await sleep(300);
    await input.key(Clutter.KEY_Escape);
    await sleep(800);
    check(global.display.list_all_windows().includes(w3), 'firefox: no Escape grab left after disable');
    check(await setEnabled(true), 'firefox: re-enable');
}

export default class RaccoonTestDriver extends Extension {
    enable() {
        if (started)
            return;
        started = true;
        outPath = GLib.getenv('RACCOON_TEST_OUT');
        this._idle = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._idle = 0;
            this._run().catch(e => {
                record(false, 'driver crashed', `${e}\n${e.stack}`);
                flush(true);
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {
        if (this._idle)
            GLib.source_remove(this._idle);
        this._idle = 0;
    }

    async _run() {
        await waitFor(() => !Main.layoutManager._startingUp, 30000);
        const loaded = await waitFor(() => ext() && [ExtensionState.ACTIVE, ExtensionState.ERROR,
            ExtensionState.OUT_OF_DATE].includes(ext().state), 30000);
        if (!check(loaded && ext().state === ExtensionState.ACTIVE, 'extension loads and is ACTIVE',
            `state=${ext()?.state} error=${ext()?.error}`)) {
            flush(true);
            return;
        }

        // The headless session may still be showing the startup overview,
        // which would take keyboard focus away from the launcher.
        await waitFor(() => !Main.layoutManager._startingUp, 30000);
        if (Main.overview.visible)
            Main.overview.hide();
        await waitFor(() => !Main.overview.visible && !Main.overview.animationInProgress &&
            Main.modalCount === 0, 15000);
        await sleep(300);

        // RACCOON_TEST_ONLY=group,group selects scenario groups (default: all).
        const only = (GLib.getenv('RACCOON_TEST_ONLY') ?? '').split(',').filter(Boolean);
        const want = group => only.length === 0 || only.includes(group);
        const groups = [
            ['overlay', testOverlay],
            ['folders', testFolders],
            ['lifecycle', testLifecycle],
        ];

        const input = new Input();
        try {
            for (const [name, fn] of groups) {
                if (!want(name))
                    continue;
                console.log(`RACCOON_TEST group ${name}`);
                // eslint-disable-next-line no-await-in-loop
                await fn(input);
                flush(false);
            }
            if (GLib.getenv('RACCOON_TEST_FIREFOX') === '1')
                await testFirefox(input);
        } catch (e) {
            record(false, 'driver exception', `${e}\n${e.stack}`);
        } finally {
            input.destroy();
            flush(true);
        }
    }
}
