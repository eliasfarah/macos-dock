/* dockTrashIcon.js
 *
 * Trailing dock icon that opens the trash (Nautilus' trash:/// URI) and
 * reflects whether the trash currently holds anything, the way macOS
 * shows a full vs. empty bin.
 */

import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { launchUri } from './utils.js';

export const DockTrashIcon = GObject.registerClass(
class DockTrashIcon extends St.Button {
    _init(iconSize) {
        super._init({
            style_class: 'macos-dock-trash-icon',
            can_focus: true,
            reactive: true,
            track_hover: true,
        });

        this._icon = new St.Icon({
            gicon: new Gio.ThemedIcon({ name: 'user-trash' }), // full-color, not -symbolic
            icon_size: iconSize,
        });
        this.set_child(this._icon);

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

        this._trashFile.enumerate_children_async(
            'standard::name', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT,
            this._cancellable, (source, result) => {
                let enumerator;
                try {
                    enumerator = source.enumerate_children_finish(result);
                } catch (error) {
                    return; // cancelled, or no trash backend available
                }
                enumerator.next_files_async(1, GLib.PRIORITY_DEFAULT, this._cancellable, (src, res) => {
                    let infos = [];
                    try {
                        infos = src.next_files_finish(res);
                    } catch (error) {
                        return;
                    }
                    enumerator.close_async(GLib.PRIORITY_DEFAULT, null, () => {});
                    this._setFull(infos.length > 0);
                });
            });
    }

    _setFull(full) {
        const name = full ? 'user-trash-full' : 'user-trash';
        if (this._iconName === name)
            return;
        this._iconName = name;
        this._icon.gicon = new Gio.ThemedIcon({ name });
    }

    setIconSize(size) {
        this._icon.icon_size = size;
    }
});
