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
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Shell from 'gi://Shell';
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { animateSpring, SPRING } from './animations.js';
import { openWithApp } from './utils.js';

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
        // Filled in by DockManager. `removeAction` is what backs the
        // "Remover da Dock" item on icons that are only present because the
        // app was used recently; `progress` is the Unity LauncherEntry
        // progress bar (see setProgress).
        this.removeAction = null;
        this._removeItem = null;
        this._progressTrack = null;
        this._progressFill = null;
        this._progress = -1;

        // AppIcon's own base class already listens for 'notify::state' to
        // show/hide the running dot — this is an additional, independent
        // listener for the same signal, just for the launch bounce.
        this.app.connectObject('notify::state', () => this._onStateChanged(), this);
    }

    /**
     * macOS lets you take any Dock icon off the Dock, including one that is
     * only there because you happened to launch the app — the recents
     * section is not a read-only shelf. Ours had no way to do that at all:
     * the app was not pinned, so "Unpin" (GNOME's own item) was hidden, and
     * nothing else removed it from our recents queue.
     *
     * AppMenu builds itself once and is then reused, so the item is added
     * on the menu's first construction and its visibility re-evaluated on
     * every popup — `removeAction` is null for pinned and running apps,
     * which is exactly when the item should not be offered.
     */
    popupMenu() {
        const result = super.popupMenu();
        if (this._menu && !this._removeItem) {
            this._removeItem = this._menu.addAction(_('Remove from Dock'), () => {
                this.removeAction?.();
            });
        }
        if (this._removeItem)
            this._removeItem.visible = !!this.removeAction;
        return result;
    }

    /**
     * A real 0..1 progress bar across the icon's foot, the way the macOS
     * Dock draws one for an app that reports progress. Driven by the
     * `com.canonical.Unity.LauncherEntry` D-Bus protocol (see
     * modules/launcherEntry.js) — the standard, app-published channel on
     * this desktop, and the only one that carries a genuine total. Pass a
     * negative value to hide it.
     */
    setProgress(fraction) {
        if (fraction === this._progress)
            return;
        this._progress = fraction;

        if (fraction < 0) {
            this._progressTrack?.hide();
            return;
        }

        if (!this._progressTrack) {
            // Built lazily: the overwhelming majority of dock icons never
            // report progress, and an always-present pair of hidden actors
            // on each of them is pure allocation for nothing.
            this._progressTrack = new St.Widget({
                style_class: 'macos-dock-progress-track',
                layout_manager: new Clutter.BinLayout(),
            });
            this._progressFill = new St.Widget({
                style_class: 'macos-dock-progress-fill',
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.FILL,
            });
            this._progressTrack.add_child(this._progressFill);
            this.add_child(this._progressTrack);
        }

        const size = this.icon?.iconSize ?? 48;
        const width = Math.round(size * 0.86);
        const height = Math.max(4, Math.round(size * 0.13));
        this._progressTrack.set_size(width, height);
        this._progressTrack.set_position(
            Math.round((this.width - width) / 2), Math.round(this.height - height));
        this._progressFill.set_width(
            Math.max(1, Math.round((width - 2) * Math.min(1, Math.max(0, fraction)))));
        this._progressFill.set_position(1, 1);
        this._progressFill.set_height(Math.max(1, height - 2));
        this._progressTrack.show();
    }

    /**
     * Dropping a file on an app icon opens it with that app, which is what
     * the macOS Dock does. Returning MOVE_DROP/COPY_DROP here is also what
     * makes ui/dnd.js draw the drop feedback while the pointer is over us.
     */
    handleDragOver(source) {
        // CONTINUE for anything that isn't a file from an open stack, so
        // ui/dnd.js keeps walking up to _appsBox — which is what implements
        // drag-to-reorder. Returning anything else here would swallow the
        // reorder drag at the first icon it passed over.
        if (!source?.stackEntryUri)
            return DND.DragMotionResult.CONTINUE;
        this.add_style_class_name('macos-dock-drop-target');
        return DND.DragMotionResult.COPY_DROP;
    }

    acceptDrop(source) {
        this.clearDropFeedback();
        if (!source?.stackEntryUri)
            return false;
        openWithApp(this.app, source.stackEntryUri);
        return true;
    }

    clearDropFeedback() {
        this.remove_style_class_name('macos-dock-drop-target');
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
});
