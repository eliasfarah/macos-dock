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

// How often the in-flight download is re-measured while one is running.
// Fast enough to look live, slow enough that a folder being written to
// continuously doesn't cost a stat per frame.
const PROGRESS_POLL_MS = 700;
// A partial file that hasn't grown across this many polls is treated as a
// stalled or abandoned download and the bar is dropped: browsers leave
// `.part` files behind after a cancelled download, and a progress bar that
// never goes away is worse than none.
const PROGRESS_STALL_POLLS = 12;
// Fraction of the icon's width/height the progress bar occupies.
const PROGRESS_WIDTH_RATIO = 0.86;
const PROGRESS_HEIGHT_RATIO = 0.13;
// One indeterminate sweep, in milliseconds.
const PROGRESS_SWEEP_MS = 1400;

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
        // The pile is its own container because _rebuild() empties it
        // wholesale, and the progress bar must survive that.
        this._pile = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            width: iconSize,
            height: iconSize,
        });
        this._preview.add_child(this._pile);

        // Sits above the pile, in the same fixed-layout container, so it
        // can be pinned to the icon's foot the way the macOS Dock draws a
        // download in progress. Built once and simply hidden when nothing
        // is downloading — rebuilding it per poll would restart its own
        // animation every 700ms.
        this._progressTrack = new St.Widget({
            style_class: 'macos-dock-progress-track',
            visible: false,
        });
        this._progressFill = new St.Widget({ style_class: 'macos-dock-progress-fill' });
        this._progressTrack.add_child(this._progressFill);
        this._preview.add_child(this._progressTrack);

        this._download = null; // { path, size, seen, stalled }
        this._progressId = 0;
        this._sweepStart = 0;

        this.set_child(this._preview);
        this._rebuild();

        this.connect('clicked', () => onActivate(this.config, this));

        this._draggable = DND.makeDraggable(this, { timeoutThreshold: 200 });

        this._watchFolder();
        this._refresh();

        this.connect('destroy', () => {
            this._stopWatching();
            this._cancelPendingRefresh();
            this._stopSweep();
            this._stopProgress();
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
            this._syncDownloadState();
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
        this._pile.destroy_all_children();
        this._preview.set_size(this._iconSize, this._iconSize);
        this._pile.set_size(this._iconSize, this._iconSize);
        this._layoutProgress();

        // An empty (or unreadable) folder has nothing to preview, so it
        // keeps the plain folder icon — matching macOS, which only piles
        // up a stack that actually has contents.
        if (this._entries.length === 0) {
            this._pile.add_child(this._layer(this._fallbackGicon(),
                { scale: 1, rotate: 0, dx: 0, dy: 0 }));
            return;
        }

        // The front layer is the last one in PREVIEW_LAYERS but the *first*
        // entry, so the pile reads front-to-back in the same order the
        // opened stack lists its items — which utils.js now sorts newest
        // first, so the face of the pile is whatever landed in the folder
        // most recently, the way a macOS Downloads stack behaves.
        const visible = PREVIEW_LAYERS.slice(-Math.min(this._entries.length, PREVIEW_LAYERS.length));
        visible.forEach((layer, index) => {
            const entry = this._entries[visible.length - 1 - index];
            this._pile.add_child(this._layer(iconForEntry(entry), layer));
        });
    }

    // -- download progress ----------------------------------------------
    //
    // macOS shows a progress bar on a Dock stack while something is being
    // written into that folder. There is no desktop-wide API that reports
    // "this download is 40% done" — browsers don't publish it — so this
    // works off the artefact they all leave on disk instead: the partial
    // file (`.part`, `.crdownload`, …) they write to and rename on
    // completion. Its presence is the signal that a download is running,
    // and its growth is the signal that it is still alive.
    //
    // A *fraction* is only shown when one can honestly be computed: when
    // the partial file is sparse — its allocated blocks add up to less than
    // its apparent size, which is what preallocating the final size looks
    // like on disk — the ratio between the two is real progress. Otherwise
    // the total is genuinely unknowable and the bar sweeps instead of
    // filling, which says "working" without inventing a number.

    _layoutProgress() {
        if (!this._progressTrack)
            return;
        const width = Math.round(this._iconSize * PROGRESS_WIDTH_RATIO);
        const height = Math.max(4, Math.round(this._iconSize * PROGRESS_HEIGHT_RATIO));
        this._progressTrack.set_size(width, height);
        this._progressTrack.set_position(
            Math.round((this._iconSize - width) / 2), this._iconSize - height);
        this._progressFill.set_position(1, 1);
        this._progressFill.set_height(Math.max(1, height - 2));
    }

    _syncDownloadState() {
        const partial = this._entries.find(entry => entry.partial);
        if (!partial) {
            this._stopProgress();
            return;
        }

        if (this._download?.path !== partial.path) {
            this._download = { path: partial.path, size: -1, allocated: -1, quiet: 0 };
            this._sweepStart = GLib.get_monotonic_time() / 1000;
        }
        this._startProgress();
    }

    _startProgress() {
        this._progressTrack.show();
        if (this._progressId)
            return;
        this._pollProgress();
        this._progressId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PROGRESS_POLL_MS, () => {
            this._pollProgress();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopProgress() {
        if (this._progressId) {
            GLib.Source.remove(this._progressId);
            this._progressId = 0;
        }
        this._download = null;
        this._progressTrack?.hide();
    }

    _pollProgress() {
        const download = this._download;
        if (!download || !this.get_stage()) {
            this._stopProgress();
            return;
        }

        const file = Gio.File.new_for_path(download.path);
        file.query_info_async('standard::size,unix::blocks',
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null, (source, result) => {
                if (this._download !== download)
                    return; // superseded by a newer download while in flight

                let info;
                try {
                    info = source.query_info_finish(result);
                } catch (error) {
                    // Gone — either finished and renamed, or cancelled.
                    // Either way the folder monitor is about to re-list.
                    this._stopProgress();
                    return;
                }

                const size = info.get_size();
                // st_blocks is defined by POSIX in fixed 512-byte units,
                // whatever the filesystem's own block size is.
                // `unix::block-size` is st_blksize — the *preferred I/O
                // size* (4096 here), a different quantity entirely, and
                // multiplying by it reported a 100MB file as having 160MB
                // allocated, which made every download look non-sparse and
                // fall back to the indeterminate sweep. Measured: 40960
                // blocks x 512 = exactly the 20MB actually written.
                const allocated = info.get_attribute_uint64('unix::blocks') * 512;

                if (size === download.size && allocated === download.allocated) {
                    download.quiet += 1;
                    if (download.quiet >= PROGRESS_STALL_POLLS) {
                        this._stopProgress();
                        return;
                    }
                } else {
                    download.quiet = 0;
                }
                download.size = size;
                download.allocated = allocated;

                // Sparse by a clear margin means the final size was
                // reserved up front and only part of it is written yet.
                // The 8KiB slack keeps filesystem bookkeeping (a tail
                // block, inline extents) from reading as "nearly empty".
                const fraction = size > 0 && allocated + 8192 < size
                    ? allocated / size
                    : -1;
                this._drawProgress(fraction);
            });
    }

    _drawProgress(fraction) {
        const inner = Math.max(1, this._progressTrack.width - 2);
        if (fraction >= 0) {
            this._stopSweep();
            this._progressFill.set_x(1);
            this._progressFill.set_width(Math.max(1, Math.round(inner * fraction)));
            return;
        }
        this._startSweep();
    }

    /**
     * The indeterminate sweep runs on its own timeline rather than being
     * stepped by the poll: at one frame every 700ms it would read as a
     * block teleporting along the track, not as motion. Bound to this
     * actor via new_for_actor(), because a bare Clutter.Timeline has no
     * frame clock and silently never starts.
     */
    _startSweep() {
        if (this._sweep)
            return;
        this._sweep = Clutter.Timeline.new_for_actor(this, PROGRESS_SWEEP_MS);
        this._sweep.set_repeat_count(-1);
        this._sweep.connect('new-frame', () => {
            const inner = Math.max(1, this._progressTrack.width - 2);
            const segment = Math.max(4, Math.round(inner * 0.35));
            this._progressFill.set_width(segment);
            this._progressFill.set_x(1 + Math.round((inner - segment) * this._sweep.get_progress()));
        });
        this._sweep.start();
    }

    _stopSweep() {
        this._sweep?.stop();
        this._sweep = null;
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
