/* minimizeEffect.js
 *
 * Replaces GNOME Shell's default minimize/unminimize animation with a
 * macOS-style "genie" swoop toward (and back from) the window's dock
 * icon, when one exists.
 *
 * GNOME's own minimize handling is wired once at shell startup
 * (global.window_manager's 'minimize'/'unminimize' signals, bound
 * inside WindowManager itself) — there is no supported way to
 * reassign or intercept that binding directly. The actual mechanism
 * (matching how effect extensions like Burn My Windows/Magic Lamp do
 * this) is Main.wm.skipNextEffect(actor): called from a signal that
 * fires *before* the compositor's own effect dispatch — Meta.Window's
 * 'notify::minimized', not the later 'minimize'/'unminimize' signal —
 * it marks the actor so GNOME Shell's own _shouldAnimateActor() skips
 * its animation and, on its own, calls completed_minimize/
 * completed_unminimize for us (see windowManager.js's
 * _shouldAnimateActor). We only need to run our own cosmetic
 * animation; we never call completed_minimize/unminimize ourselves.
 *
 * Caveat (flagged, not yet live-tested): since GNOME's own handler
 * calls completed_minimize/unminimize essentially as soon as it sees
 * the skip, our animation's tail end could in principle be cut short
 * if Mutter hides the actor before our spring settles. If that reads
 * badly in practice, shortening GENIE_DURATION is the first thing to
 * try — worst case is a cosmetic glitch, not a functional break, and
 * the dock-minimize-effect preference is a one-setting escape hatch
 * back to GNOME's default effect either way.
 */

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { animateSpring, SPRING } from './animations.js';

const GENIE_DURATION = 320;

export class MinimizeEffectManager {
    constructor(settings, dockManager) {
        this._settings = settings;
        this._dockManager = dockManager;

        this._windowCreatedId = 0;
        this._windowSignals = new Map(); // Meta.Window -> { minimizedId, unmanagingId }
    }

    enable() {
        this._windowCreatedId = global.display.connect('window-created', (_display, window) => {
            this._trackWindow(window);
        });
        for (const window of global.display.list_all_windows())
            this._trackWindow(window);
    }

    disable() {
        if (this._windowCreatedId) {
            global.display.disconnect(this._windowCreatedId);
            this._windowCreatedId = 0;
        }
        for (const [window, ids] of this._windowSignals) {
            window.disconnect(ids.minimizedId);
            window.disconnect(ids.unmanagingId);
        }
        this._windowSignals.clear();
    }

    _trackWindow(window) {
        if (this._windowSignals.has(window))
            return;

        const minimizedId = window.connect('notify::minimized', () => this._onMinimizedChanged(window));
        const unmanagingId = window.connect('unmanaging', () => {
            const ids = this._windowSignals.get(window);
            if (ids) {
                window.disconnect(ids.minimizedId);
                window.disconnect(ids.unmanagingId);
                this._windowSignals.delete(window);
            }
        });
        this._windowSignals.set(window, { minimizedId, unmanagingId });
    }

    _onMinimizedChanged(window) {
        if (this._settings.dockMinimizeEffect !== 'genie')
            return; // native effect runs unmodified

        const actor = window.get_compositor_private();
        if (!actor)
            return;

        const geometry = this._dockManager.getIconGeometryForWindow(window);
        if (!geometry)
            return; // no dock icon to swoop toward — let the native effect run

        Main.wm.skipNextEffect(actor);

        if (window.minimized)
            this._animateGenieOut(actor, geometry);
        else
            this._animateGenieIn(actor, window);
    }

    _animateGenieOut(actor, geometry) {
        const [width, height] = actor.get_size();
        actor.set_pivot_point(0.5, 1);

        animateSpring(actor,
            { x: actor.x, y: actor.y, scale_x: 1, scale_y: 1, opacity: 255 },
            { x: geometry.centerX - width / 2, y: geometry.centerY - height, scale_x: 0.05, scale_y: 0.05, opacity: 0 },
            { duration: GENIE_DURATION, preset: SPRING.PANEL, speed: this._settings.animationSpeed });
    }

    _animateGenieIn(actor, window) {
        const frame = window.get_frame_rect();
        actor.set_pivot_point(0.5, 1);

        animateSpring(actor,
            { x: actor.x, y: actor.y, scale_x: actor.scale_x, scale_y: actor.scale_y, opacity: actor.opacity },
            { x: frame.x, y: frame.y, scale_x: 1, scale_y: 1, opacity: 255 },
            { duration: GENIE_DURATION, preset: SPRING.PANEL, speed: this._settings.animationSpeed });
    }
}
