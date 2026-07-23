/* extension.js
 *
 * Entry point. Wires the three collaborators together:
 *   - StackSettings wraps GSettings (modules/settings.js)
 *   - StackManager owns the open/close lifecycle of stack panels (modules/stack.js)
 *   - DockIntegration injects icons into whatever dash(es) it finds (modules/dock.js)
 */

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { StackSettings } from './modules/settings.js';
import { StackManager } from './modules/stack.js';
import { DockIntegration } from './modules/dock.js';

export default class MacosDockStackExtension extends Extension {
    enable() {
        this._settings = new StackSettings(this.getSettings());
        this._stackManager = new StackManager(this._settings);
        this._dockIntegration = new DockIntegration(this._settings, (config, iconActor) => {
            this._stackManager.toggle(config, iconActor);
        });
        this._dockIntegration.enable();
    }

    disable() {
        this._dockIntegration?.disable();
        this._dockIntegration = null;

        this._stackManager?.destroy();
        this._stackManager = null;

        this._settings?.destroy();
        this._settings = null;
    }
}
