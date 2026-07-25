/* extension.js
 *
 * Entry point. Wires the collaborators together:
 *   - StackSettings wraps GSettings (modules/settings.js)
 *   - StackManager owns the open/close lifecycle of stack panels (modules/stack.js)
 *   - DockManager builds and maintains the persistent dock (modules/dockManager.js)
 *   - MinimizeEffectManager swaps in the genie minimize effect (modules/minimizeEffect.js)
 */

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ExtensionState } from 'resource:///org/gnome/shell/misc/extensionUtils.js';

import { StackSettings } from './modules/settings.js';
import { StackManager } from './modules/stack.js';
import { DockManager } from './modules/dockManager.js';
import { MinimizeEffectManager } from './modules/minimizeEffect.js';

const DASH_TO_DOCK_UUID = 'dash-to-dock@micxgx.gmail.com';

export default class MacosDockStackExtension extends Extension {
    enable() {
        this._settings = new StackSettings(this.getSettings());

        // Rolled back on any failure below so a mid-construction crash
        // doesn't orphan chrome actors or leave a half-built dock —
        // disable() is written defensively (every teardown step is
        // null-guarded) specifically so it's safe to call here even if
        // some collaborators were never constructed.
        try {
            this._disableDashToDock();

            this._stackManager = new StackManager(this._settings);
            this._dockManager = new DockManager(this._settings, (config, iconActor) => {
                this._stackManager.toggle(config, iconActor);
            }, () => this.openPreferences());
            this._dockManager.enable();

            this._minimizeEffectManager = new MinimizeEffectManager(this._settings, this._dockManager);
            this._minimizeEffectManager.enable();
        } catch (error) {
            console.error(error, 'macos-dock-stack: enable() failed, rolling back');
            this.disable();
            throw error;
        }
    }

    // We're a full replacement for Dash to Dock (confirmed choice, not
    // an assumption) — if it's currently active, disable it via the
    // same GSettings key `gnome-extensions disable` itself writes to,
    // so the running ExtensionManager picks up the change through its
    // own listener rather than us reaching into its private methods.
    // Deliberately one-directional: our own disable() does not
    // re-enable Dash to Dock — that stays the user's call.
    _disableDashToDock() {
        const extension = Main.extensionManager.lookup(DASH_TO_DOCK_UUID);
        if (!extension || extension.state !== ExtensionState.ACTIVE)
            return;

        const enabled = global.settings.get_strv('enabled-extensions');
        const filtered = enabled.filter(uuid => uuid !== DASH_TO_DOCK_UUID);
        if (filtered.length !== enabled.length) {
            global.settings.set_strv('enabled-extensions', filtered);
            Main.notify('macOS Dock Stack',
                'Dash to Dock foi desativado — o macOS Dock Stack assume como dock persistente.');
        }
    }

    disable() {
        this._minimizeEffectManager?.disable();
        this._minimizeEffectManager = null;

        this._dockManager?.disable();
        this._dockManager = null;

        this._stackManager?.destroy();
        this._stackManager = null;

        this._settings?.destroy();
        this._settings = null;
    }
}
