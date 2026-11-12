import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import {buildAiUrl} from './browser.js';

const DEFAULTS = {
    width: 900,              // logical pixels
    height: 650,
    margin: 24,              // minimum gap to the work-area edges
    claimTimeoutMs: 15000,   // the new Firefox window must appear by then
    ambiguityMs: 400,        // a second new Firefox window within this → ambiguous
    readyTimeoutMs: 30000,   // the page title must look like ChatGPT by then
    readyTitle: /ChatGPT/i,
    settleMs: 1500,          // after the title is ready, before pressing Enter
    confirmMs: 3000,         // wait for a title change after pressing Enter
    maxSubmitAttempts: 3,
    placementWatchMs: 1500,  // re-assert geometry if Firefox resizes itself
    maxPlacementRetries: 3,
};

export class AiCancelledError extends Error {
    constructor(message = 'AI request cancelled') {
        super(message);
        this.name = 'AiCancelledError';
    }
}

/**
 * Centered rectangle of at most width × height inside `workArea`, keeping
 * `margin` free on each side when the work area is small.
 *
 * @param {{x: number, y: number, width: number, height: number}} workArea
 * @param {number} width - preferred width
 * @param {number} height - preferred height
 * @param {number} margin - minimum free space at each edge
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function centeredRect(workArea, width, height, margin) {
    const w = Math.max(1, Math.min(width, workArea.width - 2 * margin));
    const h = Math.max(1, Math.min(height, workArea.height - 2 * margin));
    return {
        x: workArea.x + Math.floor((workArea.width - w) / 2),
        y: workArea.y + Math.floor((workArea.height - h) / 2),
        width: w,
        height: h,
    };
}

// Launches, identifies, positions, submits to, replaces and closes the one
// Firefox window this extension manages for AI mode.
//
// Ownership: Firefox windows share one process, so the PID or app id alone
// cannot identify the new window. A window is claimed only if it is created
// *after* the launch request, was not present before it, is a normal window,
// belongs to the Firefox app that was launched, and is the only such window
// to appear within a short interval. Anything else (timeout, two candidates)
// fails safely: no window is touched and nothing is submitted.
//
// Submission: ChatGPT prefills the composer from `q=` but does not send it.
// Once the page title shows ChatGPT has loaded, a single Return key press is
// injected through a compositor virtual keyboard — only while the claimed
// window has keyboard focus. If the title does not change afterwards (the
// composer may not have been filled yet), Return is retried a bounded number
// of times, but only while the window is still focused and the user has not
// touched keyboard or pointer since the last attempt; Return in an empty
// composer is a no-op, so a retry cannot send twice.
//
// Escape: while the managed window is focused (and the launcher overlay is
// closed), Escape is grabbed as a compositor accelerator and closes only that
// window. The grab is released as soon as focus moves elsewhere.
export class AiWindowController {
    /**
     * @param {object} env - injected environment (see lib/shellEnv.js)
     * @param {object} [options] - overrides for DEFAULTS, plus `buildUrl`
     */
    constructor(env, options = {}) {
        this._env = env;
        this._opts = {...DEFAULTS, ...options};
        this._buildUrl = options.buildUrl ?? (prompt => buildAiUrl(prompt));
        this._browser = env.browser;
        this._display = env.display;

        this._window = null;
        this._windowSignals = [];
        this._request = null;
        this._timeouts = new Set();
        this._escapeAction = Meta.KeyBindingAction.NONE;
        this._escapeName = null;
        this._suspended = false;
        this._keyboard = null;

        this._displaySignals = [
            this._display.connect('notify::focus-window', () => this._syncEscape()),
            this._display.connect('accelerator-activated',
                (_d, action) => this._onAccelerator(action)),
        ];
    }

    get window() {
        return this._window;
    }

    isManagedWindow(window) {
        return !!window && window === this._window;
    }

    /** Pause the Escape grab while the launcher overlay is open. */
    setSuspended(suspended) {
        this._suspended = suspended;
        this._syncEscape();
    }

    /**
     * Open a fresh Temporary Chat window and submit `prompt`.
     *
     * @param {string} prompt - the question
     * @returns {Promise<{window: Meta.Window, confirmed: boolean}>} resolves
     *   once Return has been sent; rejects with a user-facing message
     */
    open(prompt) {
        prompt = (prompt ?? '').trim();
        if (!prompt)
            return Promise.reject(new Error('Type a question first.'));

        this._endRequest(this._request,
            new AiCancelledError('Replaced by a newer AI request'));

        return new Promise((resolve, reject) => {
            const request = {
                prompt,
                monitor: this._env.getCurrentMonitor(),
                known: new Set(this._display.list_all_windows()),
                candidates: [],
                cleanups: [],
                resolve,
                reject,
                appId: null,
            };
            this._request = request;

            const createdId = this._display.connect('window-created',
                (_d, w) => this._onWindowCreated(request, w));
            request.cleanups.push(() => this._display.disconnect(createdId));

            try {
                request.appId = this._browser.openNewWindow(this._buildUrl(prompt));
            } catch (e) {
                this._endRequest(request, e);
                return;
            }

            this._requestTimeout(request, this._opts.claimTimeoutMs, () =>
                this._endRequest(request, new Error(
                    'Firefox did not open a new window in time. Nothing was sent.')));
        });
    }

    /** Ask the managed window (and only it) to close. */
    closeManagedWindow() {
        if (!this._window)
            return false;
        this._window.delete(this._env.currentTime());
        return true;
    }

    destroy() {
        this._endRequest(this._request, new AiCancelledError('Extension disabled'));
        // The window itself is left open: disable() also runs on screen lock,
        // and closing the user's chat then would lose it.
        this._releaseWindow();
        for (const id of this._timeouts)
            this._env.clearTimeout(id);
        this._timeouts.clear();
        for (const id of this._displaySignals)
            this._display.disconnect(id);
        this._displaySignals = [];
        this._keyboard?.run_dispose();
        this._keyboard = null;
    }

    // --- identification --------------------------------------------------

    _onWindowCreated(request, window) {
        if (request !== this._request || request.claimed)
            return;
        if (request.known.has(window) ||
            window.get_window_type() !== Meta.WindowType.NORMAL)
            return;

        // On Wayland the app id may still be unset when the window is
        // created; decide once the window is first shown.
        const ids = [];
        const disconnectAll = () => {
            for (const id of ids.splice(0))
                window.disconnect(id);
        };
        ids.push(window.connect('shown', () => {
            disconnectAll();
            this._considerCandidate(request, window);
        }));
        ids.push(window.connect('unmanaged', disconnectAll));
        request.cleanups.push(disconnectAll);
    }

    _considerCandidate(request, window) {
        if (request !== this._request || request.claimed)
            return;
        if (this._env.appIdForWindow(window) !== request.appId)
            return;

        request.candidates.push(window);
        if (request.candidates.length === 1) {
            this._requestTimeout(request, this._opts.ambiguityMs,
                () => this._claim(request));
        } else {
            this._endRequest(request, new Error(
                'Several new Firefox windows appeared at once, so the AI window ' +
                'could not be identified. Nothing was sent; please try again.'));
        }
    }

    _claim(request) {
        const window = request.candidates[0];
        if (!window || !window.get_compositor_private()) {
            this._endRequest(request, new Error(
                'The new Firefox window closed before it could be used. Nothing was sent.'));
            return;
        }
        request.claimed = true;
        this._clearRequestTimers(request);

        const previous = this._window;
        this._adopt(window);
        if (previous && previous !== window)
            previous.delete(this._env.currentTime());

        this._place(window, request);
        this._env.activateWindow(window);
        this._waitForPage(request, window);
    }

    _adopt(window) {
        this._releaseWindow();
        this._window = window;
        this._windowSignals = [
            window.connect('unmanaged', () => this._onWindowGone(window)),
        ];
        this._syncEscape();
    }

    _releaseWindow() {
        this._ungrabEscape();
        if (this._window) {
            for (const id of this._windowSignals)
                this._window.disconnect(id);
        }
        this._windowSignals = [];
        this._window = null;
    }

    _onWindowGone(window) {
        if (window !== this._window)
            return;
        this._releaseWindow();
        if (this._request?.claimed && this._request.window === window) {
            this._endRequest(this._request, new Error(
                'The AI window was closed before the prompt was sent.'));
        }
    }

    // --- placement -------------------------------------------------------

    _place(window, request) {
        const {width, height, margin} = this._opts;
        const rect = centeredRect(this._env.getWorkArea(request.monitor),
            width, height, margin);

        const apply = () => {
            if (window.is_fullscreen())
                window.unmake_fullscreen();
            if (window.is_maximized()) {
                // Mutter 49+ takes no flags; earlier releases required them.
                if (window.unmaximize.length === 0)
                    window.unmaximize();
                else
                    window.unmaximize(Meta.MaximizeFlags.BOTH);
            }
            if (window.get_monitor() !== request.monitor)
                window.move_to_monitor(request.monitor);
            window.move_resize_frame(false, rect.x, rect.y, rect.width, rect.height);
        };
        apply();

        // Firefox can re-apply its remembered size right after mapping or
        // unmaximizing; re-assert the geometry briefly.
        let retries = 0;
        const check = () => {
            const f = window.get_frame_rect();
            const off = Math.abs(f.x - rect.x) > 2 || Math.abs(f.y - rect.y) > 2 ||
                Math.abs(f.width - rect.width) > 2 || Math.abs(f.height - rect.height) > 2;
            if (off && retries < this._opts.maxPlacementRetries) {
                retries++;
                apply();
            }
        };
        const ids = [
            window.connect('size-changed', check),
            window.connect('position-changed', check),
        ];
        const stop = () => {
            for (const id of ids.splice(0))
                window.disconnect(id);
        };
        request.cleanups.push(stop);
        this._requestTimeout(request, this._opts.placementWatchMs, stop);
        request.rect = rect;
    }

    // --- submission ------------------------------------------------------

    _waitForPage(request, window) {
        request.window = window;
        const ready = () => this._opts.readyTitle.test(window.get_title() ?? '');

        let readyTimeout = 0;
        const onReady = () => {
            this._clearRequestTimer(request, readyTimeout);
            this._requestTimeout(request, this._opts.settleMs,
                () => this._submit(request, window, 1));
        };

        if (ready()) {
            onReady();
            return;
        }

        const titleId = window.connect('notify::title', () => {
            if (!ready())
                return;
            window.disconnect(titleId);
            request.titleId = 0;
            onReady();
        });
        request.titleId = titleId;
        request.cleanups.push(() => {
            if (request.titleId)
                window.disconnect(request.titleId);
            request.titleId = 0;
        });
        readyTimeout = this._requestTimeout(request, this._opts.readyTimeoutMs, () =>
            this._endRequest(request, new Error(
                'ChatGPT did not finish loading in time, so the prompt was not sent. ' +
                'Check that you are signed in to chatgpt.com in Firefox.')));
    }

    _submit(request, window, attempt) {
        if (request !== this._request || window !== this._window)
            return;
        if (this._display.focus_window !== window) {
            this._endRequest(request, new Error(
                'The AI window lost focus before the prompt could be sent. ' +
                'The question is in the ChatGPT box; press Enter there to send it.'));
            return;
        }

        const titleBefore = window.get_title();
        this._pressReturn();
        const sentAt = this._env.now();
        console.debug(`RaccoonLauncher: AI prompt Return sent (attempt ${attempt})`);

        this._requestTimeout(request, this._opts.confirmMs, () => {
            if (window.get_title() !== titleBefore) {
                this._endRequest(request, null, {window, confirmed: true});
                return;
            }
            const idleSince = this._env.getIdleTime() >= this._env.now() - sentAt - 100;
            if (attempt < this._opts.maxSubmitAttempts && idleSince &&
                this._display.focus_window === window) {
                this._submit(request, window, attempt + 1);
                return;
            }
            this._endRequest(request, null, {window, confirmed: false});
        });
    }

    _pressReturn() {
        this._keyboard ??= this._env.createKeyboard();
        const t = GLib.get_monotonic_time();
        this._keyboard.notify_keyval(t, Clutter.KEY_Return, Clutter.KeyState.PRESSED);
        this._keyboard.notify_keyval(t + 1000, Clutter.KEY_Return, Clutter.KeyState.RELEASED);
    }

    // --- Escape ------------------------------------------------------------

    _syncEscape() {
        const want = !!this._window && !this._suspended &&
            this._display.focus_window === this._window;

        if (want && this._escapeAction === Meta.KeyBindingAction.NONE) {
            const action = this._display.grab_accelerator('Escape', Meta.KeyBindingFlags.NONE);
            if (action === Meta.KeyBindingAction.NONE) {
                console.warn('RaccoonLauncher: could not grab Escape for the AI window');
                return;
            }
            this._escapeAction = action;
            this._escapeName = Meta.external_binding_name_for_action(action);
            this._env.allowKeybinding(this._escapeName, true);
        } else if (!want) {
            this._ungrabEscape();
        }
    }

    _ungrabEscape() {
        if (this._escapeAction === Meta.KeyBindingAction.NONE)
            return;
        this._display.ungrab_accelerator(this._escapeAction);
        this._env.allowKeybinding(this._escapeName, false);
        this._escapeAction = Meta.KeyBindingAction.NONE;
        this._escapeName = null;
    }

    _onAccelerator(action) {
        if (action === Meta.KeyBindingAction.NONE || action !== this._escapeAction)
            return;
        if (this._window && this._display.focus_window === this._window)
            this.closeManagedWindow();
    }

    // --- request bookkeeping ----------------------------------------------

    _timeout(ms, fn) {
        const id = this._env.timeout(ms, () => {
            this._timeouts.delete(id);
            fn();
        });
        this._timeouts.add(id);
        return id;
    }

    _clearTimeout(id) {
        if (this._timeouts.delete(id))
            this._env.clearTimeout(id);
    }

    _requestTimeout(request, ms, fn) {
        request.timers ??= new Set();
        const id = this._timeout(ms, () => {
            request.timers.delete(id);
            fn();
        });
        request.timers.add(id);
        return id;
    }

    _clearRequestTimer(request, id) {
        if (request.timers?.delete(id))
            this._clearTimeout(id);
    }

    _clearRequestTimers(request) {
        for (const id of request.timers ?? [])
            this._clearTimeout(id);
        request.timers?.clear();
    }

    _endRequest(request, error, value) {
        if (!request || request.ended)
            return;
        request.ended = true;
        if (this._request === request)
            this._request = null;

        this._clearRequestTimers(request);
        for (const cleanup of request.cleanups.splice(0)) {
            try {
                cleanup();
            } catch (e) {
                logError(e, 'RaccoonLauncher: AI request cleanup failed');
            }
        }

        // The previous managed window is only replaced once a new window has
        // been claimed; a failed request leaves it (and everything else) as is.
        if (error)
            request.reject(error);
        else
            request.resolve(value);
    }
}
