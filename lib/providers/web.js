// Keyword-triggered web searches. Type a prefix, a space, then your query.
export const ENGINES = {
    g: {name: 'Google', url: 'https://www.google.com/search?q='},
    ddg: {name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q='},
    yt: {name: 'YouTube', url: 'https://www.youtube.com/results?search_query='},
    wiki: {name: 'Wikipedia', url: 'https://en.wikipedia.org/w/index.php?search='},
    gh: {name: 'GitHub', url: 'https://github.com/search?q='},
};

export class WebProvider {
    /** @param {{openSearch: Function}} browser - a BrowserLauncher */
    constructor(browser) {
        this._browser = browser;
    }

    query(text) {
        const spaceIdx = text.indexOf(' ');
        if (spaceIdx === -1)
            return [];

        const key = text.slice(0, spaceIdx).toLowerCase();
        const term = text.slice(spaceIdx + 1).trim();
        const engine = ENGINES[key];
        if (!engine || !term)
            return [];

        const url = engine.url + encodeURIComponent(term);
        return [{
            id: `web-${key}`,
            name: `Search ${engine.name} for “${term}”`,
            description: url,
            iconName: 'web-browser-symbolic',
            score: 1500,
            activate: () => {
                this._browser.openSearch(url);
            },
        }];
    }

    destroy() {
        this._browser = null;
    }
}
