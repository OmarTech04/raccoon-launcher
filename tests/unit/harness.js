// Minimal async test harness for plain `gjs -m` (no GNOME Shell needed).
import GLib from 'gi://GLib';

const tests = [];
let currentModule = '';

/** Tag the tests registered after this call with a module name. */
export function module(name) {
    currentModule = name;
}

export function test(name, fn) {
    tests.push({name, fn, module: currentModule});
}

export class AssertionError extends Error {}

export function assert(cond, msg = 'assertion failed') {
    if (!cond)
        throw new AssertionError(msg);
}

export function assertEqual(actual, expected, msg = '') {
    if (actual !== expected) {
        throw new AssertionError(
            `${msg ? `${msg}: ` : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

export function assertDeepEqual(actual, expected, msg = '') {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a !== e)
        throw new AssertionError(`${msg ? `${msg}: ` : ''}expected ${e}, got ${a}`);
}

export async function assertRejects(promise, check, msg = 'expected rejection') {
    try {
        await promise;
    } catch (e) {
        if (check && !check(e))
            throw new AssertionError(`${msg}: unexpected error ${e}`);
        return e;
    }
    throw new AssertionError(msg);
}

/**
 * Run the registered tests. With `filters`, only tests whose module name
 * equals a filter, or whose name contains one, are run.
 *
 * @param {string[]} [filters] - module names or test-name substrings
 */
export async function run(filters = []) {
    const selected = filters.length === 0 ? tests
        : tests.filter(t => filters.some(f => t.module === f || t.name.includes(f)));
    if (selected.length === 0) {
        print(`no tests match ${JSON.stringify(filters)}`);
        return 1;
    }
    let failed = 0;
    for (const {name, fn} of selected) {
        try {
            // eslint-disable-next-line no-await-in-loop
            await fn();
            print(`ok   ${name}`);
        } catch (e) {
            failed++;
            print(`FAIL ${name}\n     ${e}\n${e.stack ?? ''}`);
        }
    }
    print(`\n${selected.length - failed}/${selected.length} passed` +
        (selected.length < tests.length ? ` (selected from ${tests.length})` : ''));
    return failed;
}

/** Run `main` inside a GLib main loop (Gio async calls need one). */
export function runMain(main) {
    const loop = new GLib.MainLoop(null, false);
    let code = 1;
    main().then(c => {
        code = c;
    }).catch(e => {
        print(`harness error: ${e}\n${e.stack}`);
    }).finally(() => loop.quit());
    loop.run();
    return code;
}
