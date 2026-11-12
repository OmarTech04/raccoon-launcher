UUID      = raccoonlauncher@shimafallah.github.io
DATA_HOME = $(or $(XDG_DATA_HOME),$(HOME)/.local/share)
EXT_DIR   = $(DATA_HOME)/gnome-shell/extensions/$(UUID)

.PHONY: schemas install uninstall pack check lint unit test test-firefox nested

# Compile the GSettings schema (needed before the extension can load).
schemas:
	glib-compile-schemas --strict schemas/

# Copy the runtime files into the local extensions directory
# ($XDG_DATA_HOME, falling back to ~/.local/share).
install:
	./tools/install.sh "$(EXT_DIR)"
	@echo "Installed to $(EXT_DIR)"
	@echo "Enable with: gnome-extensions enable $(UUID)"
	@echo "On Wayland, log out and back in first so GNOME Shell discovers it."

uninstall:
	rm -rf "$(EXT_DIR)"
	@echo "Removed $(EXT_DIR)"

# Build the installable zip (all of lib/, including providers).
pack: schemas
	gnome-extensions pack --force --extra-source=lib .
	@echo "Created $(UUID).shell-extension.zip"

# Schema validation, ES-module syntax, unit tests and zip contents.
check:
	./tools/check.sh all

# ES-module syntax / import-resolution check only.
lint:
	./tools/check.sh syntax

# Unit tests only (plain gjs, no GNOME Shell).
unit:
	./tools/check.sh unit

# Launch a nested GNOME Shell for manual testing (GNOME 49+ uses --devkit;
# needs the mutter-devkit viewer installed). For automated checks use 'make test'.
nested:
	dbus-run-session -- gnome-shell --devkit

# Load the real extension in a private headless shell and drive it.
test:
	./tools/smoketest.sh

# As above, plus real Firefox (disposable profile, local stand-in pages).
test-firefox:
	./tools/smoketest.sh --firefox
