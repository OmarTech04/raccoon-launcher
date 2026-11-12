import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// User-supplied entry point for a new ChatGPT Temporary Chat. The prompt is
// added as the `q` parameter, which ChatGPT uses to prefill the composer
// (verified: it prefills but does not submit; see aiWindow.js).
export const AI_ENTRY_URL = 'https://chatgpt.com/?temporary-chat=true';

const FIREFOX_IDS = [
    'org.mozilla.firefox.desktop',
    'firefox.desktop',
    'firefox-esr.desktop',
];

export function isFirefoxAppId(id) {
    return /(^|\.)firefox(-[a-z]+)?\.desktop$/i.test(id ?? '');
}

/**
 * Build the URL that opens a fresh Temporary Chat with `prompt` prefilled.
 * The prompt is URL data only (percent-encoded), never shell code.
 *
 * @param {string} prompt - the user's question
 * @param {string} [entryUrl] - entry point (defaults to AI_ENTRY_URL)
 * @returns {string}
 */
export function buildAiUrl(prompt, entryUrl = AI_ENTRY_URL) {
    const sep = entryUrl.includes('?') ? '&' : '?';
    return `${entryUrl}${sep}q=${encodeURIComponent(prompt)}`;
}

/**
 * Turn a desktop-entry command line ("firefox %u", or a Flatpak
 * "flatpak run ... org.mozilla.firefox @@u %u @@") into an argument vector,
 * putting `extraArgs` where the URL field code was. Other field codes are
 * dropped. No shell is ever involved; each element is a separate argv entry.
 *
 * @param {string} commandline - Exec value with field codes
 * @param {string[]} extraArgs - arguments that replace the URL field code
 * @returns {string[]}
 */
export function buildBrowserArgv(commandline, extraArgs) {
    const [, argv] = GLib.shell_parse_argv(commandline);
    const out = [];
    let inserted = false;
    const insert = () => {
        if (!inserted)
            out.push(...extraArgs);
        inserted = true;
    };

    for (const arg of argv) {
        if (arg === '@@u' || arg === '@@') {
            // Flatpak file forwarding markers; web URLs need no forwarding.
            if (arg === '@@u')
                insert();
            continue;
        }
        if (/^%[uUfF]$/.test(arg)) {
            insert();
            continue;
        }
        if (/^%[a-zA-Z]$/.test(arg))
            continue;
        out.push(arg.replace(/%%/g, '%'));
    }
    insert();
    return out;
}

// Centralizes default-browser handling: opening web searches and launching
// the managed AI window with the user's existing Firefox profile.
//
// Firefox is always launched through its own desktop-entry command with
// --new-tab / --new-window. When an instance is already running, that
// command hands the URL to the running instance (same profile, same
// session) and exits; otherwise it starts Firefox normally. No profile
// flags, private mode, remote debugging or profile files are involved.
export class BrowserLauncher {
    /**
     * @param {object} env - injected environment (see lib/shellEnv.js)
     * @param {Function} env.getDefaultHandler - () => Gio.AppInfo|null for https
     * @param {Function} env.findApp - (id) => Gio.AppInfo|null
     * @param {Function} env.spawn - (argv) => void; throws on failure
     * @param {Function} env.launchDefault - (url) => void
     * @param {Function} env.listAppWindows - (appId) => Meta.Window[] (MRU first)
     * @param {Function} env.activateWindow - (window) => void
     * @param {Function} [env.isManagedWindow] - (window) => boolean
     */
    constructor(env) {
        this._env = env;
    }

    set isManagedWindow(fn) {
        this._env.isManagedWindow = fn;
    }

    /** @returns {Gio.AppInfo|null} the Firefox app to use for AI mode */
    getFirefox() {
        const def = this._env.getDefaultHandler();
        if (def && isFirefoxAppId(def.get_id()))
            return def;
        for (const id of FIREFOX_IDS) {
            const app = this._env.findApp(id);
            if (app)
                return app;
        }
        return null;
    }

    /**
     * Open a web-search URL.
     *
     * For non-Firefox default browsers the URL is handed to the generic
     * default-handler launch, unchanged from earlier versions.
     *
     * For Firefox, the URL opens as a new tab in the most recently used
     * *normal* Firefox window. Firefox itself would pick its most recently
     * focused window, which may be the launcher-managed AI window, so that
     * normal window is activated first. If only the AI window exists, a new
     * window is opened instead; if Firefox is not running it starts normally.
     *
     * @param {string} url - fully encoded URL
     * @returns {string} which path was taken: 'default' | 'tab' | 'window'
     */
    openSearch(url) {
        const app = this._env.getDefaultHandler();
        if (!app || !isFirefoxAppId(app.get_id())) {
            this._env.launchDefault(url);
            return 'default';
        }

        const windows = this._env.listAppWindows(app.get_id());
        const isManaged = this._env.isManagedWindow ?? (() => false);
        const normal = windows.filter(w => !isManaged(w));

        if (normal.length === 0 && windows.length > 0) {
            this._env.spawn(buildBrowserArgv(app.get_commandline(), ['--new-window', url]));
            return 'window';
        }

        if (normal.length > 0)
            this._env.activateWindow(normal[0]);
        this._env.spawn(buildBrowserArgv(app.get_commandline(), ['--new-tab', url]));
        return 'tab';
    }

    /**
     * Ask Firefox (existing default profile) for a new window showing `url`.
     *
     * @param {string} url - fully encoded URL
     * @returns {string} the Firefox desktop app id that will own the window
     */
    openNewWindow(url) {
        const app = this.getFirefox();
        if (!app)
            throw new Error('Firefox is not installed; AI mode needs Firefox.');
        this._env.spawn(buildBrowserArgv(app.get_commandline(), ['--new-window', url]));
        return app.get_id();
    }
}
