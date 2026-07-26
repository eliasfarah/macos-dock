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

// macOS' launch bounce lifts the icon by roughly a third of its own
// height, so the gesture reads the same whether the Dock is set small or
// large. A flat 14px looked like a twitch at 96px icons and like a leap at
// 32px ones.
const BOUNCE_RATIO = 0.3;
const ATTENTION_BOUNCE_COUNT = 3;
// macOS bounces a launching app a few times and then stops, even if the
// app is still starting. Ours looped for as long as the app stayed in
// Shell.AppState.STARTING, which for a slow starter like Chrome (which
// sits in STARTING for many seconds) meant an icon that kept hopping
// long after it stopped being informative — the "fica muito tempo
// pulando" report. Fast apps leave STARTING quickly, which is why they
// looked fine and only Chrome stood out.
const LAUNCH_BOUNCE_COUNT = 3;

export const DockAppIcon = GObject.registerClass(
class DockAppIcon extends AppDisplay.AppIcon {
    _init(app) {
        super._init(app, {
            setSizeManually: true,
            showLabel: false,
            popupMenuSide: St.Side.TOP,
        });

        // AppIcon's base 'overview-tile' style class carries a 12px
        // padding on every side (meant for the app-grid, which also
        // reserves space for a label under the icon). DockFolderIcon and
        // DockTrashIcon carry no such padding, so at the same icon-size
        // setting a running app's actual button was 24px taller/wider
        // than every other dock icon — enough to visibly throw off
        // vertical centering next to them. This adds a second, more
        // specific class purely to zero that padding back out for dock
        // use (see stylesheet.css), without touching the shared
        // 'overview-tile' rule other GNOME UI still relies on.
        this.add_style_class_name('macos-dock-app-icon');

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

        // Bounded by a bounce count as well as by the app's state, so a
        // long-starting app stops hopping on its own.
        let remaining = LAUNCH_BOUNCE_COUNT;
        this._bounceCycle(() => {
            remaining -= 1;
            return this._launchBouncing && remaining > 0;
        });
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

    // id: 'bounce' keeps this on its own animation slot. Hover
    // magnification drives scale_x/scale_y/translation_x on this same
    // actor, and with a single slot per actor the two silently killed
    // each other — pointing at a launching app froze its bounce dead,
    // and the bounce wiped out the magnification. Disjoint properties,
    // so they compose correctly once they stop sharing a slot.
    _bounceCycle(shouldContinue) {
        if (!this.get_stage())
            return;
        // Read per cycle rather than cached: the icon-size preference can
        // change between one bounce and the next.
        const height = Math.round((this.icon?.iconSize ?? 48) * BOUNCE_RATIO);
        animateSpring(this, { translation_y: 0 }, { translation_y: -height }, {
            duration: 160, preset: SPRING.ITEM, id: 'bounce',
            onComplete: () => {
                animateSpring(this, { translation_y: -height }, { translation_y: 0 }, {
                    duration: 160, preset: SPRING.ITEM, id: 'bounce',
                    onComplete: () => {
                        if (shouldContinue())
                            this._bounceCycle(shouldContinue);
                    },
                });
            },
        });
    }

    /**
     * Sizes and positions the running indicator. GNOME's own
     * `.app-grid-running-dot` is a fixed 5px pure-white dot offset 6px,
     * calibrated for the app grid; macOS scales its dot with the icon and
     * puts it further down, clear of the icon's foot. Those are per-icon-
     * size numbers, which St's CSS cannot express, so DockManager pushes
     * them in as an inline style — the colour stays in the stylesheet
     * because that one flips with the light/dark scheme.
     *
     * Setting the style is what makes this work at all: `offset-y` is a
     * custom St property AppIcon reads back off the dot's theme node from
     * a 'style-changed' handler (_updateDotStyle in GNOME's appDisplay.js)
     * and applies as a translation, and set_style() is what emits that.
     */
    setDotStyle(style) {
        this._dot?.set_style(style);
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
