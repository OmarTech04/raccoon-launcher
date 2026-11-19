# Raccoon Launcher

A keyboard-driven launcher for GNOME Shell, with a development focus on fast
application search, web search, file search, and quick access to an AI
assistant.

This fork targets **Fedora 45 Workstation, GNOME 51, and Wayland**. The
GNOME 51 port is done and has been exercised in a headless GNOME Shell 51.1
(see [Testing](#testing)); it has not yet been run in a logged-in Fedora 45
desktop session. `metadata.json` still lists GNOME 48–50 from upstream; those
versions have **not** been retested after these changes.
KDE Plasma is outside the current scope.

Default shortcut: <kbd>Ctrl</kbd>+<kbd>Space</kbd> (configurable in preferences).

## Features

| Type | Does | Status |
|---|---|---|
| `firefox`, `files`, … | Fuzzy search and launch installed applications | Tested (headless GNOME 51) |
| `(12+3)*4^2` | Calculator; Enter copies the result | Tested (headless GNOME 51) |
| `g`, `ddg`, `yt`, `wiki`, `gh` + query | Web search in the default browser | See below |
| `lock`, `log out`, `suspend`, `restart`, `power off` | System actions (GNOME's own confirmation dialogs) | Offered results tested; actions not triggered in tests |
| `ff <name>` | Filename search in your home folder | Tested (headless GNOME 51 + unit tests) |
| `/<name>` | Folder-name search in your home folder | Tested (headless GNOME 51 + unit tests) |
| Copy button / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> on a file or folder result | Copy the item to paste in GNOME Files | Tested, including a real paste in GNOME Files 51 in the headless sandbox |
| `c <question>` | ChatGPT Temporary Chat in Firefox | **Incomplete — not yet verified end-to-end** |

Preferences: shortcut, box color, per-provider toggles (including AI mode,
file search and folder search), and the maximum number of results.

### Web search (`g <query>`, …)

The query is percent-encoded into the URL; nothing is passed through a shell.

- If the default browser is **not** Firefox, the URL goes to the default
  handler exactly as before.
- If it **is** Firefox, the launcher runs Firefox's own desktop-entry command
  with `--new-tab <url>` (an argument list, no shell). With Firefox running,
  this hands the URL to the running instance — same default profile, same
  session — and Firefox opens it in its most recently used window. To keep
  searches out of the launcher-managed AI window, the most recently used
  *normal* Firefox window is activated first. If only the AI window exists, a
  new window is used instead. If Firefox is closed, it starts normally.

Verified: `firefox --new-window` from outside reaches the already running
instance with the signed-in default profile (real Fedora 45 session), and in
the headless Firefox test a search opened while the AI window was focused
landed in the normal window. Not yet observed in the real session.

### File search (`ff <name>`)

- `ff` alone is an ordinary search; `ff ` (with the space) switches to file
  mode immediately. An empty `ff ` shows guidance instead of listing files.
- Matches file and folder **names** (not contents) below `$HOME`. Every word
  of the query must appear in the name; exact and prefix matches rank first,
  then shallower paths. Unicode names are matched after NFC normalization, so
  Arabic and accented names work.
- Hidden files and folders (dot-names and `.hidden`) are skipped. Symbolic
  links are listed but never followed, so the search cannot leave `$HOME` or
  loop; unreadable folders are skipped without failing the search.
- Results show the name and its folder; Enter opens the item with its default
  application. `max-results` is respected, and only the best matches are kept
  while searching.
- The search is asynchronous (Gio, a few folders at a time), debounced while
  you type, cancelled when the text changes or the launcher closes, and capped
  at 400 000 entries / 8 seconds; when a cap is hit the launcher says so.

### Folder search (`/<name>`)

- A leading `/` switches to folder mode immediately — no space needed. `/`
  alone shows guidance and searches nothing; `/projects` and `/ projects`
  both look for folders whose names contain "projects".
- `/` is a mode prefix, not a path: only the first slash is removed, and
  absolute paths are not browsed. A slash inside another mode stays part of
  the query (`c /projects` asks ChatGPT about "/projects"; `ff /projects`
  is a file search).
- Uses the same search as `ff` (names, all words, ranking, Unicode/Arabic,
  `max-results`, debounce, cancellation and limits) but returns **only real
  folders**: files, symbolic links, hidden folders and anything inside them
  are excluded. Matching files never take up result slots, and folders nested
  below non-matching ones are found.
- Results show the folder name, its parent path and a folder icon; Enter
  opens the folder in the default file manager.
- Has its own switch in preferences ("Folder search", on by default),
  independent of file search. When it is off, `/` shows that it is disabled
  instead of falling back to other results.

### Copying files and folders for GNOME Files

File and folder results (`ff` and `/`) have a **Copy** button on the right,
and <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> copies the selected one.
This copies the item itself — paste it in GNOME Files (<kbd>Ctrl</kbd>+<kbd>V</kbd>)
to get a copy there. It does not copy the path as text or the contents, and
nothing is created until you paste.

- The launcher stays open and shows "Copied “name” — paste in Files."
  Copying never opens the item; Enter or clicking the result still opens it.
- Other results (apps, calculator, web, AI, system) have no Copy action, and
  <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> does nothing for them. Plain
  <kbd>Ctrl</kbd>+<kbd>C</kbd> / <kbd>Ctrl</kbd>+<kbd>V</kbd> still copy and
  paste text in the search box.
- The clipboard gets one entry: MIME type `x-special/gnome-copied-files` with
  `copy\n<file URI>`, the format GNOME Files uses itself. The file's own
  percent-encoded URI is used as-is, so spaces, Arabic and punctuation in
  names are preserved. It stays on the clipboard after the launcher closes.
- Folders are copied the same way (GNOME Files copies the whole folder).
- Only GNOME Files' format is offered. Other file managers or apps that
  expect `text/uri-list` may not accept the paste.

### AI mode (`c <question>`) — incomplete

`c` alone is an ordinary search; `c ` switches to AI mode immediately and
shows what Enter will do. Nothing opens or is sent while typing.

On Enter the launcher closes, then:

1. Asks the running Firefox (existing default profile) for a new window at
   `https://chatgpt.com/?temporary-chat=true&q=<question>`.
2. Identifies that window: it must be a normal Firefox window created after
   the request, absent before it, and the only one to appear within a short
   interval. Otherwise (timeout, two candidates) nothing is touched or sent.
3. Centres it at about 900 × 650 logical pixels on the current monitor,
   constrained to the work area, and focuses it.
4. Closes the previous launcher-managed AI window (only that one).
5. When the page title shows ChatGPT has loaded, presses Return once through
   a compositor virtual keyboard — only if that window has focus. Return is
   retried a bounded number of times only while the window stays focused and
   you have not used the keyboard or mouse since.
6. While that window is focused, Escape closes it (and only it).

No Firefox extension, remote debugging, private window, separate profile,
cookie access or API key is used. Disabling the extension (which also happens
on screen lock) cancels pending work but leaves the window open.

What has been verified, and what has not:

- **Verified in the real session:** a new window opens in the running Firefox
  with the signed-in profile; `?temporary-chat=true` opens a Temporary Chat;
  `q=` **prefills the composer but does not submit it**. Submission therefore
  depends on step 5.
- **Verified in a headless GNOME Shell 51 compositor with real Firefox 159**
  (disposable profile, a local stand-in page that mimics the observed
  ChatGPT behaviour; `make test-firefox`): window identification, 900 × 650
  centring, focus, the injected Return submitting the prefilled prompt
  exactly once (Arabic, spaces and `& = # + "` intact), web search landing in
  the normal window while the AI window is open, Escape closing only the AI
  window, replacement closing only the previous AI window, and disable
  leaving the window open with no Escape grab behind.
- **Not yet verified in the real session:** the same steps against the real
  ChatGPT page with your signed-in profile — in particular that Return
  submits in real ChatGPT and that the page title reliably indicates when it
  has loaded. Until that is observed, AI mode stays marked incomplete.

## Install from source

Needs `glib-compile-schemas` and `gnome-extensions` (GNOME Shell / GLib
packages). `make` is optional; every target is a thin wrapper around a script
in `tools/`.

```bash
make install            # or: ./tools/install.sh "${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/raccoonlauncher@shimafallah.github.io"
```

On Wayland, log out and back in so GNOME Shell discovers the new extension,
then enable it:

```bash
gnome-extensions enable raccoonlauncher@shimafallah.github.io
```

Restarting Shell with `Alt`+`F2` → `r` is not available on Wayland.

Watch logs while testing:

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

## Testing

```bash
make check              # ./tools/check.sh: schema, ES-module syntax, unit tests, zip contents
make test               # ./tools/smoketest.sh: real extension in a private headless GNOME Shell
make test-firefox       # ./tools/smoketest.sh --firefox: adds real Firefox (disposable profile)
```

Run parts only:

```bash
./tools/check.sh unit files clipboard          # unit-test modules (query, browser, ai, files, clipboard) or name substrings
./tools/smoketest.sh --only=folders,copy       # shell scenario groups: overlay, folders, copy, lifecycle
./tools/smoketest.sh --only=paste              # opt-in: copy a file and paste it in GNOME Files (nautilus) in the sandbox
```

- `tools/check.sh` runs outside GNOME Shell with plain `gjs`. The syntax check
  imports each ES module and fails on syntax errors or missing local imports;
  GNOME Shell's own `resource:///` modules are expected to be unavailable
  there. Unit tests (`tests/unit/`) cover mode parsing, the async search
  engine, web URLs and argument vectors, the file provider (on a temporary
  fixture directory), and the AI window controller (with fakes). They need
  Mutter's typelibs, which the script finds under `/usr/lib*/mutter-*`.
- `tools/smoketest.sh` installs the real extension plus a test-only driver
  extension (`tests/shell/driver`) into a sandbox with its own `HOME`, XDG
  directories and D-Bus session, starts `gnome-shell --headless`, and drives
  the launcher with virtual keyboard/pointer devices: modes, Enter/Escape,
  outside click, file and folder search, the Copy button and
  <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> with clipboard readback,
  disable → re-enable. System actions are looked up, never triggered. The
  sandbox shell has its own clipboard, so your clipboard is not touched. On
  failure the sandbox and shell log are kept.
- `--only=paste` starts GNOME Files inside the sandbox, copies a temporary
  file through the launcher, pastes it with <kbd>Ctrl</kbd>+<kbd>V</kbd> into
  a temporary folder, and checks the copy's contents and that the original is
  untouched. This has passed with Nautilus 51.1; pasting has not been
  observed in a logged-in desktop session.
- `--firefox` additionally starts Firefox inside the headless compositor with
  a throwaway profile and local stand-in pages (`tests/shell/pages`). It never
  contacts ChatGPT or uses your profile.

Development dependencies: `gjs`, `gnome-shell`, `mutter` typelibs,
`dbus-run-session`, `unzip`, Firefox for `test-firefox`, and `nautilus` for
`--only=paste`.

## Preferences

```bash
gnome-extensions prefs raccoonlauncher@shimafallah.github.io
```

## Packaging

```bash
make pack          # produces raccoonlauncher@shimafallah.github.io.shell-extension.zip
```

## Project layout

```
metadata.json                 extension metadata + supported shell versions
extension.js                  enable()/disable(): builds controllers, registers the hotkey
prefs.js                      GTK4/libadwaita preferences window
stylesheet.css                overlay styling
schemas/                      GSettings schema (shortcut, color, toggles, limits)
lib/
  overlay.js                  the search overlay UI (modes, async results)
  query.js                    parseQuery(): default / "c " / "ff " / "/" modes
  search.js                   async dispatcher: queries providers, ranks results
  browser.js                  default-browser handling, Firefox launch arguments
  aiWindow.js                 managed AI window: identify, place, submit, Escape
  shellEnv.js                 GNOME Shell glue for browser.js / aiWindow.js
  fileClipboard.js            copy a file URI in GNOME Files' clipboard format
  util.js                     fuzzy matcher
  providers/
    apps.js  calc.js  web.js  system.js  ai.js  files.js
tests/unit/                   plain-gjs unit tests
tests/shell/                  headless-shell driver extension and stand-in pages
tools/                        install, check, syntax check, smoke test
```

## License

GPL-2.0-or-later
