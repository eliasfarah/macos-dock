/* dockFolderIcon.js
 *
 * One dock icon for a configured folder-stack. Unlike DockAppIcon, this
 * has no Shell.App behind it, so it doesn't extend AppDisplay.AppIcon —
 * forcing a bare folder through AppIcon's app-menu/launch internals would
 * fight the class's assumptions for no benefit. It's draggable (for
 * dock reordering) via the same generic ui/dnd.js API AppViewItem uses
 * internally, just wired directly since we aren't an AppViewItem.
 */

import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';

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

        this._icon = new St.Icon({ icon_size: iconSize });
        this._applyIcon(config);
        this.set_child(this._icon);

        this.connect('clicked', () => onActivate(config, this));

        this._draggable = DND.makeDraggable(this, { timeoutThreshold: 200 });
    }

    _applyIcon(config) {
        let gicon = null;
        if (config.icon) {
            try {
                gicon = Gio.Icon.new_for_string(config.icon);
            } catch (error) {
                gicon = null;
            }
        }
        this._icon.gicon = gicon ?? new Gio.ThemedIcon({ name: 'folder' }); // full-color, not -symbolic
    }

    setConfig(config) {
        this.config = config;
        this._applyIcon(config);
    }

    setIconSize(size) {
        this._icon.icon_size = size;
    }

    // Dock reordering only — no app-grid-folder drop semantics apply here.
    handleDragOver() {
        return DND.DragMotionResult.CONTINUE;
    }

    acceptDrop() {
        return false;
    }
});
