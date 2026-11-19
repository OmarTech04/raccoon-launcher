import Gio from 'gi://Gio';

import {Mode, parseQuery} from './query.js';

const MODE_SETTINGS = {
    [Mode.AI]: 'enable-ai',
    [Mode.FILES]: 'enable-files',
    [Mode.FOLDERS]: 'enable-folders',
};

function throwIfCancelled(cancellable) {
    if (cancellable?.is_cancelled()) {
        throw new Gio.IOErrorEnum({
            code: Gio.IOErrorEnum.CANCELLED,
            message: 'Search cancelled',
        });
    }
}

// Routes a query to the providers for its mode and returns the ranked results
// (highest score first), limited to the configured maximum.
//
// query() is asynchronous: default-mode providers are synchronous and are
// simply wrapped, while file search runs asynchronously and is cancellable.
// Explicit AI / file modes never merge results from unrelated providers.
export class SearchEngine {
    /**
     * @param {Gio.Settings} settings - extension settings
     * @param {object} providers - injected providers
     * @param {Array<{key: string, provider: object}>} providers.defaultProviders
     *   providers queried in default mode, each gated by a boolean setting
     * @param {object} [providers.aiProvider] - provider for "c " mode
     * @param {object} [providers.filesProvider] - provider for "ff " mode
     */
    constructor(settings, {defaultProviders = [], aiProvider = null, filesProvider = null} = {}) {
        this._settings = settings;
        this._providers = defaultProviders;
        this._aiProvider = aiProvider;
        this._filesProvider = filesProvider;
    }

    get filesProvider() {
        return this._filesProvider;
    }

    isModeEnabled(mode) {
        if (mode === Mode.AI)
            return !!this._aiProvider && this._settings.get_boolean(MODE_SETTINGS[mode]);
        if (mode === Mode.FILES || mode === Mode.FOLDERS)
            return !!this._filesProvider && this._settings.get_boolean(MODE_SETTINGS[mode]);
        return true;
    }

    /**
     * @param {string} rawText - the untrimmed entry text
     * @param {Gio.Cancellable} [cancellable] - cancels file search
     * @returns {Promise<object[]>} ranked results; a file-search result array
     *   may carry `incomplete = true` when the traversal hit its limits
     */
    async query(rawText, cancellable = null) {
        const {mode, text} = parseQuery(rawText);
        const limit = this._settings.get_int('max-results');

        if (!text || !this.isModeEnabled(mode))
            return [];

        if (mode === Mode.AI)
            return this._aiProvider.query(text).slice(0, limit);

        if (mode === Mode.FILES)
            return this._filesProvider.query(text, {cancellable, limit});

        if (mode === Mode.FOLDERS)
            return this._filesProvider.query(text, {cancellable, limit, directoriesOnly: true});

        const results = [];
        for (const {key, provider} of this._providers) {
            if (!this._settings.get_boolean(key))
                continue;
            try {
                // eslint-disable-next-line no-await-in-loop
                results.push(...await provider.query(text));
            } catch (e) {
                logError(e, `RaccoonLauncher: provider "${key}" failed`);
            }
        }
        throwIfCancelled(cancellable);

        results.sort((a, b) => b.score - a.score);
        return results.slice(0, limit);
    }

    destroy() {
        for (const {provider} of this._providers)
            provider.destroy?.();
        this._filesProvider?.destroy?.();
        this._aiProvider?.destroy?.();
        this._providers = [];
        this._filesProvider = null;
        this._aiProvider = null;
    }
}
