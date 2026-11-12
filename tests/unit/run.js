// Unit tests that run in plain GJS (no GNOME Shell). See tools/check.sh for
// the required GI_TYPELIB_PATH (Mutter's Meta/Clutter typelibs).
import System from 'system';

import {run, runMain} from './harness.js';
import './testQuerySearch.js';
import './testBrowser.js';
import './testAiWindow.js';
import {tearDown} from './testFiles.js';

const failed = runMain(async () => {
    try {
        return await run();
    } finally {
        tearDown();
    }
});

System.exit(failed ? 1 : 0);
