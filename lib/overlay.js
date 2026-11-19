import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';

import {Mode, parseQuery} from './query.js';
import {copyFileUri} from './fileClipboard.js';

const BOX_WIDTH = 640;
const SCREEN_MARGIN = 16;
const RESULTS_MAX_HEIGHT = 360;
const RESULTS_MIN_HEIGHT = 120;
const CHROME_HEIGHT = 110;          // entry + hint + padding, approximately
const FILE_SEARCH_DEBOUNCE_MS = 200;

const MODE_BADGES = {
    [Mode.AI]: 'ChatGPT',
    [Mode.FILES]: 'Files',
    [Mode.FOLDERS]: 'Folders',
};

// Modes served by the filesystem provider: debounced, cancellable, cleared
// immediately on every change.
const FS_MODES = new Set([Mode.FILES, Mode.FOLDERS]);

const DISABLED_HINTS = {
    [Mode.AI]: 'AI mode is turned off. Enable it in the launcher preferences.',
    [Mode.FILES]: 'File search is turned off. Enable it in the launcher preferences.',
    [Mode.FOLDERS]: 'Folder search is turned off. Enable it in the launcher preferences.',
};

const EMPTY_HINTS = {
    [Mode.FILES]: 'Type part of a file name to search your home folder (hidden files are skipped).',
    [Mode.FOLDERS]: 'Type part of a folder name to search your home folder (hidden folders are skipped).',
};

function isCancelled(e) {
    return e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) ||
        e?.name === 'AiCancelledError';
}

// A centered search box that lives inside a fullscreen, invisible, reactive
// backdrop. Clicking the backdrop (anywhere outside the box) closes the
// launcher; the input grab is best-effort, so a failed grab never freezes the
// session (Escape and the toggle hotkey always close too).
export const LauncherOverlay = GObject.registerClass(
class LauncherOverlay extends St.BoxLayout {
    _init(engine, settings, openPrefs, {onOpenChanged = null} = {}) {
        super._init({
            style_class: 'raccoon-box',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            can_focus: true,
        });

        this._engine = engine;
        this._settings = settings;
        this._openPrefs = openPrefs;
        this._onOpenChanged = onOpenChanged;
        this._results = [];
        this._selected = -1;
        this._isOpen = false;
        this._grab = null;
        this._destroyed = false;

        // Async search bookkeeping: every text change bumps the generation;
        // results from an older generation are discarded even if they arrive
        // after cancellation was requested.
        this._generation = 0;
        this._cancellable = null;
        this._debounceId = 0;
        this._mode = Mode.DEFAULT;

        // Fullscreen invisible click-catcher: reactive, sized to the whole
        // stage, with a fixed layout so the box uses absolute coordinates.
        this._backdrop = new St.Widget({
            style_class: 'raccoon-backdrop',
            reactive: true,
            layout_manager: new Clutter.FixedLayout(),
        });
        this._backdrop.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.ALL,
        }));
        Main.layoutManager.uiGroup.add_child(this._backdrop);

        this._backdrop.add_child(this);
        this._backdrop.hide();

        this._backdrop.connectObject('button-press-event',
            (_a, event) => this._onBackdropPress(event), this);

        // Header row: mode badge, search entry, and a gear button that opens
        // preferences.
        const header = new St.BoxLayout({
            style_class: 'raccoon-header',
            x_expand: true,
        });
        this.add_child(header);

        this._modeBadge = new St.Label({
            style_class: 'raccoon-mode-badge',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        header.add_child(this._modeBadge);

        this._entry = new St.Entry({
            style_class: 'raccoon-entry',
            hint_text: 'Search apps, do math, "g something", "c question", "ff file", "/folder"…',
            can_focus: true,
            x_expand: true,
        });
        header.add_child(this._entry);

        this._settingsButton = new St.Button({
            style_class: 'raccoon-settings-button',
            can_focus: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._settingsButton.set_child(new St.Icon({
            icon_name: 'emblem-system-symbolic',
            style_class: 'raccoon-settings-icon',
        }));
        this._settingsButton.connectObject('clicked',
            () => this._openPreferences(), this);
        header.add_child(this._settingsButton);

        this._hint = new St.Label({
            style_class: 'raccoon-hint',
            visible: false,
            x_expand: true,
        });
        this._hint.clutter_text.line_wrap = true;
        this.add_child(this._hint);

        this._scroll = new St.ScrollView({style_class: 'raccoon-scroll'});
        this._scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this._resultsBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'raccoon-results',
        });
        this._scroll.set_child(this._resultsBox);
        this.add_child(this._scroll);

        this._entry.clutter_text.connectObject(
            'text-changed', () => this._onTextChanged(),
            'key-press-event', (_a, event) => this._onKeyPress(event),
            'activate', () => this._activate(this._selected),
            this);

        // Apply the configurable box color now and on change.
        this._applyColor();
        this._settings.connectObject(
            'changed::box-color', () => this._applyColor(),
            'changed::enable-ai', () => this._refreshIfOpen(),
            'changed::enable-files', () => this._refreshIfOpen(),
            'changed::enable-folders', () => this._refreshIfOpen(),
            this);
    }

    get isOpen() {
        return this._isOpen;
    }

    _applyColor() {
        const color = this._settings.get_string('box-color');
        // Inline style overrides only the background; other box styling stays
        // in the .raccoon-box class.
        this.set_style(color ? `background-color: ${color};` : null);
    }

    _openPreferences() {
        // Release the grab before opening the prefs window.
        this.close();
        try {
            this._openPrefs?.();
        } catch (e) {
            logError(e, 'RaccoonLauncher: failed to open preferences');
        }
    }

    toggle() {
        if (this._isOpen)
            this.close();
        else
            this.open();
    }

    _layoutForMonitor() {
        // The monitor under the pointer / with focus, not always the primary.
        const monitorIndex = global.display.get_current_monitor();
        const wa = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);

        const width = Math.max(1, Math.min(BOX_WIDTH, wa.width - 2 * SCREEN_MARGIN));
        const resultsHeight = Math.max(RESULTS_MIN_HEIGHT,
            Math.min(RESULTS_MAX_HEIGHT, wa.height - CHROME_HEIGHT - 2 * SCREEN_MARGIN));
        const boxHeight = CHROME_HEIGHT + resultsHeight;

        const preferredY = wa.y + Math.floor(wa.height * 0.18);
        const maxY = wa.y + wa.height - boxHeight - SCREEN_MARGIN;
        const y = Math.max(wa.y + SCREEN_MARGIN, Math.min(preferredY, maxY));

        this.set_width(width);
        this._scroll.set_style(`max-height: ${resultsHeight}px;`);
        // Coordinates are relative to the backdrop, whose origin is the stage.
        this.set_position(wa.x + Math.floor((wa.width - width) / 2), y);
    }

    open() {
        if (this._isOpen || this._destroyed)
            return;
        this._isOpen = true;

        this._layoutForMonitor();

        this._backdrop.show();
        Main.layoutManager.uiGroup.set_child_above_sibling(this._backdrop, null);

        this._entry.set_text('');
        this._renderResults([]);
        this._setMode(Mode.DEFAULT);
        this._setHint(null);

        // Catch Escape globally; connected before the grab so a close path
        // always exists.
        global.stage.connectObject('captured-event',
            (_a, event) => this._onCapturedEvent(event), this);

        // Best-effort input grab so keystrokes reach the entry. Never required
        // for closing, and never left dangling.
        try {
            this._grab = Main.pushModal(this._backdrop,
                {actionMode: Shell.ActionMode.NORMAL});
        } catch (e) {
            logError(e, 'RaccoonLauncher: pushModal failed; running without grab');
            this._grab = null;
        }

        // Focus the entry AFTER the grab: pushModal moves key focus to the
        // backdrop, so focusing earlier would be undone.
        this._entry.grab_key_focus();
        this._onOpenChanged?.(true);
    }

    close() {
        if (!this._isOpen)
            return;
        this._isOpen = false;

        this._cancelSearch();
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        global.stage.disconnectObject(this);
        this._backdrop.hide();
        this._resultsBox.destroy_all_children();
        this._results = [];
        this._selected = -1;
        this._onOpenChanged?.(false);
    }

    _onBackdropPress(event) {
        const [bx, by] = this.get_transformed_position();
        const [bw, bh] = this.get_transformed_size();
        // Not laid out yet: ignore so we don't close on the opening click.
        if (bw === 0 || bh === 0)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        const inside = x >= bx && x < bx + bw && y >= by && y < by + bh;
        if (inside)
            return Clutter.EVENT_PROPAGATE;
        this.close();
        return Clutter.EVENT_STOP;
    }

    _onCapturedEvent(event) {
        if (event.type() === Clutter.EventType.KEY_PRESS &&
            event.get_key_symbol() === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // --- searching ---------------------------------------------------------

    _cancelSearch() {
        this._generation++;
        if (this._debounceId) {
            GLib.source_remove(this._debounceId);
            this._debounceId = 0;
        }
        this._cancellable?.cancel();
        this._cancellable = null;
    }

    _refreshIfOpen() {
        if (this._isOpen)
            this._onTextChanged();
    }

    _onTextChanged() {
        this._cancelSearch();
        const generation = this._generation;
        const raw = this._entry.get_text();
        const {mode, text} = parseQuery(raw);
        this._setMode(mode);

        if (mode !== Mode.DEFAULT && !this._engine.isModeEnabled(mode)) {
            this._renderResults([]);
            this._setHint(DISABLED_HINTS[mode], 'disabled');
            return;
        }

        if (mode === Mode.AI) {
            this._setHint(text
                ? 'Press Enter to open a new Temporary Chat in Firefox and send this question.'
                : 'Type your question. Nothing is sent until you press Enter.');
        } else if (FS_MODES.has(mode)) {
            // Clear immediately so Enter can never open a match of an older
            // query while the new search is pending.
            this._renderResults([]);
            if (!text) {
                this._setHint(EMPTY_HINTS[mode]);
                return;
            }
            this._setHint('Searching…', 'loading');
        } else {
            this._setHint(null);
        }

        const run = () => {
            const cancellable = new Gio.Cancellable();
            this._cancellable = cancellable;
            this._engine.query(raw, cancellable).then(results => {
                if (generation !== this._generation || this._destroyed || !this._isOpen)
                    return;
                this._cancellable = null;
                this._renderResults(results);
                if (FS_MODES.has(mode))
                    this._setFilesHint(mode, text, results);
            }).catch(e => {
                if (generation !== this._generation || this._destroyed || !this._isOpen)
                    return;
                this._cancellable = null;
                if (isCancelled(e))
                    return;
                logError(e, 'RaccoonLauncher: search failed');
                this._renderResults([]);
                this._setHint(`Search failed: ${e.message}`, 'error');
            });
        };

        if (FS_MODES.has(mode)) {
            this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                FILE_SEARCH_DEBOUNCE_MS, () => {
                    this._debounceId = 0;
                    run();
                    return GLib.SOURCE_REMOVE;
                });
        } else {
            run();
        }
    }

    _setFilesHint(mode, text, results) {
        const noun = mode === Mode.FOLDERS ? 'folders' : 'files';
        if (results.length === 0) {
            this._setHint(results.incomplete
                ? `No ${noun} named like “${text}” found before the search limit was reached.`
                : `No ${noun} named like “${text}” in your home folder.`);
        } else if (results.incomplete) {
            this._setHint('Best matches so far; the search stopped at its size/time limit.');
        } else {
            this._setHint(null);
        }
    }

    _setMode(mode) {
        if (mode === this._mode)
            return;
        if (this._mode !== Mode.DEFAULT)
            this.remove_style_class_name(`raccoon-mode-${this._mode}`);
        this._mode = mode;
        if (mode !== Mode.DEFAULT)
            this.add_style_class_name(`raccoon-mode-${mode}`);
        this._modeBadge.text = MODE_BADGES[mode] ?? '';
        this._modeBadge.visible = mode !== Mode.DEFAULT;
    }

    _setHint(text, kind = null) {
        for (const k of ['error', 'loading', 'disabled', 'success'])
            this._hint.remove_style_class_name(k);
        if (kind)
            this._hint.add_style_class_name(kind);
        this._hint.text = text ?? '';
        this._hint.visible = !!text;
    }

    // --- keyboard & results ------------------------------------------------

    _onKeyPress(event) {
        const symbol = event.get_key_symbol();

        // Ctrl+Shift+C copies the selected file/folder for pasting in Files.
        // Ctrl+C (no Shift) is left to the entry's own text copy. The event
        // is consumed only when a copyable result was actually handled.
        const state = event.get_state();
        if ((symbol === Clutter.KEY_C || symbol === Clutter.KEY_c) &&
            (state & Clutter.ModifierType.CONTROL_MASK) &&
            (state & Clutter.ModifierType.SHIFT_MASK)) {
            return this._copyResult(this._selected)
                ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        }

        switch (symbol) {
        case Clutter.KEY_Escape:
            this.close();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Down:
            this._move(1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Up:
            this._move(-1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
            this._activate(this._selected);
            return Clutter.EVENT_STOP;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    _move(delta) {
        const n = this._results.length;
        if (n === 0)
            return;
        this._selected = (this._selected + delta + n) % n;
        this._updateSelection();
        const row = this._resultsBox.get_child_at_index(this._selected);
        if (row)
            ensureActorVisibleInScrollView(this._scroll, row);
    }

    _renderResults(results) {
        this._resultsBox.destroy_all_children();
        this._results = results;
        this._selected = results.length > 0 ? 0 : -1;
        this._scroll.vadjustment.value = 0;

        results.forEach((result, index) => {
            const content = this._buildResultContent(result);
            let row;
            if (result.canCopy && result.uri) {
                // Filesystem results: one outer row (selection styling, index
                // lookup, scrolling) holding two sibling buttons, so the Copy
                // button is never nested inside the open button.
                row = new St.BoxLayout({
                    style_class: 'raccoon-result raccoon-result-row',
                    x_expand: true,
                    reactive: true,
                    track_hover: true,
                });
                const main = new St.Button({
                    style_class: 'raccoon-result-main',
                    x_expand: true,
                    can_focus: false,
                    child: content,
                });
                main.connect('clicked', () => this._activate(index));
                row.add_child(main);

                const copy = new St.Button({
                    style_class: 'raccoon-copy-button',
                    can_focus: false,
                    y_align: Clutter.ActorAlign.CENTER,
                    accessible_name: `Copy \u201c${result.name}\u201d to paste in Files`,
                    child: new St.Icon({
                        icon_name: 'edit-copy-symbolic',
                        style_class: 'raccoon-copy-icon',
                    }),
                });
                copy.connect('clicked', () => this._copyResult(index));
                row.add_child(copy);
            } else {
                row = new St.Button({
                    style_class: 'raccoon-result',
                    x_expand: true,
                    can_focus: false,
                    child: content,
                });
                row.connect('clicked', () => this._activate(index));
            }
            this._resultsBox.add_child(row);
        });

        this._updateSelection();
    }

    _buildResultContent(result) {
        const box = new St.BoxLayout({style_class: 'raccoon-result-box', x_expand: true});

        const icon = result.gicon
            ? new St.Icon({
                gicon: result.gicon,
                fallback_icon_name: result.iconName || 'application-x-executable-symbolic',
                style_class: 'raccoon-result-icon',
            })
            : new St.Icon({
                icon_name: result.iconName || 'application-x-executable-symbolic',
                style_class: 'raccoon-result-icon',
            });
        box.add_child(icon);

        const textBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        textBox.add_child(new St.Label({
            text: result.name,
            style_class: 'raccoon-result-name',
        }));
        if (result.description) {
            textBox.add_child(new St.Label({
                text: result.description,
                style_class: 'raccoon-result-desc',
            }));
        }
        box.add_child(textBox);
        return box;
    }

    _updateSelection() {
        const rows = this._resultsBox.get_children();
        rows.forEach((row, index) => {
            if (index === this._selected)
                row.add_style_class_name('selected');
            else
                row.remove_style_class_name('selected');
        });
    }

    _activate(index) {
        // Only an open launcher activates, and closing happens first: this
        // makes a second Enter / click (or the entry's own 'activate' signal)
        // a no-op, so each Enter activates at most one result exactly once.
        if (!this._isOpen)
            return;
        const result = this._results[index];
        if (!result)
            return;
        this.close();

        let ret;
        try {
            ret = result.activate();
        } catch (e) {
            this._reportActivationError(result, e);
            return;
        }
        if (typeof ret?.then === 'function')
            ret.catch(e => this._reportActivationError(result, e));
    }

    /**
     * Copy a filesystem result to the clipboard as a file for GNOME Files.
     * Never opens it, keeps the launcher open, writes the clipboard once.
     *
     * @param {number} index - result index
     * @returns {boolean} whether a copyable result was handled
     */
    _copyResult(index) {
        if (!this._isOpen || this._destroyed)
            return false;
        const result = this._results[index];
        if (!result?.canCopy || !result.uri)
            return false;

        this._selected = index;
        this._updateSelection();
        try {
            copyFileUri(St.Clipboard.get_default(), St.ClipboardType.CLIPBOARD, result.uri);
        } catch (e) {
            logError(e, `RaccoonLauncher: failed to copy "${result.name}"`);
            this._setHint(`Could not copy \u201c${result.name}\u201d: ${e.message}`, 'error');
            return true;
        }
        this._setHint(`Copied \u201c${result.name}\u201d \u2014 paste in Files.`, 'success');
        return true;
    }

    _reportActivationError(result, e) {
        if (isCancelled(e))
            return;
        logError(e, `RaccoonLauncher: failed to activate "${result.name}"`);
        // The overlay is already closed, so report through a notification.
        Main.notifyError('Raccoon Launcher', e.message || String(e));
    }

    destroy() {
        // Take the backdrop off the stage before anything else: closing,
        // popping the grab and detaching the box all queue relayouts, and a
        // relayout queued for an on-stage actor that is then destroyed makes
        // Clutter allocate an actor that is no longer in the stage.
        this._backdrop?.get_parent()?.remove_child(this._backdrop);

        this._destroyed = true;
        this._cancelSearch();
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        if (this._isOpen) {
            this._isOpen = false;
            this._onOpenChanged?.(false);
        }
        this._onOpenChanged = null;
        global.stage.disconnectObject(this);
        this._settings.disconnectObject(this);
        if (this._backdrop) {
            this._backdrop.remove_child(this);
            this._backdrop.destroy();
            this._backdrop = null;
        }
        super.destroy();
    }
});
