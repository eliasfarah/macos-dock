# Restore Point — 2026-07-30

Safety net created before an experimental change to the dock. Everything below
describes how to get back to the known-good state if the experiment breaks
something.

## Known-good state

| What | Value |
| --- | --- |
| Code commit | `b53a42e` — *docs: clean up comments for tone, remove debug-diary artifacts* |
| Restore point | one commit later, adding only this file |
| Release | `v1.4.1` (plus the comment cleanup on top) |
| Git tag | `safe-point-2026-07-30` |
| Git branch | `backup/pre-experiment-2026-07-30` |
| Remote | `origin/main` was at the same commit — GitHub still holds it |
| Offline copy | `~/.local/share/macos-dock-backups/2026-07-30-pre-experiment/` |

The offline copy holds:

- `worktree-full.tar.gz` — the entire project directory including `.git`
- `dconf-settings.ini` — live dock preferences (icon size, stacks, recent apps, …)
- `enabled-extensions.txt` — which GNOME extensions were enabled
- `HEAD-sha.txt` — the commit above

## Restoring

### Code only (usual case)

Discard everything since the safe point and go back:

```sh
cd ~/Projects/macos-dock
git reset --hard safe-point-2026-07-30
git clean -fd            # remove any new untracked files the experiment added
```

Keep the experiment around instead, and just move `main` back:

```sh
git branch experiment-2026-07-30   # bookmark the current work first
git reset --hard safe-point-2026-07-30
```

Already pushed the broken state to GitHub? Force main back:

```sh
git push --force-with-lease origin safe-point-2026-07-30:main
```

### Settings only

If the dock still runs but the preferences got mangled:

```sh
dconf load /org/gnome/shell/extensions/macos-dock-stack/ \
  < ~/.local/share/macos-dock-backups/2026-07-30-pre-experiment/dconf-settings.ini
```

To wipe the settings first and start from the backup cleanly:

```sh
dconf reset -f /org/gnome/shell/extensions/macos-dock-stack/
dconf load /org/gnome/shell/extensions/macos-dock-stack/ \
  < ~/.local/share/macos-dock-backups/2026-07-30-pre-experiment/dconf-settings.ini
```

### Everything, from the tarball

If the git repo itself gets damaged:

```sh
mv ~/Projects/macos-dock ~/Projects/macos-dock.broken
tar -xzf ~/.local/share/macos-dock-backups/2026-07-30-pre-experiment/worktree-full.tar.gz \
  -C ~/Projects
```

The extension symlink (`~/.local/share/gnome-shell/extensions/macos-dock-stack@eliasfarah.github.io`
→ `~/Projects/macos-dock`) survives this, since the path is unchanged.

### Emergency — the dock breaks the session

Disable it from a TTY (Ctrl+Alt+F3) or another session:

```sh
gnome-extensions disable macos-dock-stack@eliasfarah.github.io
```

Then log back in, restore the code, and re-enable.

## After restoring

Regenerate the gitignored build outputs:

```sh
cd ~/Projects/macos-dock
glib-compile-schemas schemas/
msgfmt po/pt_BR.po -o locale/pt_BR/LC_MESSAGES/macos-dock-stack.mo
```

Wayland needs a full logout/login for the shell to pick up changed ES modules.

## Cleaning up

Once the experiment is settled and you no longer need the net:

```sh
git branch -d backup/pre-experiment-2026-07-30
git tag -d safe-point-2026-07-30
rm -r ~/.local/share/macos-dock-backups/2026-07-30-pre-experiment
rm RESTORE.md
```
