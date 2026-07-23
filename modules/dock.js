/* dock.js
 *
 * Injects one icon per configured stack into the dash(es) found on the
 * system, and forwards clicks to the callback given at construction.
 *
 * The native GNOME Dash (Main.overview.dash) is only ever visible
 * inside the Overview — vanilla GNOME has no persistent, always-on
 * desktop dock. To behave like an actual macOS Dock, most users will
 * want this paired with the Dash to Dock or Dash to Panel extensions,
 * which keep a dash on the desktop at all times. Both are supported
 * on a best-effort basis: their dock/dash containers are private,
 * version-dependent implementation details of a third-party
 * extension, not a public API, so integration here is defensive and
 * simply does nothing if their internals don't match what we expect.
 */

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const DASH_TO_DOCK_UUID = 'dash-to-dock@micxgx.gmail.com';
const DASH_TO_PANEL_UUID = 'dash-to-panel@jderose9.github.com';
const ICON_SIZE = 48;

export class DockIntegration {
    constructor(settings, onActivate) {
        this._settings = settings;
        this._onActivate = onActivate;
        this._injected = []; // { actor, box, childAddedId }
        this._settingsChangedId = 0;
    }

    enable() {
        this._rebuild();
        this._settingsChangedId = this._settings.connectChanged((_s, key) => {
            if (key === 'stacks')
                this._rebuild();
        });
    }

    disable() {
        this._settings.disconnectChanged(this._settingsChangedId);
        this._settingsChangedId = 0;
        this._destroyInjected();
    }

    _rebuild() {
        this._destroyInjected();

        const boxes = this._findDashBoxes();
        if (boxes.length === 0)
            return;

        const stacks = this._settings.getStacks();
        for (const box of boxes) {
            for (const config of stacks)
                this._injectIcon(config, box);
        }
    }

    _destroyInjected() {
        for (const entry of this._injected) {
            if (entry.childAddedId)
                entry.box.disconnect(entry.childAddedId);
            entry.actor.destroy();
        }
        this._injected = [];
    }

    // -- dash discovery ----------------------------------------------------

    _findDashBoxes() {
        const boxes = [];

        const nativeBox = Main.overview?.dash?._box;
        if (nativeBox)
            boxes.push(nativeBox);

        this._collectFromExtension(DASH_TO_DOCK_UUID, boxes);
        this._collectFromExtension(DASH_TO_PANEL_UUID, boxes);

        return boxes;
    }

    _collectFromExtension(uuid, boxes) {
        try {
            const extensionObject = Main.extensionManager?.lookup(uuid);
            const stateObj = extensionObject?.stateObj;
            const dockManager = stateObj?.dockManager;
            const docks = dockManager?._allDocks ?? dockManager?.docks ?? [];
            for (const dock of docks) {
                const box = dock?.dash?._box;
                if (box && !boxes.includes(box))
                    boxes.push(box);
            }
        } catch (error) {
            // Extension not installed/enabled, or its internals changed
            // since this was written — fail silently, native Dash
            // support is unaffected.
        }
    }

    // -- icon injection ------------------------------------------------

    _injectIcon(config, box) {
        const actor = this._createIconActor(config);
        this._insertBeforeTrailer(actor, box);

        // If the dash rebuilds its own children (e.g. favorites or
        // running apps changed) our foreign actor is generally left
        // alone, but re-insert defensively if it ever gets detached.
        // Re-inserting itself fires another 'child-added', so this
        // checks the parent first (no-op on the re-entrant call) and
        // is wrapped in try/catch in case the actor was destroyed
        // outright by whatever rebuilt the box.
        const childAddedId = box.connect('child-added', () => {
            if (actor.get_parent() === box)
                return;
            try {
                this._insertBeforeTrailer(actor, box);
            } catch (error) {
                // Nothing more we can do until the next _rebuild() pass.
            }
        });

        this._injected.push({ actor, box, childAddedId });
    }

    _insertBeforeTrailer(actor, box) {
        const index = Math.max(0, box.get_n_children() - 1);
        box.insert_child_at_index(actor, index);
    }

    _createIconActor(config) {
        const button = new St.Button({
            style_class: 'dash-item-container macos-stack-dash-icon',
            can_focus: true,
            reactive: true,
            track_hover: true,
        });

        let gicon = null;
        if (config.icon) {
            try {
                gicon = Gio.Icon.new_for_string(config.icon);
            } catch (error) {
                gicon = null;
            }
        }
        if (!gicon)
            gicon = new Gio.ThemedIcon({ name: 'folder' }); // full-color, not -symbolic

        const icon = new St.Icon({
            gicon,
            icon_size: ICON_SIZE,
            style_class: 'macos-stack-dash-icon-image',
        });
        button.set_child(icon);
        button.connect('button-press-event', () => {
            this._onActivate(config, button);
            return Clutter.EVENT_STOP;
        });

        return button;
    }
}
