# macos-dock: macOS Dock for GNOME Shell

**Project:** Full-featured macOS-style dock for GNOME Shell 50 — not a theme, built from scratch.
**Repo:** `git@github.com:eliasfarah/macos-dock.git` (branch: `main`)
**Language:** GJS (JavaScript on GNOME), GTK4/Adwaita (prefs)
**Author:** eliasfarah (eliasfa@gmail.com)

## Quick Start

```sh
# Setup (one-time)
UUID=macos-dock-stack@eliasfarah.github.io
ln -s "$PWD" ~/.local/share/gnome-shell/extensions/$UUID
glib-compile-schemas schemas/
msgfmt po/pt_BR.po -o locale/pt_BR/LC_MESSAGES/macos-dock-stack.mo

# Test in isolated session
export XDG_CONFIG_HOME=/tmp/dock-test/.config
export XDG_DATA_HOME=$HOME/.local/share
dbus-run-session -- bash -c '
  gsettings set org.gnome.shell enabled-extensions "[\"macos-dock-stack@eliasfarah.github.io\"]"
  gnome-shell --headless --virtual-monitor 1600x900 --debug-control
'

# After changes: restart session, then re-enable
# Wayland: full logout/login (no shell reload)
# X11: Alt+F2 → r (or gnome-extensions disable/enable)
```

## Git Setup

**Local user config only** (not global). The noreply address is required:
```sh
git config user.name eliasfarah
git config user.email eliasfarah@users.noreply.github.com
```
(GitHub rejects pushes using the real privacy-protected email with `GH007`.)

## Architecture

### File Structure
- **extension.js** — Main entry point; connects all managers
- **prefs.js** — GTK4/Adwaita preferences window
- **stylesheet.css** — Two glass palettes (light/dark)
- **schemas/**.gschema.xml — GSettings schema
- **modules/**
  - `appearance.js` — Light/dark/system theme
  - `animations.js` — Spring curve (mass/stiffness/damping) + animation driver
  - `glass.js` — Layered glass: blur, tint, sheen, rim, border
  - `utils.js` — Geometry, folder listing, sorting
  - `settings.js` — GSettings wrapper
  - `stack.js` — Stack lifecycle & StackManager (parks stacks for reuse)
  - `dockManager.js` — Main dock bar: layout, magnification, drag-reorder, autohide
  - `dockAppIcon.js` — App icon (extends AppDisplay.AppIcon)
  - `dockFolderIcon.js` — Folder preview (stacked thumbnails) + progress bar
  - `dockTrashIcon.js` — Trash (full/empty state)
  - `dockShowAppsIcon.js` — App launcher
  - `dockSeparator.js` — Visual separators
  - `minimizeEffect.js` — Genie minimize animation

### Key Design

- **Stack parking:** `Stack` in `modules/stack.js` builds the glass panel once and *parks* it (hidden, not destroyed) between opens for reuse. `StackManager` prunes parked stacks whose folder was removed.
- **Spring physics:** Custom-computed mass/stiffness/damping curve (not Clutter's built-in easing) for faithful macOS motion.
- **Real blur:** `Shell.BlurEffect` for actual background blur (glass panel), not a visual hack.
- **Visual accuracy:** Every measurement (padding, spacing, corner radius, separator height, indicator size/position, glass palettes) measured from real macOS Tahoe captures.

### Feature Set

**Dock:**
- Glass bar with real background blur, light/dark/auto theme following system
- Gaussian magnification around cursor
- Pinned apps + running apps, separated by visual dividers
- Running-app indicator dot
- Drag-to-reorder apps/stacks; drag-outside to unpin
- Auto-hide, icon size, margins, blur intensity — all live
- Trash (full/empty state)

**Stacks:**
- **Fan:** Items float above desktop from the icon, labels on left
- **Grid/List:** Sized glass panel
- Sort: Newest first (like Finder's "Date Added")
- Download progress indicator on icon

## Development Workflow

### Safety First
**Never test directly on your running session** — in Wayland, a gnome-shell crash kills your session.

Use the isolated headless test recipe above. It:
- Isolates dconf (`XDG_CONFIG_HOME=/tmp/dock-test/.config`)
- Keeps symlinks visible (`XDG_DATA_HOME=$HOME/.local/share`)
- Runs debug mode (`--debug-control`) so Clutter/Mutter warnings surface real bugs
- **Must** set XDG vars outside the inner script (inside is too late and clobbers your real session)

### Code Review Rigor
This codebase *must* receive explicit bug-sweep passes before trusting "should work" claims. Example: A critical `Clutter.BinLayout` bug (ignores `set_position()`, would have collapsed the entire grid) survived multiple careful code reviews and only surfaced during live testing. Lesson: read function-by-function, trace layout-manager/signal/async behavior, don't just surface-read.

**When reviewing:**
1. Trace actual behavior (signals, layout, animation timing) not just the code flow
2. Check for race conditions, especially in async operations
3. Verify geometry/layout assumptions with actual Clutter docs (not assumptions)
4. Run in headless test before claiming a fix works

### Reloading After Changes

**Wayland (default):**
- Full logout/login required
- `Alt+F2 r` and `disable`/`enable` do NOT guarantee ES modules are reloaded
- Session restart is the only reliable method

**X11:**
- `Alt+F2` → `r` (shell reload), or
- `gnome-extensions disable $UUID` then `enable`

## Settings & Prefs

Preferences window: `gnome-extensions prefs macos-dock-stack@eliasfarah.github.io`

All settings in `org.gnome.shell.extensions.macos-dock-stack.*` schema (see `schemas/`). Changes take effect immediately except:
- Appearance mode (light/dark) may need observer re-connect
- Dash to Dock auto-disable happens at extension init, not on setting change

### Common Gotchas
1. `prefs.js` must call `gettext` (`_()`) lazily from inside `fillPreferencesWindow`, not at module-eval time (throws "gettext can only be called from extensions")
2. `metadata.json` `shell-version` array must include the installed version (e.g., `"50"`) or `gnome-extensions` treats it as not-installed
3. GSettings writes in live dock go through `DockIntegration` too — debounce if frequent (e.g., 400ms for prefs window keystroke events)

## Internationalization (i18n)

Source strings (the `_('...')` msgid literals in `prefs.js` and `modules/*.js`) are **English**, the GNOME convention — not Portuguese. `po/pt_BR.po` carries the Portuguese translation of every one of them; `locale/pt_BR/LC_MESSAGES/macos-dock-stack.mo` is the compiled catalog gettext actually reads, generated (like `schemas/gschemas.compiled`) and gitignored, not committed.

- **In the shell process** (`extension.js`, `modules/*.js`): `import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';` — a lazy, stack-trace-resolved lookup, safe to call from any function at runtime, **not** at module-eval time (same constraint as prefs.js below). `extension.js` itself is the `Extension` subclass, so it uses the inherited `this.gettext(...)` instead of importing the function.
- **In prefs.js** (separate process): `import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';` — same lazy-call rule.
- Translation loading (`ExtensionBase.initTranslations()`) runs automatically in the constructor using `metadata['gettext-domain']`, and looks for `<extension-dir>/locale/<lang>/LC_MESSAGES/<domain>.mo`. No catalog for a language (including English) → `_()` returns the msgid verbatim, which is why English needs no catalog at all.
- After changing any translatable string or adding a new `_('...')` call, regenerate the template and re-check the Portuguese file for new/removed entries:
  ```sh
  xgettext --from-code=UTF-8 --language=JavaScript --keyword=_ --keyword=gettext \
    --package-name="macOS Dock Stack" -o po/macos-dock-stack.pot \
    extension.js prefs.js modules/*.js
  msgmerge --update po/pt_BR.po po/macos-dock-stack.pot
  ```
  `msgmerge` leaves new strings untranslated (`msgstr ""`) — fill those in by hand, then recompile with `msgfmt` (see Commands below).
- Packaging (`gnome-extensions pack`) must include `locale/` via `--extra-source=locale`, same as `modules/` — it is not picked up automatically.

## Testing Environment

**Machine:** Arch Linux, GNOME 50, Wayland (primary)

Tools:
- `mutter-devkit` (replaces old `--nested` mode)
- `dbus-run-session` for isolation
- `gsettings` for preferences
- `glib-compile-schemas` for GSettings schema compilation

See memory: `reference_gnome_testing_env.md` for detailed headless/devkit recipes.

## Memory & Context

User preferences:
- **Bug-sweep rigor:** Trace actual behavior (layout, signals, async), not surface reads. See: `feedback_bug_sweep_rigor.md`
- **Live session safety:** Always use isolated headless testing before touching the real session. See: `feedback_live_session_safety.md`
- **dconf isolation:** Set `XDG_CONFIG_HOME` outside the inner dbus-run-session script. See: `feedback_dconf_isolation_outer_env.md`

## Recent History

- **Commit 7177db8:** Fix: use custom macos-app-grid icon for dock show apps button
- **Commit a02728c:** Stop recent apps reordering on open/close, ship live config as defaults
- **Commit 8e10915:** Blur only wallpaper, ending session-wide animation slowdown
- **Commit 554aebb:** Sample desktop via window_group clone, stop recent-app removals being backfilled
- **Commit 537e6ac:** Add real rounded-corner background blur, stop dock going black

All known bugs from four review passes are fixed and pushed (as of 2026-07-23).

## Commands

```sh
# Enable extension
gnome-extensions enable macos-dock-stack@eliasfarah.github.io

# Open prefs
gnome-extensions prefs macos-dock-stack@eliasfarah.github.io

# Compile schemas (after schema changes)
glib-compile-schemas schemas/

# Compile translations (after po/pt_BR.po changes)
msgfmt po/pt_BR.po -o locale/pt_BR/LC_MESSAGES/macos-dock-stack.mo

# Disable extension
gnome-extensions disable macos-dock-stack@eliasfarah.github.io

# Uninstall
rm -r ~/.local/share/gnome-shell/extensions/macos-dock-stack@eliasfarah.github.io
```

## Notes for Future Work

- **Scope is full dock, not Dash integration.** User confirmed (2026-07-23) wanting a complete macOS-faithful dock built from scratch, replacing Dash to Dock entirely.
- **No priority order on features.** Magnification, running-app dots, separators, genie effect, drag-and-drop all in scope; treat all equally unless user prioritizes later.
- **Visual accuracy matters.** Measurements are from real macOS captures, not estimates — maintain this precision in any new features.
