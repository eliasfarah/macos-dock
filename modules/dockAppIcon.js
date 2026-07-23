/* dockAppIcon.js
 *
 * One dock icon backed by a real Shell.App (pinned or running). Extends
 * GNOME Shell's own AppIcon rather than building an icon actor from
 * scratch, mirroring the native Dash's own DashIcon: reuse activate(),
 * popupMenu(), the running-state dot and click handling for free, only
 * override the handful of methods that assume an Overview/app-grid
 * context we don't have on a persistent dock.
 */

import GObject from 'gi://GObject';
import St from 'gi://St';
import Shell from 'gi://Shell';
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';

import { animateSpring, SPRING } from './animations.js';

const BOUNCE_HEIGHT = 14;
const ATTENTION_BOUNCE_COUNT = 3;

export const DockAppIcon = GObject.registerClass(
class DockAppIcon extends AppDisplay.AppIcon {
    _init(app) {
        super._init(app, {
            setSizeManually: true,
            showLabel: false,
            popupMenuSide: St.Side.TOP,
        });

        this._launchBouncing = false;

        // AppIcon's own base class already listens for 'notify::state' to
        // show/hide the running dot — this is an additional, independent
        // listener for the same signal, just for the launch bounce.
        this.app.connectObject('notify::state', () => this._onStateChanged(), this);
    }

    _onStateChanged() {
        if (this.app.state === Shell.AppState.STARTING)
            this._startLaunchBounce();
        else
            this._launchBouncing = false;
    }

    _startLaunchBounce() {
        if (this._launchBouncing)
            return;
        this._launchBouncing = true;
        this._bounceCycle(() => this._launchBouncing);
    }

    // A handful of bounces, then stop — mirrors macOS's bounded
    // attention bounce rather than looping indefinitely until the user
    // notices, which would be more annoying than helpful.
    attentionBounce() {
        let remaining = ATTENTION_BOUNCE_COUNT;
        this._bounceCycle(() => {
            remaining -= 1;
            return remaining > 0;
        });
    }

    _bounceCycle(shouldContinue) {
        if (!this.get_stage())
            return;
        animateSpring(this, { translation_y: 0 }, { translation_y: -BOUNCE_HEIGHT }, {
            duration: 160, preset: SPRING.ITEM,
            onComplete: () => {
                animateSpring(this, { translation_y: -BOUNCE_HEIGHT }, { translation_y: 0 }, {
                    duration: 160, preset: SPRING.ITEM,
                    onComplete: () => {
                        if (shouldContinue())
                            this._bounceCycle(shouldContinue);
                    },
                });
            },
        });
    }

    // Overview-entry visual effects used during app-grid DND — meaningless
    // on a persistent dock, disabled exactly like the native DashIcon does.
    scaleAndFade() {
    }

    undoScaleAndFade() {
    }

    // Per-icon drop targets are handled by DockManager's own reorder
    // logic (added in a later phase), not by AppIcon's app-grid-folder
    // drop semantics.
    handleDragOver() {
        return DND.DragMotionResult.CONTINUE;
    }

    acceptDrop() {
        return false;
    }
});
