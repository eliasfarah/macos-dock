/* dockTrashIcon.js
 *
 * Trailing dock icon that opens the trash (Nautilus' trash:/// URI) and
 * reflects whether the trash currently holds anything, the way macOS
 * shows a full vs. empty bin.
 *
 * A note on the "preview inside the Trash" idea: the real macOS Dock does
 * not show what is in the Trash — it swaps a clean bin for one with
 * crumpled paper in it and stops there. Rather than invent a pile of file
 * thumbnails that no Mac ever draws, this shows the icon theme's own
 * full-bin artwork when there is one, and tops it with a small peek of the
 * most recently discarded item when there isn't — which is the same
 * information, drawn with whatever the theme actually provides.
 */

import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { launchUri, iconForEntry, sortEntries } from './utils.js';

// In icon-name order of preference. Themes disagree about this one:
// Adwaita ships `user-trash` as full-colour artwork under places/ but
// `user-trash-full` only as a monochrome status icon, so blindly swapping
// to the -full name can turn a colourful bin into a flat glyph. Each
// candidate is checked against the icon theme before use.
const FULL_ICON_NAMES = ['user-trash-full', 'trash-full', 'user-trash'];
const EMPTY_ICON_NAMES = ['user-trash', 'trash-empty'];

// The peek of the newest discarded item, drawn over the bin's mouth when
// the theme has no distinct full-bin artwork. Fractions of the icon size.
const PEEK_SCALE = 0.42;
const PEEK_OFFSET_Y = -0.24;

function firstAvailableIcon(names) {
    let theme = null;
    try {
        theme = new St.IconTheme();
    } catch (error) {
        // No theme handle — fall through to the first candidate, which is
        // the standard freedesktop name and by far the likeliest to exist.
    }
    for (const name of names) {
        if (!theme || theme.has_icon(name))
            return name;
    }
    return names[names.length - 1];
}

export const DockTrashIcon = GObject.registerClass(
class DockTrashIcon extends St.Button {
    _init(iconSize) {
        super._init({
            style_class: 'macos-dock-trash-icon',
            can_focus: true,
            reactive: true,
            track_hover: true,
        });

        this._iconSize = iconSize;
        this._full = false;

        // Fixed layout so the peek keeps the offset _updatePeek() gives it
        // instead of being packed into a row beside the bin.
        this._stack = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            width: iconSize,
            height: iconSize,
        });

        this._icon = new St.Icon({
            gicon: new Gio.ThemedIcon({ name: EMPTY_ICON_NAMES[0] }), // full-color, not -symbolic
            icon_size: iconSize,
        });
        this._stack.add_child(this._icon);

        this._peek = new St.Bin({ visible: false });
        this._stack.add_child(this._peek);

        this.set_child(this._stack);

        this.connect('clicked', () => launchUri('trash:///'));

        // A static empty-bin icon was always shown, whatever the trash
        // actually held. Watched rather than polled, so emptying the
        // trash (or dragging something into it from Files) updates the
        // dock immediately instead of on the next login.
        this._trashFile = Gio.File.new_for_uri('trash:///');
        try {
            this._monitor = this._trashFile.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._monitor.connect('changed', () => this._updateState());
        } catch (error) {
            this._monitor = null; // no gvfs trash backend — keep the static icon
        }
        this._updateState();

        this.connect('destroy', () => {
            this._monitor?.cancel();
            this._monitor = null;
            this._cancellable?.cancel();
        });
    }

    _updateState() {
        // Asynchronous on purpose: this runs inside the compositor
        // process, where a synchronous enumerate on a gvfs-backed URI
        // could stall every window on the desktop, not just the dock.
        this._cancellable?.cancel();
        this._cancellable = new Gio.Cancellable();

        // Enough attributes to build the peek, and enough entries to pick
        // the newest rather than whichever the backend happens to hand
        // back first — the previous version asked for a single name just
        // to answer "is it empty", which is why it could never show what
        // was actually in there.
        this._trashFile.enumerate_children_async(
            'standard::type,standard::name,standard::display-name,standard::icon,standard::content-type,time::modified,trash::deletion-date',
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT,
            this._cancellable, (source, result) => {
                let enumerator;
                try {
                    enumerator = source.enumerate_children_finish(result);
                } catch (error) {
                    return; // cancelled, or no trash backend available
                }
                enumerator.next_files_async(20, GLib.PRIORITY_DEFAULT, this._cancellable, (src, res) => {
                    let infos = [];
                    try {
                        infos = src.next_files_finish(res);
                    } catch (error) {
                        return;
                    }
                    enumerator.close_async(GLib.PRIORITY_DEFAULT, null, () => {});

                    const entries = infos.map(info => ({
                        name: info.get_display_name(),
                        gicon: info.get_icon(),
                        isDirectory: info.get_file_type() === Gio.FileType.DIRECTORY,
                        partial: false,
                        // The trash records when each item was discarded,
                        // which is the order that matters here — not when
                        // the file itself was last written.
                        time: this._deletionTime(info) || info.get_attribute_uint64('time::modified'),
                    }));
                    sortEntries(entries);

                    this._newest = entries[0] ?? null;
                    this._setFull(entries.length > 0);
                });
            });
    }

    /** `trash::deletion-date` is an ISO-8601 string, not a timestamp. */
    _deletionTime(info) {
        const raw = info.get_attribute_string('trash::deletion-date');
        if (!raw)
            return 0;
        const parsed = GLib.DateTime.new_from_iso8601(raw, null);
        return parsed ? parsed.to_unix() : 0;
    }

    _setFull(full) {
        this._full = full;
        const names = full ? FULL_ICON_NAMES : EMPTY_ICON_NAMES;
        const name = firstAvailableIcon(names);
        if (this._iconName !== name) {
            this._iconName = name;
            this._icon.gicon = new Gio.ThemedIcon({ name });
        }
        // Only when the theme had nothing better to say: if it does have
        // real full-bin artwork, that already conveys "there is something
        // in here" and stacking a file icon on top of it just clutters the
        // dock.
        this._hasDistinctFullIcon = full && name !== EMPTY_ICON_NAMES[0];
        this._updatePeek();
    }

    _updatePeek() {
        if (!this._full || this._hasDistinctFullIcon || !this._newest) {
            this._peek.hide();
            return;
        }

        const size = Math.round(this._iconSize * PEEK_SCALE);
        this._peek.destroy_all_children();
        this._peek.set_size(size, size);
        this._peek.set_child(new St.Icon({
            gicon: iconForEntry(this._newest),
            icon_size: size,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._peek.set_position(
            Math.round((this._iconSize - size) / 2),
            Math.round((this._iconSize - size) / 2 + PEEK_OFFSET_Y * this._iconSize));
        this._peek.show();
    }

    setIconSize(size) {
        this._iconSize = size;
        this._icon.icon_size = size;
        this._stack.set_size(size, size);
        this._updatePeek();
    }
});
