import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {fuzzyScore} from '../util.js';

Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async');

const ATTRIBUTES = [
    'standard::name',
    'standard::display-name',
    'standard::type',
    'standard::is-hidden',
    'standard::fast-content-type',
    'id::file',
].join(',');

const DEFAULTS = {
    concurrency: 4,       // directories enumerated in parallel
    batchSize: 128,       // entries per next_files_async() call
    maxDepth: 32,         // directory nesting below the root
    maxEntries: 400000,   // entries inspected before giving up
    timeBudgetMs: 8000,   // wall-clock budget for one search
};

function cancelledError() {
    return new Gio.IOErrorEnum({
        code: Gio.IOErrorEnum.CANCELLED,
        message: 'File search cancelled',
    });
}

function normalize(s) {
    return s.normalize('NFC').toLowerCase();
}

// Filename search below a root directory (the home directory by default).
//
// The traversal is fully asynchronous (Gio enumeration in GIO's worker
// threads, a bounded number of directories in flight), never follows
// symbolic links, skips hidden entries and unreadable directories, and keeps
// only the best `limit` matches instead of accumulating every hit.
export class FilesProvider {
    /**
     * @param {object} [params] - options
     * @param {Gio.File} [params.root] - directory to search (default: home)
     * @param {Function} [params.launchUri] - opens a URI; defaults to
     *   Gio.AppInfo.launch_default_for_uri
     * @param {object} [params.limits] - overrides for DEFAULTS
     */
    constructor({root = null, launchUri = null, limits = {}} = {}) {
        this.root = root ?? Gio.File.new_for_path(GLib.get_home_dir());
        this._launchUri = launchUri ??
            (uri => Gio.AppInfo.launch_default_for_uri(uri, null));
        this._limits = {...DEFAULTS, ...limits};
    }

    /**
     * @param {string} text - filename query (already trimmed)
     * @param {object} params - options
     * @param {Gio.Cancellable} [params.cancellable] - aborts the traversal
     * @param {number} params.limit - maximum number of results
     * @returns {Promise<object[]>} results; `incomplete` is set when the
     *   traversal stopped early because of its limits
     */
    async query(text, {cancellable = null, limit = 8} = {}) {
        const terms = normalize(text).split(/\s+/).filter(Boolean);
        if (terms.length === 0)
            return [];

        const state = {
            query: text.normalize('NFC'),
            terms,
            limit,
            matches: [],
            seenDirs: new Set(),
            entries: 0,
            unreadable: 0,
            incomplete: false,
            deadline: GLib.get_monotonic_time() + this._limits.timeBudgetMs * 1000,
            cancellable,
        };

        await this._traverse(state);

        const homePath = GLib.get_home_dir();
        const results = state.matches.map(m => this._toResult(m, homePath));
        results.incomplete = state.incomplete;
        results.unreadable = state.unreadable;
        return results;
    }

    _traverse(state) {
        const queue = [{file: this.root, depth: 0}];
        let running = 0;
        let settled = false;

        return new Promise((resolve, reject) => {
            const pump = () => {
                if (settled)
                    return;
                if (state.cancellable?.is_cancelled()) {
                    settled = true;
                    reject(cancelledError());
                    return;
                }
                if (queue.length > 0 && this._overBudget(state)) {
                    state.incomplete = true;
                    queue.length = 0;
                }
                while (running < this._limits.concurrency && queue.length > 0) {
                    const dir = queue.shift();
                    running++;
                    this._scanDirectory(dir, queue, state)
                        .catch(e => {
                            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                                state.unreadable++;
                        })
                        .finally(() => {
                            running--;
                            pump();
                        });
                }
                if (running === 0 && queue.length === 0) {
                    settled = true;
                    resolve();
                }
            };
            pump();
        });
    }

    _overBudget(state) {
        return state.entries >= this._limits.maxEntries ||
            GLib.get_monotonic_time() > state.deadline;
    }

    async _scanDirectory({file, depth}, queue, state) {
        // NOFOLLOW_SYMLINKS: symlinks are reported as symlinks and never
        // descended into, so the walk cannot leave the root or loop.
        const enumerator = await file.enumerate_children_async(ATTRIBUTES,
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_LOW,
            state.cancellable);

        try {
            for (;;) {
                // eslint-disable-next-line no-await-in-loop
                const infos = await enumerator.next_files_async(
                    this._limits.batchSize, GLib.PRIORITY_LOW, state.cancellable);
                if (infos.length === 0)
                    break;

                for (const info of infos)
                    this._visit(enumerator, info, depth, queue, state);

                if (this._overBudget(state)) {
                    state.incomplete = true;
                    break;
                }
            }
        } finally {
            enumerator.close_async(GLib.PRIORITY_LOW, null).catch(() => {});
        }
    }

    _visit(enumerator, info, depth, queue, state) {
        state.entries++;

        const displayName = info.get_display_name();
        if (displayName.startsWith('.') || info.get_is_hidden())
            return;

        const type = info.get_file_type();
        if (type !== Gio.FileType.REGULAR &&
            type !== Gio.FileType.DIRECTORY &&
            type !== Gio.FileType.SYMBOLIC_LINK)
            return;

        const child = enumerator.get_child(info);

        if (type === Gio.FileType.DIRECTORY && depth < this._limits.maxDepth) {
            // Guard against bind-mount loops: never enter the same inode twice.
            const id = info.get_attribute_string('id::file');
            if (!id || !state.seenDirs.has(id)) {
                if (id)
                    state.seenDirs.add(id);
                queue.push({file: child, depth: depth + 1});
            }
        }

        const name = normalize(displayName);
        if (!state.terms.every(t => name.includes(t)))
            return;

        // Every term is a substring; fuzzyScore ranks exact / prefix /
        // contiguous matches above scattered ones. Shallower paths win ties.
        const score = Math.max(fuzzyScore(state.query, displayName.normalize('NFC')), 100) -
            depth * 2;
        this._retain(state, {
            file: child,
            name: displayName,
            contentType: info.get_attribute_string('standard::fast-content-type'),
            isDirectory: type === Gio.FileType.DIRECTORY,
            score,
        });
    }

    _retain(state, match) {
        const {matches, limit} = state;
        if (matches.length >= limit && match.score <= matches[matches.length - 1].score)
            return;
        let i = matches.length;
        while (i > 0 && matches[i - 1].score < match.score)
            i--;
        matches.splice(i, 0, match);
        if (matches.length > limit)
            matches.pop();
    }

    _toResult(match, homePath) {
        const uri = match.file.get_uri();
        const parent = match.file.get_parent();
        let dirPath = parent ? parent.get_parse_name() : '';
        if (dirPath === homePath)
            dirPath = '~';
        else if (dirPath.startsWith(`${homePath}/`))
            dirPath = `~${dirPath.slice(homePath.length)}`;

        let gicon = null;
        if (match.isDirectory)
            gicon = Gio.ThemedIcon.new('folder');
        else if (match.contentType)
            gicon = Gio.content_type_get_icon(match.contentType);

        return {
            id: `file:${uri}`,
            name: match.name,
            description: dirPath,
            gicon,
            iconName: 'text-x-generic',
            score: match.score,
            uri,
            activate: () => this._launchUri(uri),
        };
    }

    destroy() {
        this._launchUri = null;
    }
}
