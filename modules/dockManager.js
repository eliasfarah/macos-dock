/* dockManager.js
 *
 * Orchestrates the persistent macOS-style dock: builds the glass bar,
 * keeps it anchored to the bottom of the primary monitor, and renders
 * one DockAppIcon per pinned/running app (folder-stacks and everything
 * else in the plan join in later phases).
 *
 * Every source that can trigger a rebuild (AppFavorites changing,
 * apps launching/quitting) is funneled through one coalesced
 * _queueRedisplay() rather than rebuilding synchronously per signal —
 * the same debounce discipline this codebase already needed for the
 * prefs.js rename field and the old DockIntegration, now more
 * important since our own writes (future DnD reorder) could otherwise
 * retrigger the same listener.
 */

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Shell from 'gi://Shell';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';

import { createGlassPanel } from './glass.js';
import { clamp, getActorGeometry } from './utils.js';
import { animateSpring, SPRING } from './animations.js';
import { DockAppIcon } from './dockAppIcon.js';
import { DockFolderIcon } from './dockFolderIcon.js';
import { createDockSeparator } from './dockSeparator.js';
import { DockTrashIcon } from './dockTrashIcon.js';

const DOCK_RADIUS = 20;
const DOCK_MIN_WIDTH = 120;
const DOCK_VERTICAL_PADDING = 12;
const DOCK_HORIZONTAL_PADDING = 12;
const MAX_BLUR_RADIUS = 60; // matches stack.js's own ceiling for the same setting

export class DockManager {
    constructor(settings, onActivateFolder) {
        this._settings = settings;
        this._onActivateFolder = onActivateFolder;

        this._dockActor = null;
        this._content = null;
        this._iconBox = null;
        this._appsBox = null;
        this._stacksBox = null;
        this._trashIcon = null;

        this._appIcons = new Map(); // appId -> DockAppIcon
        this._stackIcons = new Map(); // stack id -> DockFolderIcon
        this._redisplayIdle = 0;

        this._appSystem = Shell.AppSystem.get_default();
        this._favorites = AppFavorites.getAppFavorites();

        this._objectSignals = []; // { object, id }
        this._monitorsChangedId = 0;
        this._stacksChangedId = 0;

        this._magnifyMotionId = 0;
        this._magnifyLeaveId = 0;

        this._dragIcon = null;
        this._dragBox = null;
        this._dragMonitor = null;
    }

    enable() {
        this._buildChrome();
        this._connectSignals();
        this._enableMagnification();
        this._queueRedisplay();
    }

    disable() {
        this._disableMagnification();
        this._disconnectSignals();

        if (this._dragMonitor) {
            DND.removeDragMonitor(this._dragMonitor);
            this._dragMonitor = null;
        }

        if (this._redisplayIdle) {
            GLib.Source.remove(this._redisplayIdle);
            this._redisplayIdle = 0;
        }

        for (const icon of this._appIcons.values())
            icon.destroy();
        this._appIcons.clear();

        for (const icon of this._stackIcons.values())
            icon.destroy();
        this._stackIcons.clear();

        this._destroyChrome();
    }

    // -- chrome ----------------------------------------------------------

    _buildChrome() {
        // clipContent: false — a magnified icon needs to overflow above
        // the dock bar's own rectangle (see glass.js), not be clipped to
        // it the way the Stack panel's item grid is.
        const { panel, content, blurEffect } = createGlassPanel({ cornerRadius: DOCK_RADIUS, clipContent: false });
        this._dockActor = panel;
        this._content = content;
        this._dockActor.set({ reactive: true });

        // Unlike the Stack panel (which animates blur in on open),
        // the dock is always visible, so its blur radius is just set
        // once from the existing blur-intensity preference rather than
        // driven by an open/close spring.
        blurEffect.radius = (this._settings.blurIntensity / 100) * MAX_BLUR_RADIUS;

        // Three sections in one row — apps, folder-stacks (empty until a
        // later phase wires them in), and a trailing trash icon — each
        // its own inner BoxLayout so items within a section can be
        // added/removed/reordered without touching the others, and a
        // separator sits between sections even while one is empty, so
        // the layout reads consistently as sections fill in.
        this._iconBox = new St.BoxLayout({
            vertical: false,
            reactive: true, // needed to receive motion-event for magnification
            style_class: 'macos-dock-icon-box',
            x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._content.add_child(this._iconBox);

        this._appsBox = new St.BoxLayout({ vertical: false });
        this._stacksBox = new St.BoxLayout({ vertical: false });
        this._trashIcon = new DockTrashIcon(this._settings.dockIconSize);
        this._trashIcon.set_pivot_point(0.5, 1); // grow upward from the dock's baseline

        this._iconBox.add_child(this._appsBox);
        this._iconBox.add_child(createDockSeparator());
        this._iconBox.add_child(this._stacksBox);
        this._iconBox.add_child(createDockSeparator());
        this._iconBox.add_child(this._trashIcon);

        Main.layoutManager.addChrome(this._dockActor, {
            affectsStruts: !this._settings.dockAutohide,
            trackFullscreen: true,
        });

        this._monitorsChangedId = Main.layoutManager.connect(
            'monitors-changed', () => this._layoutDock());

        this._layoutDock();
    }

    _destroyChrome() {
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }
        // Destroying a tracked chrome actor auto-untracks it (layout.js
        // connects its own 'destroy' handler when addChrome() is called),
        // so no explicit untrackChrome() call is needed here.
        this._dockActor?.destroy();
        this._dockActor = null;
        this._content = null;
        this._iconBox = null;
        this._appsBox = null;
        this._stacksBox = null;
        this._trashIcon = null;
    }

    _layoutDock() {
        if (!this._dockActor)
            return;

        const monitorIndex = Main.layoutManager.primaryIndex;
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
        const margin = this._settings.dockEdgeMargin;

        // Measure the icon row itself, not the panel actor: the panel's
        // own get_preferred_width() goes through two nested BinLayout
        // levels (panel -> content), and BinLayout reports the *max* of
        // its overlapping children's preferred sizes — the blur/tint/
        // sheen/border layers are all x_expand with no intrinsic size of
        // their own, so that max collapses to something far smaller than
        // what the icon row actually needs (confirmed live: 202px
        // reported vs. 684px actually required for 6 icons) and the
        // panel's own clip_to_allocation then silently hides every icon
        // past that too-narrow width.
        const [, naturalWidth] = this._iconBox.get_preferred_width(-1);
        const width = clamp(naturalWidth, DOCK_MIN_WIDTH, workArea.width - margin * 2);
        const height = this._settings.dockIconSize + DOCK_VERTICAL_PADDING * 2;

        const x = workArea.x + (workArea.width - width) / 2;
        const y = workArea.y + workArea.height - height - margin;

        this._dockActor.set_position(Math.round(x), Math.round(y));
        this._dockActor.set_size(Math.round(width), Math.round(height));
    }

    // -- live updates ------------------------------------------------------

    _connectSignals() {
        this._objectSignals.push(
            { object: this._favorites, id: this._favorites.connect('changed', () => this._queueRedisplay()) },
            { object: this._appSystem, id: this._appSystem.connect('installed-changed', () => this._queueRedisplay()) },
            { object: this._appSystem, id: this._appSystem.connect('app-state-changed', () => this._queueRedisplay()) },
        );
        this._stacksChangedId = this._settings.connectChanged((_s, key) => {
            if (key === 'stacks')
                this._queueRedisplay();
        });

        this._objectSignals.push({
            object: global.display,
            id: global.display.connect('window-demands-attention', (_display, window) => {
                this._onWindowDemandsAttention(window);
            }),
        });

        // The Overview shows its own native Dash in roughly the same
        // screen area — without this, our persistent dock would sit on
        // top of (or behind) it, competing visually the moment the app
        // grid/Activities opens. Hide while the Overview is up, reveal
        // again as it starts closing.
        this._objectSignals.push(
            { object: Main.overview, id: Main.overview.connect('showing', () => this._dockActor?.hide()) },
            { object: Main.overview, id: Main.overview.connect('hiding', () => this._dockActor?.show()) },
        );
    }

    _onWindowDemandsAttention(window) {
        const icon = this._iconForWindow(window);
        icon?.attentionBounce();
    }

    _iconForWindow(window) {
        const tracker = Shell.WindowTracker.get_default();
        const app = tracker.get_window_app(window);
        return app && this._appIcons.get(app.get_id());
    }

    // Used by MinimizeEffectManager to find the genie effect's target
    // point — null (falling back to the default minimize effect) if the
    // window's app has no icon currently on the dock.
    getIconGeometryForWindow(window) {
        const icon = this._iconForWindow(window);
        return icon ? getActorGeometry(icon) : null;
    }

    _disconnectSignals() {
        for (const { object, id } of this._objectSignals)
            object.disconnect(id);
        this._objectSignals = [];

        this._settings.disconnectChanged(this._stacksChangedId);
        this._stacksChangedId = 0;
    }

    _queueRedisplay() {
        if (this._redisplayIdle)
            return;
        this._redisplayIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._redisplayIdle = 0;
            this._redisplay();
            return GLib.SOURCE_REMOVE;
        });
    }

    _redisplay() {
        if (!this._appsBox)
            return;

        this._redisplayApps();
        this._redisplayStacks();
        this._layoutDock();
    }

    _redisplayApps() {
        // Favorites first (in their configured order), then running-but-
        // unfavorited apps appended — and existing icons are repositioned
        // rather than rebuilt, so apps already on the dock never visibly
        // jump around when an unrelated app launches or quits.
        const orderedApps = [...this._favorites.getFavorites()];
        const wantedIds = new Set(orderedApps.map(app => app.get_id()));
        for (const app of this._appSystem.get_running()) {
            if (!wantedIds.has(app.get_id())) {
                orderedApps.push(app);
                wantedIds.add(app.get_id());
            }
        }

        for (const [appId, icon] of this._appIcons) {
            if (!wantedIds.has(appId)) {
                icon.destroy();
                this._appIcons.delete(appId);
            }
        }

        const iconSize = this._settings.dockIconSize;
        orderedApps.forEach((app, index) => {
            const appId = app.get_id();
            let icon = this._appIcons.get(appId);
            if (!icon) {
                icon = new DockAppIcon(app);
                icon.icon.setIconSize(iconSize);
                icon.set_pivot_point(0.5, 1); // grow upward from the dock's baseline
                this._appIcons.set(appId, icon);
                this._appsBox.insert_child_at_index(icon, index);
                this._wireDraggable(icon, this._appsBox);
            } else {
                this._appsBox.set_child_at_index(icon, index);
            }
        });
    }

    _redisplayStacks() {
        const configs = this._settings.getStacks();
        const wantedIds = new Set(configs.map(c => c.id));

        for (const [id, icon] of this._stackIcons) {
            if (!wantedIds.has(id)) {
                icon.destroy();
                this._stackIcons.delete(id);
            }
        }

        const iconSize = this._settings.dockIconSize;
        configs.forEach((config, index) => {
            let icon = this._stackIcons.get(config.id);
            if (!icon) {
                icon = new DockFolderIcon(config, iconSize, this._onActivateFolder);
                icon.set_pivot_point(0.5, 1); // grow upward from the dock's baseline
                this._stackIcons.set(config.id, icon);
                this._stacksBox.insert_child_at_index(icon, index);
                this._wireDraggable(icon, this._stacksBox);
            } else {
                icon.setConfig(config);
                this._stacksBox.set_child_at_index(icon, index);
            }
        });
    }

    // -- hover magnification ------------------------------------------------
    //
    // A Gaussian falloff around the pointer's x position, applied to every
    // icon currently on the dock (apps + trash; folder-stacks join once
    // Phase 4 populates _stacksBox). Scale-in-place only (pivot at the
    // bottom center) — no neighbor-displacement, which would need live
    // set_position() math on every pointer move and reopen exactly the
    // Clutter.BinLayout-ignores-set_position bug class this project
    // already hit once in stack.js.

    _enableMagnification() {
        if (!this._settings.dockMagnificationEnabled || !this._iconBox)
            return;
        this._magnifyMotionId = this._iconBox.connect('motion-event', (_actor, event) => {
            this._updateMagnification(event);
            return Clutter.EVENT_PROPAGATE;
        });
        this._magnifyLeaveId = this._iconBox.connect('leave-event', () => {
            this._resetMagnification();
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _disableMagnification() {
        if (this._magnifyMotionId) {
            this._iconBox.disconnect(this._magnifyMotionId);
            this._magnifyMotionId = 0;
        }
        if (this._magnifyLeaveId) {
            this._iconBox.disconnect(this._magnifyLeaveId);
            this._magnifyLeaveId = 0;
        }
    }

    _magnifiableIcons() {
        const icons = [...this._appIcons.values(), ...this._stackIcons.values()];
        if (this._trashIcon)
            icons.push(this._trashIcon);
        return icons;
    }

    _updateMagnification(event) {
        const [stageX] = event.get_coords();
        const amount = this._settings.dockMagnificationAmount;
        const range = this._settings.dockMagnificationRange;

        for (const icon of this._magnifiableIcons()) {
            const geometry = getActorGeometry(icon);
            const distance = stageX - geometry.centerX;
            const scale = 1 + (amount - 1) * Math.exp(-(distance * distance) / (2 * range * range));

            // A 'motion-event' fires many times per second, and every
            // animateSpring() call restarts the underdamped spring's
            // clock from t=0 (cancelSpring + a brand-new Timeline) — with
            // near-continuous small target changes, the icon kept
            // replaying only the curve's slow initial ramp and never
            // reached its snappier back half, which reads as slow-motion
            // rather than live tracking. Skipping re-targets that aren't
            // a meaningful change lets each spring actually run long
            // enough to be felt as motion, not just restarted.
            const lastTarget = icon._magnifyTarget ?? 1;
            if (Math.abs(scale - lastTarget) < 0.02)
                continue;
            icon._magnifyTarget = scale;

            // Re-targets from the icon's current (possibly mid-animation)
            // scale rather than resetting to 1 first, so continuous pointer
            // movement reads as smooth tracking, not a jump each frame.
            animateSpring(icon,
                { scale_x: icon.scale_x, scale_y: icon.scale_y },
                { scale_x: scale, scale_y: scale },
                { duration: 160, preset: SPRING.MAGNIFY });
        }
    }

    _resetMagnification() {
        for (const icon of this._magnifiableIcons()) {
            icon._magnifyTarget = 1;
            animateSpring(icon,
                { scale_x: icon.scale_x, scale_y: icon.scale_y },
                { scale_x: 1, scale_y: 1 },
                { duration: 200, preset: SPRING.MAGNIFY });
        }
    }

    // -- drag-to-reorder -----------------------------------------------------
    //
    // Both DockAppIcon (via AppViewItem's own DND.makeDraggable) and
    // DockFolderIcon (wired directly, see dockFolderIcon.js) expose a
    // `_draggable` — a generic ui/dnd.js Draggable, not tied to the
    // Overview. We track begin/end per icon and use DND.addDragMonitor
    // for live position feedback while a drag is in progress, rather than
    // reimplementing native Dash's private placeholder-actor machinery
    // (a full animated insertion-gap preview), per the research's
    // explicit recommendation to reimplement against the generic, stable
    // dnd.js API instead of copying Dash's private reorder internals.

    _wireDraggable(icon, box) {
        if (!icon._draggable)
            return;
        icon._draggable.connectObject(
            'drag-begin', () => this._onIconDragBegin(icon, box),
            'drag-end', () => this._onIconDragEnd(box),
            'drag-cancelled', () => this._onIconDragEnd(box),
            icon);
    }

    _onIconDragBegin(icon, box) {
        this._dragIcon = icon;
        this._dragBox = box;
        this._dragMonitor = { dragMotion: this._onDragMotion.bind(this) };
        DND.addDragMonitor(this._dragMonitor);
    }

    _onDragMotion(dragEvent) {
        if (!this._dragBox || !this._dragIcon || !this._dragBox.contains(dragEvent.targetActor))
            return DND.DragMotionResult.CONTINUE;

        const [boxX] = this._dragBox.get_transformed_position();
        const localX = dragEvent.x - boxX;

        const children = this._dragBox.get_children();
        let insertIndex = children.length;
        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            if (child === this._dragIcon)
                continue;
            const [childX] = child.get_transformed_position();
            const childCenter = (childX - boxX) + child.width / 2;
            if (localX < childCenter) {
                insertIndex = i;
                break;
            }
        }

        this._dragBox.set_child_at_index(this._dragIcon, insertIndex);
        return DND.DragMotionResult.MOVE_DROP;
    }

    _onIconDragEnd(box) {
        if (this._dragMonitor) {
            DND.removeDragMonitor(this._dragMonitor);
            this._dragMonitor = null;
        }
        this._commitReorder(box);
        this._dragIcon = null;
        this._dragBox = null;
    }

    _commitReorder(box) {
        if (box === this._appsBox) {
            // Only the favorited prefix of the list has anywhere
            // persistent to write to — a running-but-unfavorited app
            // dragged around previews visually but snaps back to its
            // natural place on the next redisplay, since there's no
            // concept of a saved position for it.
            const favoriteIds = new Set(this._favorites.getFavorites().map(a => a.get_id()));
            let pos = 0;
            for (const child of this._appsBox.get_children()) {
                const appId = child.app?.get_id();
                if (appId && favoriteIds.has(appId)) {
                    this._favorites.moveFavoriteToPos(appId, pos);
                    pos += 1;
                }
            }
        } else if (box === this._stacksBox) {
            const ordered = this._stacksBox.get_children()
                .map(child => child.config)
                .filter(Boolean);
            this._settings.setStacks(ordered);
        }
    }
}
