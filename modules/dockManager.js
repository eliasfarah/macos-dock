/* dockManager.js
 *
 * Orchestrates the persistent macOS-style dock: builds the glass bar,
 * keeps it anchored to the bottom of the primary monitor, and renders
 * the icon row (show-apps launcher, pinned/running apps, folder-stacks,
 * trash) plus hover magnification, tooltips, autohide, the dock's own
 * context menu and drag-to-reorder/unpin.
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
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { createGlassPanel } from './glass.js';
import { clamp, getActorGeometry } from './utils.js';
import { animateSpring, cancelSpring, SPRING } from './animations.js';
import { DockAppIcon } from './dockAppIcon.js';
import { DockFolderIcon } from './dockFolderIcon.js';
import { createDockSeparator } from './dockSeparator.js';
import { DockTrashIcon } from './dockTrashIcon.js';
import { DockShowAppsIcon } from './dockShowAppsIcon.js';

const DOCK_RADIUS = 20;
const DOCK_MIN_WIDTH = 120;
const DOCK_VERTICAL_PADDING = 12;
const MAX_BLUR_RADIUS = 60; // matches stack.js's own ceiling for the same setting
const AUTOHIDE_TRIGGER_HEIGHT = 2; // reveal band pinned to the screen edge
const UNPIN_DROP_MARGIN = 60; // how far past the dock a drop must land to unpin
const AUTOHIDE_DELAY = 350; // ms the pointer must stay away before re-hiding
const TOOLTIP_GAP = 10; // gap between an icon's top and its tooltip

export class DockManager {
    constructor(settings, onActivateFolder, onOpenPreferences) {
        this._settings = settings;
        this._onActivateFolder = onActivateFolder;
        this._onOpenPreferences = onOpenPreferences;

        this._dockActor = null;
        this._content = null;
        this._iconBox = null;
        this._appsBox = null;
        this._stacksBox = null;
        this._trashIcon = null;
        this._showAppsIcon = null;
        this._strutActor = null;
        this._sepStacks = null;
        this._sepRunning = null;

        this._contextMenu = null;
        this._contextMenuManager = null;

        this._appIcons = new Map(); // appId -> DockAppIcon
        this._stackIcons = new Map(); // stack id -> DockFolderIcon
        this._redisplayIdle = 0;

        this._appSystem = Shell.AppSystem.get_default();
        this._favorites = AppFavorites.getAppFavorites();

        this._objectSignals = []; // { object, id }
        this._monitorsChangedId = 0;
        this._settingsChangedId = 0;

        this._magnifyMotionId = 0;
        this._magnifyLeaveId = 0;
        this._dockBaseX = null;
        this._dockBaseWidth = null;
        this._dockTargetWidth = null;

        this._tooltip = null;
        this._tooltipIcon = null;

        this._autohideStrip = null;
        this._autohideTimeoutId = 0;
        this._dockHidden = false;

        this._dragIcon = null;
    }

    enable() {
        this._buildChrome();
        this._connectSignals();
        this._hideNativeDash();
        this._enableMagnification();
        this._queueRedisplay();
    }

    disable() {
        this._restoreNativeDash();
        this._disableMagnification();
        this._disconnectSignals();

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
        const { panel, content, blurEffect } = createGlassPanel({
            cornerRadius: DOCK_RADIUS,
            clipContent: false,
            variant: 'macos-dock-panel',
        });
        this._dockActor = panel;
        this._content = content;
        this._dockActor.set({ reactive: true });

        // Unlike the Stack panel (which animates blur in on open),
        // the dock is always visible, so its blur radius is just set
        // once from the existing blur-intensity preference rather than
        // driven by an open/close spring.
        blurEffect.radius = (this._settings.blurIntensity / 100) * MAX_BLUR_RADIUS;

        // Four sections in one row — a "show apps" launcher, pinned/
        // running apps, folder-stacks (empty until configured), and a
        // trailing trash icon — each its own inner BoxLayout so items
        // within a section can be added/removed/reordered without
        // touching the others. this._sepStacks is kept visible only
        // while stacksBox actually has children (see _redisplayStacks)
        // so an empty Stacks section doesn't read as a doubled-up
        // separator butted against the apps/trash one.
        this._iconBox = new St.BoxLayout({
            vertical: false,
            reactive: true, // needed to receive motion-event for magnification
            style_class: 'macos-dock-icon-box',
            x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._content.add_child(this._iconBox);

        this._showAppsIcon = new DockShowAppsIcon(this._settings.dockIconSize);
        this._showAppsIcon.set_pivot_point(0.5, 1); // grow upward from the dock's baseline
        this._appsBox = new St.BoxLayout({ vertical: false });
        this._stacksBox = new St.BoxLayout({ vertical: false });
        // Divides pinned apps from merely-running ones; lives inside
        // appsBox and is repositioned/hidden by _redisplayApps.
        this._sepRunning = createDockSeparator();
        this._appsBox.add_child(this._sepRunning);
        this._trashIcon = new DockTrashIcon(this._settings.dockIconSize);
        this._trashIcon.set_pivot_point(0.5, 1); // grow upward from the dock's baseline

        this._trackTooltip(this._showAppsIcon, () => 'Aplicativos');
        this._trackTooltip(this._trashIcon, () => 'Lixeira');

        this._iconBox.add_child(this._showAppsIcon);
        this._iconBox.add_child(createDockSeparator());
        this._iconBox.add_child(this._appsBox);
        this._iconBox.add_child(createDockSeparator());
        this._sepStacks = createDockSeparator();
        this._iconBox.add_child(this._stacksBox);
        this._iconBox.add_child(this._sepStacks);
        this._iconBox.add_child(this._trashIcon);

        // A floating, content-sized bar (centered, with a margin on
        // every side) never touches a full screen edge, which is what
        // Main.layoutManager's own strut algorithm requires before it
        // will reserve any space for windows (see ui/layout.js's
        // _updateRegions(): it only creates a strut when the tracked
        // actor's rect spans the *entire* width or height of the
        // monitor along the edge it's touching — confirmed by reading
        // the actual GNOME Shell 50 source). So the visible glass bar
        // itself never produces a strut no matter what affectsStruts is
        // set to here. A second, invisible actor spanning the full
        // monitor width down to the real screen edge is tracked instead
        // (see _layoutDock/_updateStrutTracking) purely to reserve the
        // space; it never paints and is reactive:false so it can never
        // intercept a click.
        this._strutActor = new Clutter.Actor({ opacity: 0, reactive: false });

        Main.layoutManager.addChrome(this._dockActor, {
            affectsStruts: false,
            trackFullscreen: true,
        });
        this._trackStrutActor();

        this._monitorsChangedId = Main.layoutManager.connect(
            'monitors-changed', () => this._layoutDock());

        this._buildContextMenu();
        this._buildTooltip();

        this._dockActor.connect('enter-event', () => {
            this._cancelScheduledHide();
            return Clutter.EVENT_PROPAGATE;
        });
        this._dockActor.connect('leave-event', () => {
            this._hideTooltip();
            this._scheduleHide();
            return Clutter.EVENT_PROPAGATE;
        });

        this._installDropTargets();

        this._layoutDock();
        this._updateAutohide();
    }

    _trackStrutActor() {
        Main.layoutManager.addChrome(this._strutActor, {
            affectsStruts: !this._settings.dockAutohide,
        });
    }

    // affectsStruts is baked in at addChrome()/_trackActor() time in
    // ui/layout.js — there's no live setter for it on an already-tracked
    // actor, so toggling dock-autohide at runtime has to untrack and
    // re-track the strut actor with fresh params.
    _updateStrutTracking() {
        if (!this._strutActor)
            return;
        Main.layoutManager.removeChrome(this._strutActor);
        this._trackStrutActor();
        this._layoutDock();
    }

    // -- tooltips -----------------------------------------------------------
    //
    // macOS names the icon you're pointing at, in a small label floating
    // just above the dock. One shared label is reused for every icon
    // rather than one per icon: the text is only ever needed for the
    // single icon currently under the pointer.

    _buildTooltip() {
        this._tooltip = new St.Label({ style_class: 'macos-dock-tooltip', opacity: 0 });
        this._tooltip.hide();
        Main.layoutManager.addChrome(this._tooltip);
    }

    _trackTooltip(icon, getLabel) {
        icon.connect('notify::hover', () => {
            if (icon.hover)
                this._showTooltip(icon, getLabel());
            else if (this._tooltipIcon === icon)
                this._hideTooltip();
        });
        icon.connect('destroy', () => {
            if (this._tooltipIcon === icon)
                this._hideTooltip();
        });
    }

    _showTooltip(icon, text) {
        if (!this._tooltip || !text || this._dockHidden)
            return;

        this._tooltipIcon = icon;
        this._tooltip.text = text;
        this._tooltip.show();
        this._positionTooltip();

        animateSpring(this._tooltip, { opacity: this._tooltip.opacity }, { opacity: 255 },
            { duration: 140, preset: SPRING.SOFT, id: 'tooltip' });
    }

    // Re-run on every magnification step, not just once on hover: the
    // icon under the pointer is simultaneously growing upward (bottom-
    // centre pivot), so a label placed once at hover time would end up
    // overlapping the icon it names as that icon rises past it.
    _positionTooltip() {
        const icon = this._tooltipIcon;
        if (!icon || !this._tooltip?.visible)
            return;

        // Measured after the text is set, so the label is centred on the
        // icon using its real width rather than a stale one.
        const [iconX, iconY] = icon.get_transformed_position();
        const [iconWidth] = icon.get_transformed_size();
        const [, tooltipWidth] = this._tooltip.get_preferred_width(-1);
        const [, tooltipHeight] = this._tooltip.get_preferred_height(-1);

        const monitor = Main.layoutManager.monitors[Main.layoutManager.primaryIndex];
        let x = iconX + iconWidth / 2 - tooltipWidth / 2;
        if (monitor)
            x = clamp(x, monitor.x + 4, monitor.x + monitor.width - tooltipWidth - 4);

        this._tooltip.set_position(Math.round(x), Math.round(iconY - tooltipHeight - TOOLTIP_GAP));
    }

    _hideTooltip() {
        this._tooltipIcon = null;
        if (!this._tooltip)
            return;
        animateSpring(this._tooltip, { opacity: this._tooltip.opacity }, { opacity: 0 },
            { duration: 120, preset: SPRING.SOFT, id: 'tooltip', onComplete: () => this._tooltip?.hide() });
    }

    // -- autohide -----------------------------------------------------------
    //
    // The dock-autohide preference used to do nothing but switch struts
    // off: the dock stayed fully visible, it just stopped reserving
    // space, so turning the setting on looked broken. This is the
    // actual macOS behaviour — the bar slides off the bottom edge and
    // comes back when the pointer reaches that edge.

    _updateAutohide() {
        if (!this._dockActor)
            return;

        if (this._settings.dockAutohide) {
            this._ensureAutohideStrip();
            this._hideDock();
        } else {
            this._destroyAutohideStrip();
            this._revealDock();
        }
    }

    _ensureAutohideStrip() {
        if (this._autohideStrip)
            return;

        // A thin, invisible reactive band pinned to the very bottom of
        // the monitor. Kept separate from the dock itself because the
        // dock is off-screen while hidden and so can't be what detects
        // the pointer arriving.
        this._autohideStrip = new Clutter.Actor({ reactive: true, opacity: 0 });
        Main.layoutManager.addChrome(this._autohideStrip);
        this._autohideStrip.connect('enter-event', () => {
            this._revealDock();
            return Clutter.EVENT_PROPAGATE;
        });
        this._layoutAutohideStrip();
    }

    _destroyAutohideStrip() {
        this._autohideStrip?.destroy();
        this._autohideStrip = null;
    }

    _layoutAutohideStrip() {
        if (!this._autohideStrip)
            return;
        const monitor = Main.layoutManager.monitors[Main.layoutManager.primaryIndex];
        if (!monitor)
            return;
        this._autohideStrip.set_position(monitor.x, monitor.y + monitor.height - AUTOHIDE_TRIGGER_HEIGHT);
        this._autohideStrip.set_size(monitor.width, AUTOHIDE_TRIGGER_HEIGHT);
    }

    _hideDock() {
        this._cancelScheduledHide();
        if (!this._dockActor || this._dockHidden)
            return;
        this._dockHidden = true;

        // Slid down by its own full height plus the edge margin, so no
        // sliver is left poking above the screen edge at any margin
        // setting.
        const offset = this._dockActor.height + this._settings.dockEdgeMargin + AUTOHIDE_TRIGGER_HEIGHT;
        animateSpring(this._dockActor,
            { translation_y: this._dockActor.translation_y },
            { translation_y: offset },
            { duration: 260, preset: SPRING.SOFT, id: 'autohide' });
    }

    _revealDock() {
        this._cancelScheduledHide();
        if (!this._dockActor || !this._dockHidden)
            return;
        this._dockHidden = false;

        animateSpring(this._dockActor,
            { translation_y: this._dockActor.translation_y },
            { translation_y: 0 },
            { duration: 260, preset: SPRING.SOFT, id: 'autohide' });
    }

    _scheduleHide() {
        if (!this._settings.dockAutohide || this._dockHidden)
            return;
        this._cancelScheduledHide();
        this._autohideTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, AUTOHIDE_DELAY, () => {
            this._autohideTimeoutId = 0;
            // Never yank the bar out from under an open menu, and never
            // while the pointer is still genuinely over it (a leave-event
            // also fires when the pointer merely crosses onto a child
            // actor).
            if (!this._contextMenu?.isOpen && !this._pointerOverDock())
                this._hideDock();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelScheduledHide() {
        if (this._autohideTimeoutId) {
            GLib.Source.remove(this._autohideTimeoutId);
            this._autohideTimeoutId = 0;
        }
    }

    _pointerOverDock() {
        if (!this._dockActor)
            return false;
        const [pointerX, pointerY] = global.get_pointer();
        const [x, y] = this._dockActor.get_transformed_position();
        const [width, height] = this._dockActor.get_transformed_size();
        return pointerX >= x && pointerX <= x + width &&
               pointerY >= y && pointerY <= y + height;
    }

    _buildContextMenu() {
        this._contextMenuManager = new PopupMenu.PopupMenuManager(this._dockActor);
        this._contextMenu = new PopupMenu.PopupMenu(this._dockActor, 0.5, St.Side.BOTTOM);
        this._contextMenu.addAction('Preferências da Dock…', () => this._onOpenPreferences?.());
        Main.uiGroup.add_child(this._contextMenu.actor);
        this._contextMenu.actor.hide();
        this._contextMenuManager.addMenu(this._contextMenu);

        this._dockActor.connect('button-press-event', (_actor, event) => {
            if (event.get_button() !== Clutter.BUTTON_SECONDARY)
                return Clutter.EVENT_PROPAGATE;
            // App icons run their own right-click menu off a
            // Clutter.ClickGesture, which does not consume the
            // underlying button-press-event — so without this check a
            // right-click on an app opened that app's menu *and* the
            // dock's menu stacked on top of each other. The dock menu
            // is for the dock's own empty chrome only.
            if (this._isOnIcon(event.get_source()))
                return Clutter.EVENT_PROPAGATE;
            this._contextMenu.toggle();
            return Clutter.EVENT_STOP;
        });
    }

    _isOnIcon(actor) {
        if (!actor)
            return false;
        return [this._appsBox, this._stacksBox, this._trashIcon, this._showAppsIcon]
            .some(container => container?.contains(actor));
    }

    _destroyChrome() {
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }

        this._cancelScheduledHide();
        this._destroyAutohideStrip();

        this._tooltip?.destroy();
        this._tooltip = null;
        this._tooltipIcon = null;

        this._contextMenu?.destroy();
        this._contextMenu = null;
        this._contextMenuManager = null;

        // Destroying a tracked chrome actor auto-untracks it (layout.js
        // connects its own 'destroy' handler when addChrome() is called),
        // so no explicit untrackChrome() call is needed here.
        this._strutActor?.destroy();
        this._strutActor = null;

        this._dockActor?.destroy();
        this._dockActor = null;
        this._content = null;
        this._iconBox = null;
        this._appsBox = null;
        this._stacksBox = null;
        this._sepStacks = null;
        this._sepRunning = null;
        this._trashIcon = null;
        this._showAppsIcon = null;
    }

    _layoutDock() {
        if (!this._dockActor)
            return;

        const monitorIndex = Main.layoutManager.primaryIndex;
        const monitor = Main.layoutManager.monitors[monitorIndex];
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

        // Deliberately anchored to the monitor's own fixed bottom edge,
        // NOT workArea.y + workArea.height. workArea already excludes
        // whatever struts are currently reserved — including our own
        // strut actor below. Deriving y from workArea would make the
        // dock's position a function of its own previous strut: if
        // _layoutDock() ever runs while the work area is momentarily
        // off (e.g. monitors still settling right after login, before
        // ui/layout.js's async struts recompute has caught up), the
        // strut it then reserves bakes in that bad y — which shrinks
        // the work area further, which produces an even worse y next
        // time. That runaway feedback loop is exactly what put the
        // whole dock up near the top of the screen on a real login
        // (never reproduced in headless testing, which only ever
        // exercised a single already-settled virtual monitor). The
        // monitor rect itself never depends on our strut, so anchoring
        // to it directly breaks the loop entirely.
        const bottom = monitor ? monitor.y + monitor.height : workArea.y + workArea.height;
        const y = bottom - height - margin;

        // Remembered as the "unmagnified" geometry so hover
        // magnification can widen the bar around it and return to it
        // afterwards without ever re-deriving it from the live (already
        // widened) actor.
        this._dockBaseX = Math.round(x);
        this._dockBaseWidth = Math.round(width);
        this._dockTargetWidth = this._dockBaseWidth;
        cancelSpring(this._dockActor, 'magnify-width');

        this._dockActor.set_position(Math.round(x), Math.round(y));
        this._dockActor.set_size(Math.round(width), Math.round(height));

        // The strut actor spans the monitor's *full* width and reaches
        // its literal bottom edge (not the work area's — struts are
        // measured against the real monitor rect, see ui/layout.js) so
        // it satisfies the "touches an entire edge" condition the strut
        // algorithm requires, regardless of how narrow/centered/margined
        // the visible dock bar itself is.
        if (this._strutActor && monitor) {
            const stripY = Math.round(y);
            const stripHeight = Math.round(monitor.y + monitor.height - stripY);
            this._strutActor.set_position(monitor.x, stripY);
            this._strutActor.set_size(monitor.width, Math.max(0, stripHeight));
        }

        this._layoutAutohideStrip();
    }

    // -- live updates ------------------------------------------------------

    _connectSignals() {
        this._objectSignals.push(
            { object: this._favorites, id: this._favorites.connect('changed', () => this._queueRedisplay()) },
            { object: this._appSystem, id: this._appSystem.connect('installed-changed', () => this._queueRedisplay()) },
            { object: this._appSystem, id: this._appSystem.connect('app-state-changed', () => this._queueRedisplay()) },
        );
        this._settingsChangedId = this._settings.connectChanged((_s, key) => this._onSettingChanged(key));

        this._objectSignals.push({
            object: global.display,
            id: global.display.connect('window-demands-attention', (_display, window) => {
                this._onWindowDemandsAttention(window);
            }),
        });

        // Our dock deliberately stays visible while the Overview is up.
        // It used to hide there and let GNOME's own Dash take over,
        // which meant the desktop effectively had two different docks
        // that swapped places — so the native one is suppressed instead
        // (see _hideNativeDash) and ours is simply always the dock.
    }

    // -- native Dash suppression --------------------------------------------
    //
    // We are a full dock replacement, so the Overview's built-in Dash is
    // redundant: leaving it in place meant one dock on the desktop and a
    // different one in the Overview.
    //
    // Hiding the actor alone is not enough. ControlsManagerLayout's
    // vfunc_allocate (ui/overviewControls.js) asks the Dash for its
    // preferred height on every allocation and subtracts that from the
    // space left for the workspaces and app grid — visibility never
    // enters into it, so a merely-hidden Dash still reserves its full
    // strip of empty screen at the bottom of the Overview. Pinning the
    // height to 0 makes that computation return 0 as well. The Dash
    // never sets its own height anywhere (verified against the real
    // dash.js), so nothing overwrites this later.

    _hideNativeDash() {
        const dash = Main.overview.dash;
        if (!dash)
            return;
        this._nativeDashWasVisible = dash.visible;
        dash.hide();
        dash.height = 0;
    }

    _restoreNativeDash() {
        const dash = Main.overview.dash;
        if (!dash)
            return;
        // -1 clears the fixed height and hands sizing back to the Dash's
        // own preferred-height logic.
        dash.set_height(-1);
        if (this._nativeDashWasVisible !== false)
            dash.show();
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

        this._settings.disconnectChanged(this._settingsChangedId);
        this._settingsChangedId = 0;
    }

    // Previously only the 'stacks' key was watched here — every other
    // dock-* preference (icon size, edge margin, autohide, magnification)
    // had a working GSettings default but no live effect at all once the
    // dock was already built: changing them in Preferences silently did
    // nothing until the next logout/login rebuilt everything from
    // scratch. That's the concrete bug behind "não consigo diminuir o
    // tamanho da dock" — there wasn't a missing feature so much as a
    // missing listener.
    _onSettingChanged(key) {
        switch (key) {
        case 'stacks':
            this._queueRedisplay();
            break;
        case 'dock-icon-size':
            this._applyIconSize();
            this._layoutDock();
            break;
        case 'dock-edge-margin':
            this._layoutDock();
            break;
        case 'dock-autohide':
            this._updateStrutTracking();
            this._updateAutohide();
            break;
        case 'dock-magnification-enabled':
            this._disableMagnification();
            this._enableMagnification();
            break;
        }
    }

    _applyIconSize() {
        const iconSize = this._settings.dockIconSize;
        for (const icon of this._appIcons.values())
            icon.icon.setIconSize(iconSize);
        for (const icon of this._stackIcons.values())
            icon.setIconSize(iconSize);
        this._trashIcon?.setIconSize(iconSize);
        this._showAppsIcon?.setIconSize(iconSize);
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
        const favoriteApps = this._favorites.getFavorites();
        const favoriteIds = new Set(favoriteApps.map(app => app.get_id()));
        const runningApps = this._appSystem.get_running()
            .filter(app => !favoriteIds.has(app.get_id()));

        const wantedIds = new Set([...favoriteIds, ...runningApps.map(app => app.get_id())]);
        for (const [appId, icon] of this._appIcons) {
            if (!wantedIds.has(appId)) {
                icon.destroy();
                this._appIcons.delete(appId);
            }
        }

        const iconSize = this._settings.dockIconSize;
        const iconFor = app => {
            const appId = app.get_id();
            let icon = this._appIcons.get(appId);
            if (!icon) {
                icon = new DockAppIcon(app);
                icon.icon.setIconSize(iconSize);
                icon.set_pivot_point(0.5, 1); // grow upward from the dock's baseline
                this._appIcons.set(appId, icon);
                this._appsBox.add_child(icon);
                this._wireDraggable(icon);
                this._trackTooltip(icon, () => app.get_name());
            }
            return icon;
        };

        // Pinned apps first, then a divider, then apps that are merely
        // running — the same split macOS draws, so "this app is pinned"
        // and "this app just happens to be open" stay visually distinct.
        // The divider collapses when either side is empty rather than
        // sitting against the row's end.
        let index = 0;
        for (const app of favoriteApps)
            this._appsBox.set_child_at_index(iconFor(app), index++);

        if (this._sepRunning) {
            this._sepRunning.visible = favoriteApps.length > 0 && runningApps.length > 0;
            this._appsBox.set_child_at_index(this._sepRunning, index++);
        }

        for (const app of runningApps)
            this._appsBox.set_child_at_index(iconFor(app), index++);
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
                this._wireDraggable(icon);
                this._trackTooltip(icon, () => icon.config.name);
            } else {
                icon.setConfig(config);
                this._stacksBox.set_child_at_index(icon, index);
            }
        });

        // Two separators permanently framed the Stacks section
        // (apps | stacks | trash) even when no stack was configured,
        // which with an empty stacksBox in between reads as one doubled-
        // up line rather than a single divider between apps and trash.
        if (this._sepStacks)
            this._sepStacks.visible = configs.length > 0;
    }

    // -- hover magnification ------------------------------------------------
    //
    // A Gaussian falloff around the pointer's x position, applied to every
    // icon currently on the dock (apps, folder-stacks, trash, show-apps).
    // Each icon scales in place (pivot at the bottom center) and is also
    // nudged sideways via translation_x — a transform, not set_position(),
    // so it doesn't fight the BoxLayout's own relayout the way a plain
    // position write would (see the Clutter.BinLayout-ignores-
    // set_position bug class this project already hit once in stack.js).

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
            this._iconBox?.disconnect(this._magnifyMotionId);
            this._magnifyMotionId = 0;
        }
        if (this._magnifyLeaveId) {
            this._iconBox?.disconnect(this._magnifyLeaveId);
            this._magnifyLeaveId = 0;
        }
        // Turning magnification off mid-hover would otherwise freeze
        // every icon at whatever scale/offset it had reached, with
        // nothing left listening to ever put them back.
        if (this._iconBox)
            this._resetMagnification();
    }

    _magnifiableIcons() {
        const icons = [];
        if (this._showAppsIcon)
            icons.push(this._showAppsIcon);
        icons.push(...this._appIcons.values(), ...this._stackIcons.values());
        if (this._trashIcon)
            icons.push(this._trashIcon);
        return icons;
    }

    _updateMagnification(event) {
        const [stageX] = event.get_coords();
        const amount = this._settings.dockMagnificationAmount;
        const range = this._settings.dockMagnificationRange;

        // Every icon's distance is measured from its RESTING centre, not
        // its current on-screen one. getActorGeometry() reports the
        // transformed position, which already includes the
        // translation_x this same function applied on the previous
        // pointer move — feeding that back in would make each icon's
        // computed distance depend on its own previous displacement,
        // i.e. the exact self-referential loop that put the whole dock
        // near the top of the screen when _layoutDock() derived its
        // position from a work area its own strut had shrunk. Here it
        // would show up as icons jittering or drifting under the
        // pointer instead of tracking it. Subtracting the live
        // translation_x is exact (the bottom-centre pivot means scaling
        // never moves centreX, only translation does), and works
        // mid-animation too.
        //
        // Sorted left-to-right because the neighbour-displacement maths
        // below is a running prefix sum, which only means anything
        // walked in visual order.
        const entries = this._magnifiableIcons()
            .map(icon => {
                const geometry = getActorGeometry(icon);
                return { icon, restingCenterX: geometry.centerX - icon.translation_x };
            })
            .sort((a, b) => a.restingCenterX - b.restingCenterX);

        for (const entry of entries) {
            const distance = stageX - entry.restingCenterX;
            entry.scale = 1 + (amount - 1) * Math.exp(-(distance * distance) / (2 * range * range));
        }

        // Scaling an icon in place (pivot at bottom-center) grows it
        // symmetrically left/right without the row's layout making any
        // room for that growth, so two adjacent magnified icons visually
        // collide/overlap — confirmed live via screenshots showing the
        // two stack icons stuck together on hover. Real macOS (and every
        // other dock-magnify implementation) compensates by nudging each
        // icon along X by half the accumulated "extra width" contributed
        // by every already-grown icon on its near side, and away from
        // every grown icon on its far side — a prefix-sum translation
        // computed fresh each call, applied as translation_x (a
        // transform, so it survives the BoxLayout relayout that would
        // otherwise fight a plain set_position() the way it already did
        // once in this codebase's grid/fan/stack item layout).
        let cumulativeExtra = 0;
        const extraBefore = [];
        for (const entry of entries) {
            extraBefore.push(cumulativeExtra);
            cumulativeExtra += entry.icon.width * (entry.scale - 1);
        }
        const totalExtra = cumulativeExtra;
        entries.forEach((entry, i) => {
            const extraOfSelf = entry.icon.width * (entry.scale - 1);
            const extraAfter = totalExtra - extraBefore[i] - extraOfSelf;
            entry.translation = 0.5 * (extraBefore[i] - extraAfter);
        });

        // Real macOS widens the dock's own bar as its icons grow, and
        // without that the outermost icons — pushed outward by the
        // displacement above — simply hang outside the glass, floating
        // on the desktop (the dock deliberately does not clip its
        // children, so a magnified icon can rise above the bar). Growing
        // the bar by exactly the accumulated extra width and re-centring
        // it keeps every icon on the glass. This cannot feed back into
        // the resting positions above: the icon row is centre-aligned,
        // so widening the panel by W while moving it left by W/2 leaves
        // the row's centre — and therefore every resting centre — exactly
        // where it was.
        this._applyDockWidth(this._dockBaseWidth + totalExtra);
        this._positionTooltip();

        for (const { icon, scale, translation } of entries) {
            // A 'motion-event' fires many times per second, and every
            // animateSpring() call restarts the underdamped spring's
            // clock from t=0 (cancelSpring + a brand-new Timeline) — with
            // near-continuous small target changes, the icon kept
            // replaying only the curve's slow initial ramp and never
            // reached its snappier back half, which reads as slow-motion
            // rather than live tracking. Skipping re-targets that aren't
            // a meaningful change lets each spring actually run long
            // enough to be felt as motion, not just restarted.
            const lastScale = icon._magnifyTarget ?? 1;
            const lastTranslation = icon._magnifyTranslation ?? 0;
            if (Math.abs(scale - lastScale) < 0.02 && Math.abs(translation - lastTranslation) < 1)
                continue;
            icon._magnifyTarget = scale;
            icon._magnifyTranslation = translation;

            // Re-targets from the icon's current (possibly mid-animation)
            // scale/translation rather than resetting first, so
            // continuous pointer movement reads as smooth tracking, not
            // a jump each frame.
            // id: 'magnify' — a launch/attention bounce drives the same
            // icon's translation_y at the same time, and with a single
            // animation slot per actor whichever started last silently
            // killed the other (hovering a bouncing icon froze it
            // mid-bounce). Separate ids let both run, as they do on
            // macOS.
            animateSpring(icon,
                { scale_x: icon.scale_x, scale_y: icon.scale_y, translation_x: icon.translation_x },
                { scale_x: scale, scale_y: scale, translation_x: translation },
                { duration: 160, preset: SPRING.MAGNIFY, id: 'magnify' });
        }
    }

    _applyDockWidth(width) {
        if (!this._dockActor || this._dockBaseWidth == null)
            return;

        const target = Math.round(width);
        if (Math.abs((this._dockTargetWidth ?? this._dockBaseWidth) - target) < 2)
            return;
        this._dockTargetWidth = target;

        const x = Math.round(this._dockBaseX + (this._dockBaseWidth - target) / 2);
        animateSpring(this._dockActor,
            { width: this._dockActor.width, x: this._dockActor.x },
            { width: target, x },
            { duration: 160, preset: SPRING.MAGNIFY, id: 'magnify-width' });
    }

    _resetMagnification() {
        for (const icon of this._magnifiableIcons()) {
            icon._magnifyTarget = 1;
            icon._magnifyTranslation = 0;
            animateSpring(icon,
                { scale_x: icon.scale_x, scale_y: icon.scale_y, translation_x: icon.translation_x },
                { scale_x: 1, scale_y: 1, translation_x: 0 },
                { duration: 200, preset: SPRING.MAGNIFY, id: 'magnify' });
        }
        this._applyDockWidth(this._dockBaseWidth);
    }

    // -- drag to reorder / pin / unpin ---------------------------------------
    //
    // Modelled directly on how GNOME's own Dash does this (ui/dash.js),
    // because the previous approach never actually worked and the reason
    // is structural: ui/dnd.js decides a drop by walking up from the
    // actor under the pointer looking for an ancestor whose `_delegate`
    // has an `acceptDrop()` that returns true, and cancelling the whole
    // drag if it finds none. We had no `_delegate` on any container, and
    // both icon classes returned `false` from acceptDrop() — so every
    // drop was rejected and the drag snapped back, no matter what the
    // DND.addDragMonitor callback had previewed in the meantime. The
    // monitor gave live feedback but could never *complete* a drag.
    //
    // So the boxes themselves are the drop targets now. This also gets
    // "drag a running app into the dock to pin it" for free, since
    // acceptDrop can call addFavoriteAtPos() for an app that isn't
    // pinned yet — the same thing the native Dash does.

    _installDropTargets() {
        this._appsBox._delegate = {
            handleDragOver: (source, actor, x) => this._onAppsDragOver(source, x),
            acceptDrop: (source, actor, x) => this._onAppsDrop(source, x),
        };
        this._stacksBox._delegate = {
            handleDragOver: (source, actor, x) => this._onStacksDragOver(source, x),
            acceptDrop: (source, actor, x) => this._onStacksDrop(source, x),
        };
    }

    _wireDraggable(icon) {
        if (!icon._draggable)
            return;
        icon._draggable.connectObject(
            'drag-begin', () => {
                this._dragIcon = icon;
                this._hideTooltip();
            },
            'drag-end', () => this._onDragFinished(),
            'drag-cancelled', () => {
                // "Cancelled" here means no drop target accepted it,
                // which is exactly what happens when the icon is
                // released away from the dock — macOS treats that as
                // removing it from the Dock.
                if (this._dragIcon && this._droppedAwayFromDock())
                    this._unpinDraggedIcon();
                this._onDragFinished();
            },
            icon);
    }

    _onDragFinished() {
        this._dragIcon = null;
        // Any live preview reordering is thrown away and the row rebuilt
        // from the model, so the actors can never drift out of sync with
        // what is actually saved.
        this._queueRedisplay();
    }

    _droppedAwayFromDock() {
        if (!this._dockActor)
            return false;
        const [pointerX, pointerY] = global.get_pointer();
        const [x, y] = this._dockActor.get_transformed_position();
        const [width, height] = this._dockActor.get_transformed_size();
        return pointerX < x - UNPIN_DROP_MARGIN ||
               pointerX > x + width + UNPIN_DROP_MARGIN ||
               pointerY < y - UNPIN_DROP_MARGIN ||
               pointerY > y + height + UNPIN_DROP_MARGIN;
    }

    _unpinDraggedIcon() {
        const icon = this._dragIcon;
        const appId = icon.app?.get_id();
        if (appId) {
            // Only pinned apps have anything to remove; a running,
            // unpinned app just snaps back.
            if (this._favorites.getFavoriteMap()[appId])
                this._favorites.removeFavorite(appId);
        } else if (icon.config) {
            this._settings.removeStack(icon.config.id);
        }
    }

    // Index the dragged icon would land at, counted in the box's own
    // coordinate space. translation_x is added in because hover
    // magnification offsets every icon sideways, so the allocation x
    // alone is not where the user actually sees the icon.
    _dropIndex(box, x) {
        const children = box.get_children()
            .filter(child => child !== this._sepRunning && child !== this._dragIcon);
        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            if (x < child.x + child.translation_x + child.width / 2)
                return i;
        }
        return children.length;
    }

    _onAppsDragOver(source, x) {
        const app = source?.app;
        if (!app || app.is_window_backed())
            return DND.DragMotionResult.NO_DROP;
        if (!global.settings.is_writable('favorite-apps'))
            return DND.DragMotionResult.NO_DROP;

        // Live preview: shuffle the real icon as the pointer moves.
        if (this._dragIcon && this._dragIcon.get_parent() === this._appsBox) {
            const index = this._dropIndex(this._appsBox, x);
            const withSeparator = this._sepRunning?.visible &&
                index > this._appsBox.get_children().indexOf(this._sepRunning)
                ? index + 1 : index;
            this._appsBox.set_child_at_index(this._dragIcon, withSeparator);
        }

        return this._favorites.getFavoriteMap()[app.get_id()]
            ? DND.DragMotionResult.MOVE_DROP
            : DND.DragMotionResult.COPY_DROP; // dropping pins it
    }

    _onAppsDrop(source, x) {
        const app = source?.app;
        if (!app || app.is_window_backed())
            return false;
        if (!global.settings.is_writable('favorite-apps'))
            return false;

        const id = app.get_id();
        const favorites = this._favorites.getFavoriteMap();
        const wasFavorite = id in favorites;

        // Position is expressed against the favourites list only, so
        // running-but-unpinned icons sitting in the same row are skipped
        // when counting.
        const children = this._appsBox.get_children()
            .filter(child => child !== this._sepRunning && child !== this._dragIcon);
        const index = this._dropIndex(this._appsBox, x);
        let favPos = 0;
        for (let i = 0; i < index && i < children.length; i++) {
            const childId = children[i].app?.get_id();
            if (childId && childId !== id && childId in favorites)
                favPos += 1;
        }

        // Deferred to a later, exactly as the native Dash does: writing
        // to favourites synchronously here re-enters our own 'changed'
        // handler while dnd.js is still finishing the drop.
        const laters = global.compositor.get_laters();
        laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            if (wasFavorite)
                this._favorites.moveFavoriteToPos(id, favPos);
            else
                this._favorites.addFavoriteAtPos(id, favPos);
            return GLib.SOURCE_REMOVE;
        });
        return true;
    }

    _onStacksDragOver(source, x) {
        if (!source?.config)
            return DND.DragMotionResult.CONTINUE;
        if (this._dragIcon && this._dragIcon.get_parent() === this._stacksBox)
            this._stacksBox.set_child_at_index(this._dragIcon, this._dropIndex(this._stacksBox, x));
        return DND.DragMotionResult.MOVE_DROP;
    }

    _onStacksDrop(source, x) {
        if (!source?.config)
            return false;

        const index = this._dropIndex(this._stacksBox, x);
        const remaining = this._settings.getStacks().filter(s => s.id !== source.config.id);
        remaining.splice(Math.min(index, remaining.length), 0, source.config);

        const laters = global.compositor.get_laters();
        laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._settings.setStacks(remaining);
            return GLib.SOURCE_REMOVE;
        });
        return true;
    }
}
