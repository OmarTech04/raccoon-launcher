// Syntax / import-resolution check for the extension's ES modules, run with
// plain `gjs -m` (outside GNOME Shell).
//
// Each file is loaded with a dynamic import(). Modules are parsed before any
// dependency is linked, so a SyntaxError is always reported. GNOME Shell's
// own resource:/// modules do not exist outside the shell; failing to link
// one of those is expected and means the file itself parsed. Anything else
// (syntax errors, a missing local file) is a failure.
//
// Usage: gjs -m tools/syntaxcheck.js FILE...
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

const SHELL_RESOURCE = /resource:\/\/\/org\/gnome\/(shell|Shell)\//;

const files = ARGV;
const loop = new GLib.MainLoop(null, false);
let failed = 0;

async function main() {
    for (const path of files) {
        const uri = Gio.File.new_for_commandline_arg(path).get_uri();
        try {
            // eslint-disable-next-line no-await-in-loop
            await import(uri);
            print(`ok        ${path}`);
        } catch (e) {
            if (!(e instanceof SyntaxError) && SHELL_RESOURCE.test(String(e))) {
                print(`ok        ${path} (needs GNOME Shell at runtime)`);
            } else {
                failed++;
                print(`FAIL      ${path}\n          ${e}`);
            }
        }
    }
}

main().finally(() => loop.quit());
loop.run();
System.exit(failed ? 1 : 0);
