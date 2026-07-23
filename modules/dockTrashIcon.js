/* dockTrashIcon.js
 *
 * Trailing dock icon that opens the trash (Nautilus' trash:/// URI).
 * Drop-to-delete is a plausible follow-up once dock drag-and-drop
 * exists (Phase 4+), but this only opens the trash for now.
 */

import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';

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
    }

    setIconSize(size) {
        this._icon.icon_size = size;
    }
});
