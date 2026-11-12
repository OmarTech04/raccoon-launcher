import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';

import {test, assert, assertEqual, assertDeepEqual, assertRejects} from './harness.js';
import {AiWindowController, AiCancelledError, centeredRect} from '../../lib/aiWindow.js';

// --- fakes ------------------------------------------------------------------

class Emitter {
    constructor() {
        this._handlers = new Map();
        this._next = 1;
    }

    connect(name, fn) {
        const id = this._next++;
        this._handlers.set(id, {name, fn});
        return id;
    }

    disconnect(id) {
        if (!this._handlers.delete(id))
            throw new Error(`no handler ${id}`);
    }

    emit(name, ...args) {
        for (const {name: n, fn} of [...this._handlers.values()]) {
            if (n === name)
                fn(this, ...args);
        }
    }

    count(name) {
        return [...this._handlers.values()].filter(h => !name || h.name === name).length;
    }
}

const FIREFOX = 'org.mozilla.firefox.desktop';

class FakeWindow extends Emitter {
    constructor(display, {app = FIREFOX, title = 'Mozilla Firefox', type = Meta.WindowType.NORMAL,
        maximized = true} = {}) {
        super();
        this.display = display;
        this.app = app;
        this.title = title;
        this.type = type;
        this.maximized = maximized;
        this.frame = {x: 0, y: 0, width: 1280, height: 800};
        this.monitor = 0;
        this.deleted = 0;
        this.moves = [];
        this.alive = true;
    }

    get_window_type() {
        return this.type;
    }

    get_title() {
        return this.title;
    }

    setTitle(t) {
        this.title = t;
        this.emit('notify::title');
    }

    get_compositor_private() {
        return this.alive ? {} : null;
    }

    is_fullscreen() {
        return false;
    }

    is_maximized() {
        return this.maximized;
    }

    unmaximize() {
        this.maximized = false;
    }

    get_monitor() {
        return this.monitor;
    }

    move_to_monitor(i) {
        this.monitor = i;
    }

    move_resize_frame(_user, x, y, width, height) {
        this.moves.push({x, y, width, height});
        this.frame = {x, y, width, height};
    }

    get_frame_rect() {
        return this.frame;
    }

    delete() {
        this.deleted++;
        this.unmanage();
    }

    unmanage() {
        this.alive = false;
        if (this.display.focus_window === this)
            this.display.setFocus(null);
        this.display.windows = this.display.windows.filter(w => w !== this);
        this.emit('unmanaged');
    }
}

class FakeDisplay extends Emitter {
    constructor() {
        super();
        this.windows = [];
        this.focus_window = null;
        this.grabs = [];
        this.ungrabs = [];
        this.nextAction = 100;
    }

    list_all_windows() {
        return [...this.windows];
    }

    setFocus(w) {
        this.focus_window = w;
        this.emit('notify::focus-window');
    }

    grab_accelerator(accel) {
        const action = this.nextAction++;
        this.grabs.push({accel, action});
        return action;
    }

    ungrab_accelerator(action) {
        this.ungrabs.push(action);
        return true;
    }

    /** Simulate a window being created and then shown (Wayland order). */
    createWindow(opts) {
        const w = new FakeWindow(this, opts);
        this.windows.push(w);
        this.emit('window-created', w);
        w.emit('shown');
        return w;
    }
}

class FakeClock {
    constructor() {
        this.now = 0;
        this.timers = new Map();
        this.nextId = 1;
    }

    timeout(ms, fn) {
        const id = this.nextId++;
        this.timers.set(id, {at: this.now + ms, fn});
        return id;
    }

    clear(id) {
        if (!this.timers.delete(id))
            throw new Error(`clearing unknown timer ${id}`);
    }

    advance(ms) {
        const end = this.now + ms;
        for (;;) {
            const due = [...this.timers.entries()]
                .filter(([, t]) => t.at <= end)
                .sort((a, b) => a[1].at - b[1].at)[0];
            if (!due)
                break;
            this.timers.delete(due[0]);
            this.now = due[1].at;
            due[1].fn();
        }
        this.now = end;
    }
}

function setup({workArea = {x: 0, y: 32, width: 1920, height: 1048}, launchError = null} = {}) {
    const display = new FakeDisplay();
    const clock = new FakeClock();
    const keys = [];
    const allowed = [];
    const activated = [];
    const launches = [];
    let idle = 1e9;
    const browser = {
        openNewWindow: url => {
            if (launchError)
                throw launchError;
            launches.push(url);
            return FIREFOX;
        },
    };
    const env = {
        display,
        browser,
        appIdForWindow: w => w.app,
        activateWindow: w => {
            activated.push(w);
            display.setFocus(w);
        },
        getCurrentMonitor: () => 0,
        getWorkArea: () => workArea,
        createKeyboard: () => ({
            notify_keyval: (_t, key, state) => keys.push([key, state]),
            run_dispose: () => {},
        }),
        allowKeybinding: (name, on) => allowed.push([name, on]),
        getIdleTime: () => idle,
        now: () => clock.now,
        currentTime: () => 1234,
        timeout: (ms, fn) => clock.timeout(ms, fn),
        clearTimeout: id => clock.clear(id),
    };
    const ctl = new AiWindowController(env);
    return {
        ctl, display, clock, keys, allowed, activated, launches,
        setIdle: v => {
            idle = v;
        },
        returns: () => keys.filter(([k, s]) => k === Clutter.KEY_Return && s === Clutter.KeyState.PRESSED).length,
    };
}

/** Drive a full successful open: window appears, page loads, submit confirmed. */
async function openAndSubmit(t, prompt = 'hello') {
    const p = t.ctl.open(prompt);
    const w = t.display.createWindow();
    t.clock.advance(400);                      // ambiguity interval → claimed
    w.setTitle('ChatGPT — Mozilla Firefox');
    t.clock.advance(1500);                     // settle → Return
    w.setTitle('Pineapple — Mozilla Firefox'); // ChatGPT reacted
    t.clock.advance(3000);
    const result = await p;
    return {w, result};
}

// --- tests --------------------------------------------------------------------

test('centeredRect centres 900×650 and shrinks to small work areas', () => {
    assertDeepEqual(centeredRect({x: 0, y: 32, width: 1920, height: 1048}, 900, 650, 24),
        {x: 510, y: 231, width: 900, height: 650});
    assertDeepEqual(centeredRect({x: 1920, y: 0, width: 800, height: 500}, 900, 650, 24),
        {x: 1944, y: 24, width: 752, height: 452});
});

test('ai: empty prompt is rejected without launching', async () => {
    const t = setup();
    await assertRejects(t.ctl.open('   '));
    assertEqual(t.launches.length, 0);
});

test('ai: claims only the new Firefox window, places, focuses and submits once', async () => {
    const t = setup();
    const existing = t.display.createWindow();          // the user's normal window
    const other = new FakeWindow(t.display, {app: 'org.gnome.Nautilus.desktop'});
    const p = t.ctl.open('ما هو GNOME?');
    assertEqual(t.launches.length, 1);
    assert(t.launches[0].includes('temporary-chat=true&q='), t.launches[0]);

    t.display.emit('window-created', existing);        // pre-existing → ignored
    t.display.windows.push(other);
    t.display.emit('window-created', other);
    other.emit('shown');                               // other app → ignored
    const w = t.display.createWindow();
    assertEqual(t.ctl.window, null, 'not claimed before the ambiguity interval');
    t.clock.advance(400);
    assertEqual(t.ctl.window, w);
    assertEqual(w.maximized, false);
    assertDeepEqual(w.frame, {x: 510, y: 231, width: 900, height: 650});
    assertEqual(t.activated.length, 1);
    assertEqual(t.activated[0], w);
    assertEqual(t.returns(), 0, 'nothing sent before the page is ready');

    w.setTitle('ChatGPT — Mozilla Firefox');
    t.clock.advance(1499);
    assertEqual(t.returns(), 0);
    t.clock.advance(1);
    assertEqual(t.returns(), 1);
    w.setTitle('GNOME — Mozilla Firefox');
    t.clock.advance(3000);
    const result = await p;
    assertEqual(result.confirmed, true);
    assertEqual(t.returns(), 1, 'exactly one Return');
    assertEqual(existing.deleted + other.deleted, 0);
    assertDeepEqual(existing.moves, []);
});

test('ai: retries Return only while focused and the user is idle', async () => {
    const t = setup();
    const p = t.ctl.open('hi');
    const w = t.display.createWindow();
    t.clock.advance(400);
    w.setTitle('ChatGPT');
    t.clock.advance(1500);
    assertEqual(t.returns(), 1);
    t.clock.advance(3000);                 // title unchanged, idle → retry
    assertEqual(t.returns(), 2);
    t.setIdle(10);                         // user typed since → no more retries
    t.clock.advance(3000);
    assertEqual(t.returns(), 2);
    const r = await p;
    assertEqual(r.confirmed, false);
});

test('ai: does not inject keys when the window lost focus', async () => {
    const t = setup();
    const p = t.ctl.open('hi');
    const w = t.display.createWindow();
    t.clock.advance(400);
    t.display.setFocus(new FakeWindow(t.display));    // user switched away
    w.setTitle('ChatGPT');
    t.clock.advance(1500);
    await assertRejects(p, e => /lost focus/.test(e.message));
    assertEqual(t.keys.length, 0);
});

test('ai: two new Firefox windows at once is ambiguous → nothing touched or sent', async () => {
    const t = setup();
    const p = t.ctl.open('hi');
    const a = t.display.createWindow();
    const b = t.display.createWindow();
    await assertRejects(p, e => /could not be identified/.test(e.message));
    t.clock.advance(10000);
    assertEqual(t.ctl.window, null);
    assertDeepEqual(a.moves, []);
    assertDeepEqual(b.moves, []);
    assertEqual(a.deleted + b.deleted, 0);
    assertEqual(t.keys.length, 0);
    assertEqual(t.display.count('window-created'), 0, 'listener removed');
});

test('ai: timeout when no window appears cleans up', async () => {
    const t = setup();
    const p = t.ctl.open('hi');
    t.clock.advance(15000);
    await assertRejects(p, e => /did not open a new window/.test(e.message));
    assertEqual(t.display.count('window-created'), 0);
    assertEqual(t.clock.timers.size, 0);
});

test('ai: launch failure rejects and leaves no handlers', async () => {
    const t = setup({launchError: new Error('Firefox is not installed; AI mode needs Firefox.')});
    await assertRejects(t.ctl.open('hi'), e => /not installed/.test(e.message));
    assertEqual(t.display.count('window-created'), 0);
    assertEqual(t.clock.timers.size, 0);
});

test('ai: a new question replaces only the previous managed window', async () => {
    const t = setup();
    const normal = t.display.createWindow();
    const {w: first} = await openAndSubmit(t, 'one');
    const {w: second} = await openAndSubmit(t, 'two');
    assertEqual(first.deleted, 1);
    assertEqual(second.deleted, 0);
    assertEqual(normal.deleted, 0);
    assertEqual(t.ctl.window, second);
    assertEqual(t.launches.length, 2);
});

test('ai: Escape is grabbed only while the managed window is focused, and closes only it', async () => {
    const t = setup();
    const normal = t.display.createWindow();
    const {w} = await openAndSubmit(t);
    assertEqual(t.display.focus_window, w);
    assertEqual(t.display.grabs.length, 1);
    assertEqual(t.display.grabs[0].accel, 'Escape');
    const action = t.display.grabs[0].action;

    t.display.setFocus(normal);
    assertDeepEqual(t.display.ungrabs, [action], 'released when focus leaves');
    t.display.emit('accelerator-activated', action);
    assertEqual(normal.deleted + w.deleted, 0);

    t.display.setFocus(w);
    const action2 = t.display.grabs[1].action;
    t.ctl.setSuspended(true);              // launcher overlay opened
    assertEqual(t.display.ungrabs.at(-1), action2);
    t.ctl.setSuspended(false);
    const action3 = t.display.grabs[2].action;
    t.display.emit('accelerator-activated', 999);   // someone else's accelerator
    assertEqual(w.deleted, 0);
    t.display.emit('accelerator-activated', action3);
    assertEqual(w.deleted, 1);
    assertEqual(normal.deleted, 0);
    assertEqual(t.ctl.window, null);
    assertEqual(t.display.ungrabs.at(-1), action3);
});

test('ai: geometry is re-asserted if Firefox resizes itself right after mapping', async () => {
    const t = setup();
    t.ctl.open('hi').catch(() => {});
    const w = t.display.createWindow();
    t.clock.advance(400);
    assertEqual(w.moves.length, 1);
    w.frame = {x: 0, y: 0, width: 1400, height: 900};
    w.emit('size-changed');
    assertEqual(w.moves.length, 2);
    t.clock.advance(1500);
    w.frame = {x: 0, y: 0, width: 1400, height: 900};
    w.emit('size-changed');
    assertEqual(w.moves.length, 2, 'watch ends after the placement interval');
    t.ctl.destroy();
});

test('ai: window closed before submission rejects', async () => {
    const t = setup();
    const p = t.ctl.open('hi');
    const w = t.display.createWindow();
    t.clock.advance(400);
    w.unmanage();
    await assertRejects(p, e => /closed before the prompt was sent/.test(e.message));
    assertEqual(t.ctl.window, null);
    assertEqual(t.clock.timers.size, 0);
});

test('ai: destroy cancels pending work, removes handlers and keeps the window open', async () => {
    const t = setup();
    const {w} = await openAndSubmit(t);
    const p = t.ctl.open('second');
    t.ctl.destroy();
    await assertRejects(p, e => e instanceof AiCancelledError);
    assertEqual(w.deleted, 0, 'disable must not close the chat');
    assertEqual(t.display.count(), 0, 'all display handlers removed');
    assertEqual(w.count(), 0, 'all window handlers removed');
    assertEqual(t.clock.timers.size, 0, 'all timers removed');
    assertEqual(t.display.grabs.length, t.display.ungrabs.length, 'Escape released');
    assertEqual(t.allowed.at(-1)[1], false);
});

test('ai: a newer request supersedes a pending one', async () => {
    const t = setup();
    const p1 = t.ctl.open('one');
    const p2 = t.ctl.open('two');
    await assertRejects(p1, e => e instanceof AiCancelledError);
    const w = t.display.createWindow();
    t.clock.advance(400);
    assertEqual(t.ctl.window, w);
    w.setTitle('ChatGPT');
    t.clock.advance(1500);
    w.setTitle('Two');
    t.clock.advance(3000);
    assertEqual((await p2).confirmed, true);
    assertEqual(t.returns(), 1);
});
