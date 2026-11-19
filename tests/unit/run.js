// Unit tests that run in plain GJS (no GNOME Shell). See tools/check.sh for
// the required GI_TYPELIB_PATH (Mutter's Meta/Clutter typelibs).
//
// Usage: gjs -m tests/unit/run.js [FILTER...]
// With no filters every test runs. A filter selects a module (query, browser,
// ai, files, clipboard) or any test whose name contains it.
import System from 'system';

import {run, runMain} from './harness.js';
import './testQuerySearch.js';
import './testBrowser.js';
import './testAiWindow.js';
import './testClipboard.js';
import {tearDown} from './testFiles.js';

const failed = runMain(async () => {
    try {
        return await run(ARGV);
    } finally {
        tearDown();
    }
});

System.exit(failed ? 1 : 0);
