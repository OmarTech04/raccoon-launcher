import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {SearchEngine} from './lib/search.js';
import {LauncherOverlay} from './lib/overlay.js';
import {BrowserLauncher} from './lib/browser.js';
import {AiWindowController} from './lib/aiWindow.js';
import {createShellEnv} from './lib/shellEnv.js';
import {AppsProvider} from './lib/providers/apps.js';
import {CalcProvider} from './lib/providers/calc.js';
import {WebProvider} from './lib/providers/web.js';
import {SystemProvider} from './lib/providers/system.js';
import {AiProvider} from './lib/providers/ai.js';
import {FilesProvider} from './lib/providers/files.js';

const TOGGLE_KEY = 'toggle-launcher';

export default class RaccoonLauncherExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        const env = createShellEnv();
        this._browser = new BrowserLauncher(env);
        this._aiWindow = new AiWindowController({...env, browser: this._browser});
        // Web searches must never land in the launcher-managed AI window.
        this._browser.isManagedWindow = w => this._aiWindow?.isManagedWindow(w) ?? false;

        this._engine = new SearchEngine(this._settings, {
            defaultProviders: [
                {key: 'enable-calc', provider: new CalcProvider()},
                {key: 'enable-web', provider: new WebProvider(this._browser)},
                {key: 'enable-system', provider: new SystemProvider()},
                {key: 'enable-apps', provider: new AppsProvider()},
            ],
            aiProvider: new AiProvider(this._aiWindow),
            filesProvider: new FilesProvider(),
        });

        this._overlay = new LauncherOverlay(
            this._engine,
            this._settings,
            () => this.openPreferences(),
            {onOpenChanged: open => this._aiWindow?.setSuspended(open)});

        Main.wm.addKeybinding(
            TOGGLE_KEY,
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._overlay.toggle()
        );
    }

    disable() {
        // disable() must tear down everything we created in enable().
        Main.wm.removeKeybinding(TOGGLE_KEY);

        this._overlay?.destroy();
        this._overlay = null;

        this._engine?.destroy();
        this._engine = null;

        // Cancels any pending launch, timers, signal handlers and the Escape
        // grab. The AI window itself stays open (disable also runs when the
        // screen locks) and the shared Firefox process is never touched.
        this._aiWindow?.destroy();
        this._aiWindow = null;
        this._browser = null;

        this._settings = null;
    }
}
