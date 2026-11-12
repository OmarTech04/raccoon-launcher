import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// GNOME Shell glue for BrowserLauncher and AiWindowController. Kept separate
// so those modules can be unit-tested outside GNOME Shell with fakes.
// Called from enable(); nothing here runs at import time.
export function createShellEnv() {
    const tracker = Shell.WindowTracker.get_default();
    const appIdForWindow = w => tracker.get_window_app(w)?.get_id() ?? null;

    return {
        display: global.display,
        appIdForWindow,

        getDefaultHandler: () => Gio.AppInfo.get_default_for_uri_scheme('https'),
        findApp: id => Gio.AppInfo.get_all().find(a => a.get_id() === id) ?? null,
        spawn: argv => {
            const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
            launcher.set_cwd(GLib.get_home_dir());
            // Not waited on or killed: if Firefox was not running, this
            // process *is* the user's browser and must outlive the extension.
            launcher.spawnv(argv);
        },
        launchDefault: url => Gio.AppInfo.launch_default_for_uri(url, null),
        listAppWindows: appId => global.display
            .get_tab_list(Meta.TabList.NORMAL_ALL, null)
            .filter(w => appIdForWindow(w) === appId),
        activateWindow: w => Main.activateWindow(w),

        getCurrentMonitor: () => global.display.get_current_monitor(),
        getWorkArea: index => Main.layoutManager.getWorkAreaForMonitor(index),
        createKeyboard: () => global.stage.context.get_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE),
        allowKeybinding: (name, allowed) => Main.wm.allowKeybinding(name,
            allowed ? Shell.ActionMode.NORMAL : Shell.ActionMode.NONE),
        getIdleTime: () => global.backend.get_core_idle_monitor().get_idletime(),

        now: () => GLib.get_monotonic_time() / 1000,
        // A real server timestamp: get_current_time() is 0 outside an event,
        // which makes Mutter skip its ping when asking a window to close.
        currentTime: () => global.display.get_current_time_roundtrip(),
        timeout: (ms, fn) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            fn();
            return GLib.SOURCE_REMOVE;
        }),
        clearTimeout: id => GLib.source_remove(id),
    };
}
