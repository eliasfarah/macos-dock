/* dockShowAppsIcon.js
 *
 * Leading dock icon that opens the Activities/app-grid overview —
 * restores the "show all apps" entry point that Dash to Dock used to
 * provide before extension.js auto-disabled it in favor of our own
 * persistent dock (see extension.js's _disableDashToDock()).
 */

import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export const DockShowAppsIcon = GObject.registerClass(
class DockShowAppsIcon extends St.Button {
    _init(iconSize) {
        super._init({
            style_class: 'macos-dock-show-apps-icon',
            can_focus: true,
            reactive: true,
            track_hover: true,
        });

        this._icon = new St.Icon({
            gicon: new Gio.ThemedIcon({ name: 'macos-app-grid' }),
            icon_size: iconSize,
        });
        this.set_child(this._icon);

        this.connect('clicked', () => {
            if (Main.overview.visible)
                Main.overview.hide();
            else
                Main.overview.showApps();
        });
    }

    setIconSize(size) {
        this._icon.icon_size = size;
    }
});
