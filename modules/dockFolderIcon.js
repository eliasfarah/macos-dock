/* dockFolderIcon.js
 *
 * One dock icon for a configured folder-stack. Unlike DockAppIcon, this
 * has no Shell.App behind it, so it doesn't extend AppDisplay.AppIcon —
 * forcing a bare folder through AppIcon's app-menu/launch internals would
 * fight the class's assumptions for no benefit. It's draggable (for
 * dock reordering) via the same generic ui/dnd.js API AppViewItem uses
 * internally, just wired directly since we aren't an AppViewItem.
 *
 * Visually it is not a folder glyph but a *preview pile*, the way a macOS
 * stack shows what it actually holds: the first item's icon in front with
 * the next two fanned out behind it. The plain folder icon is now only
 * the empty/unreadable fallback.
 */

import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';

import { listDirectory, iconForEntry } from './utils.js';

// Back-to-front, so a plain add_child() loop already paints in the right
// order. `scale` is a fraction of the dock's icon size; `dx`/`dy` offset
// from centre in those same units. The two rear layers peek out above the
// front one rather than beside it, which is what reads as a pile at 48px
// instead of as three separate icons.
// The front layer sits at dy 0 on purpose: it is the only one the eye
// reads as "the icon", so offsetting it would push this whole dock item
// out of line with the app icons beside it. The pile is built by lifting
// the two rear layers instead.
const PREVIEW_LAYERS = [
    { scale: 0.60, rotate: 15, dx: 0.17, dy: -0.24 },
    { scale: 0.74, rotate: -13, dx: -0.16, dy: -0.16 },
    { scale: 1.00, rotate: 0, dx: 0, dy: 0 },
];

// File monitors fire a burst of events for a single copy/delete, and each
// refresh is a full async directory enumeration — coalesce them.
const REFRESH_DEBOUNCE_MS = 250;

export const DockFolderIcon = GObject.registerClass(
class DockFolderIcon extends St.Button {
    _init(config, iconSize, onActivate) {
        super._init({
            style_class: 'macos-dock-folder-icon',
            can_focus: true,
            reactive: true,
            track_hover: true,
        });

        this.config = config;
        this.dockItemId = config.id;
        this._iconSize = iconSize;
        this._entries = [];
        this._refreshId = 0;

        // Required for DND.makeDraggable's "does this actor have a
        // custom drag actor" check (`this.actor._delegate.getDragActor`,
        // see dnd.js) — without it, dnd.js falls back to reparenting
        // this actor itself into Main.uiGroup as the drag ghost, which
        // would yank it out of DockManager's stacksBox mid-drag and
        // make every subsequent this._dragBox.set_child_at_index(...)
        // call during dockManager.js's _onDragMotion() target an actor
        // that's no longer actually a child of that box — the same
        // "avoid a crash but skip the real semantics" trap flagged
        // elsewhere in this codebase's bug-sweep notes.
        this._delegate = this;

        // Clutter.FixedLayout so the layers keep the positions _rebuild()
        // assigns them; anything else would re-pack them into a row.
        this._preview = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            width: iconSize,
            height: iconSize,
        });
        this.set_child(this._preview);
        this._rebuild();

        this.connect('clicked', () => onActivate(this.config, this));

        this._draggable = DND.makeDraggable(this, { timeoutThreshold: 200 });

        this._watchFolder();
        this._refresh();

        this.connect('destroy', () => {
            this._stopWatching();
            this._cancelPendingRefresh();
        });
    }

    // Mirrors AppDisplay.AppIcon's own getDragActor/getDragActorSource:
    // the drag uses a lightweight clone as the actor that follows the
    // pointer, so the real icon stays put in the dock (and in
    // DockManager's stacksBox) for the whole drag, the same as app
    // icons already do.
    getDragActor() {
        return new St.Icon({ gicon: this._frontGicon(), icon_size: this._iconSize });
    }

    getDragActorSource() {
        return this._preview;
    }

    // -- contents ------------------------------------------------------

    /**
     * Re-reads the folder so the pile tracks what's actually in it. The
     * enumeration is the async one from utils.js: this runs inside the
     * compositor process, where a blocking readdir on a large (or
     * network-backed) folder would stall every window on the desktop.
     */
    _refresh() {
        const path = this.config.path;
        listDirectory(path, entries => {
            // The folder may have been reconfigured, or the icon destroyed,
            // while the enumeration was in flight.
            if (!this.get_stage() || this.config.path !== path)
                return;
            this._entries = entries;
            this._rebuild();
        });
    }

    _scheduleRefresh() {
        this._cancelPendingRefresh();
        this._refreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REFRESH_DEBOUNCE_MS, () => {
            this._refreshId = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelPendingRefresh() {
        if (this._refreshId) {
            GLib.Source.remove(this._refreshId);
            this._refreshId = 0;
        }
    }

    _watchFolder() {
        this._stopWatching();
        try {
            this._monitor = Gio.File.new_for_path(this.config.path)
                .monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._monitor.connect('changed', () => this._scheduleRefresh());
        } catch (error) {
            // Unreadable or gone — the fallback folder icon still shows.
            this._monitor = null;
        }
    }

    _stopWatching() {
        this._monitor?.cancel();
        this._monitor = null;
    }

    // -- drawing -------------------------------------------------------

    _fallbackGicon() {
        if (this.config.icon) {
            try {
                return Gio.Icon.new_for_string(this.config.icon);
            } catch (error) {
                // Malformed setting — fall through.
            }
        }
        return new Gio.ThemedIcon({ name: 'folder' }); // full-color, not -symbolic
    }

    _frontGicon() {
        return this._entries.length > 0
            ? iconForEntry(this._entries[0])
            : this._fallbackGicon();
    }

    /**
     * Rebuilds the pile from scratch. Cheap (at most three St.Icons) and
     * it runs only on a real change — a folder edit, a settings change or
     * a dock icon-size change — never per frame during magnification.
     */
    _rebuild() {
        this._preview.destroy_all_children();
        this._preview.set_size(this._iconSize, this._iconSize);

        // An empty (or unreadable) folder has nothing to preview, so it
        // keeps the plain folder icon — matching macOS, which only piles
        // up a stack that actually has contents.
        if (this._entries.length === 0) {
            this._preview.add_child(this._layer(this._fallbackGicon(),
                { scale: 1, rotate: 0, dx: 0, dy: 0 }));
            return;
        }

        // The front layer is the last one in PREVIEW_LAYERS but the *first*
        // entry, so the pile reads front-to-back in the same order the
        // opened stack lists its items.
        const visible = PREVIEW_LAYERS.slice(-Math.min(this._entries.length, PREVIEW_LAYERS.length));
        visible.forEach((layer, index) => {
            const entry = this._entries[visible.length - 1 - index];
            this._preview.add_child(this._layer(iconForEntry(entry), layer));
        });
    }

    /**
     * One icon of the pile, pinned inside a fixed square. The square
     * matters: St.Icon's `icon_size` bounds only the longer side, so a
     * portrait thumbnail would come out narrower than a square app icon
     * and the layer offsets — which are all measured from the centre of a
     * known box — would no longer line the pile up.
     */
    _layer(gicon, { scale, rotate, dx, dy }) {
        const size = Math.round(this._iconSize * scale);
        const bin = new St.Bin({ width: size, height: size });
        bin.set_child(new St.Icon({
            gicon,
            icon_size: size,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        bin.set_position(
            Math.round((this._iconSize - size) / 2 + dx * this._iconSize),
            Math.round((this._iconSize - size) / 2 + dy * this._iconSize));
        bin.set_pivot_point(0.5, 0.5);
        bin.rotation_angle_z = rotate;
        return bin;
    }

    // -- external updates ----------------------------------------------

    setConfig(config) {
        const pathChanged = this.config.path !== config.path;
        this.config = config;
        if (pathChanged) {
            this._entries = [];
            this._watchFolder();
            this._refresh();
        }
        this._rebuild();
    }

    setIconSize(size) {
        if (this._iconSize === size)
            return;
        this._iconSize = size;
        this._rebuild();
    }

    // Dock reordering only — no app-grid-folder drop semantics apply here.
    handleDragOver() {
        return DND.DragMotionResult.CONTINUE;
    }

    acceptDrop() {
        return false;
    }
});
