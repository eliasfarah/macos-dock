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

        this._icon = new St.Icon({ icon_size: iconSize });
        this._applyIcon(config);
        this.set_child(this._icon);

        this.connect('clicked', () => onActivate(config, this));

        this._draggable = DND.makeDraggable(this, { timeoutThreshold: 200 });
    }

    // Mirrors AppDisplay.AppIcon's own getDragActor/getDragActorSource:
    // the drag uses a lightweight clone as the actor that follows the
    // pointer, so the real icon stays put in the dock (and in
    // DockManager's stacksBox) for the whole drag, the same as app
    // icons already do.
    getDragActor() {
        return new St.Icon({ gicon: this._icon.gicon, icon_size: this._icon.icon_size });
    }

    getDragActorSource() {
        return this._icon;
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
