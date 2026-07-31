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
import Mtk from 'gi://Mtk';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { createGlassPanel, applyPanelRadius } from './glass.js';
import { LauncherEntryWatcher } from './launcherEntry.js';
import { AppearanceManager, applyAppearanceClass, blurBrightnessFor } from './appearance.js';
import { clamp, getActorGeometry } from './utils.js';
import { animateSpring, cancelSpring, SPRING } from './animations.js';
import { DockAppIcon } from './dockAppIcon.js';
import { DockFolderIcon } from './dockFolderIcon.js';
import { createDockSeparator, sizeDockSeparator, SEPARATOR_TOTAL_WIDTH } from './dockSeparator.js';
import { DockTrashIcon } from './dockTrashIcon.js';
import { DockShowAppsIcon } from './dockShowAppsIcon.js';
import { RecentApps } from './recentApps.js';

const DOCK_MIN_WIDTH = 120;

// macOS' Dock is one shape scaled up and down: at every icon size the gaps,
// the padding around the row and the bar's corner radius keep the same
// proportion to the icons. Ours were three fixed pixel constants, so the
// bar only looked right at one setting — shrink the icons and it turned
// into a thick slab with cavernous gaps, grow them and it read as a tight
// strip with square-ish corners.
//
// Re-measured against Apple's own Dock screenshots and a real Tahoe
// desktop rather than estimated: in both, the bar stands about 0.19 of an
// icon clear above and below the row, the icons sit about 0.16 of their
// own width apart, and the corner radius is very nearly a third of the
// bar's *height* — which is why the radius is derived from the height
// below instead of from the icon size. The previous values gave a bar that
// hugged the icons far too tightly and corners about 30% too tight with
// it, which is most of why it read as a GNOME panel rather than a Dock.
const PADDING_RATIO = 0.19; // vertical breathing room above/below the icons
const SPACING_RATIO = 0.16; // gap between icons, and at the row's two ends
const RADIUS_RATIO = 0.32; // of the bar's height, not of the icon size
const PADDING_RANGE = [8, 22];
const SPACING_RANGE = [6, 16];
const RADIUS_RANGE = [12, 34];
// The two dividers are short hairlines centred on the bar, not full-height
// rules — Apple's screenshots put them at roughly 60% of the bar's height.
const SEPARATOR_HEIGHT_RATIO = 0.6;
// macOS' running dot is about a tenth of the icon it belongs to and sits
// clear of it, down in the bar's lower padding, rather than tucked against
// the icon's foot the way GNOME's app-grid dot is.
const DOT_SIZE_RATIO = 0.1;
const DOT_OFFSET_RATIO = 0.18;
const MAX_BLUR_RADIUS = 60; // matches stack.js's own ceiling for the same setting
const AUTOHIDE_TRIGGER_HEIGHT = 2; // reveal band pinned to the screen edge
const UNPIN_DROP_MARGIN = 60; // how far past the dock a drop must land to unpin
const AUTOHIDE_DELAY = 350; // ms the pointer must stay away before re-hiding
const TOOLTIP_GAP = 10; // gap between an icon's top and its tooltip
// Hover magnification follow. MAGNIFY_TAU is the exponential time
// constant (ms) each icon uses to close the gap to its target scale:
// small enough that the icons feel glued to the pointer, large enough
// that the growth still reads as motion rather than a snap.
const MAGNIFY_TAU = 55;
const MAGNIFY_SCALE_EPSILON = 0.002; // "close enough to rest" for scale
const MAGNIFY_PIXEL_EPSILON = 0.05;  // ...and for translation/width, in px
// How many settled frames the ticker keeps running for before shutting
// itself down. Without this grace period a slow pointer sweep — where
// each frame's target is close enough to the last that everything is
// already "settled" — would stop and restart the ticker on every single
// mouse report, which is most of the churn this design exists to avoid.
const MAGNIFY_IDLE_FRAMES = 30;
// Shortest gap between two geometry repairs, in microseconds — see
// _verifyDockGeometry().
const GEOMETRY_FIX_COOLDOWN = 250000;
// The floor the auto-shrink will not go below (see _effectiveIconSize).
// Past this the icons stop being recognisable and a dock that has become
// illegible is worse than one that is merely full.
const DOCK_MIN_ICON_SIZE = 22;

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
        this._sepTrailing = null;
        this._sepRunning = null;

        this._contextMenu = null;
        this._contextMenuManager = null;

        this._appIcons = new Map(); // appId -> DockAppIcon
        this._stackIcons = new Map(); // stack id -> DockFolderIcon
        this._redisplayIdle = 0;
        this._overviewHiddenId = 0;

        this._appSystem = Shell.AppSystem.get_default();
        this._favorites = AppFavorites.getAppFavorites();

        // The recents queue's whole state and ordering policy (see
        // modules/recentApps.js). This class keeps only the icons; the four
        // ports below are the entire surface between them, which is what
        // lets the ordering rules be tested without a compositor.
        this._recents = new RecentApps({
            storage: {
                getIds: () => this._settings.getRecentApps(),
                setIds: ids => this._settings.setRecentApps(ids),
                getSuppressed: () => this._settings.recentAppsSuppressed,
                setSuppressed: count => {
                    this._settings.recentAppsSuppressed = count;
                },
                getFormat: () => this._settings.recentAppsFormat,
                setFormat: version => {
                    this._settings.recentAppsFormat = version;
                },
            },
            isPinned: id => this._favorites.isFavorite(id),
            appExists: id => this._appSystem.lookup_app(id) !== null,
            limit: () => this._settings.dockRecentApps,
        });

        this._objectSignals = []; // { object, id }
        this._monitorsChangedId = 0;
        this._settingsChangedId = 0;

        this._magnifyMotionId = 0;
        this._magnifyLeaveId = 0;
        this._magnifyPointerX = null; // null == pointer is not over the row
        this._magnifyTicker = null;
        this._magnifySettledFrames = 0;
        this._dockBaseX = null;
        this._dockBaseWidth = null;
        this._dockTargetWidth = null;

        this._tooltip = null;
        this._tooltipIcon = null;

        this._autohideStrip = null;
        this._autohideTimeoutId = 0;
        this._dockHidden = false;

        // Pending re-layout queued by _verifyDockGeometry(); also its
        // "a repair is already on the way" flag.
        this._geometryFixId = 0;
        this._lastGeometryFix = 0;

        // Whether the strut may reserve space yet — false while the login
        // overview-exit is still in flight, see _settleStrut().
        this._strutSettled = false;
        this._watchdogIds = [];

        // Set the moment the dock actor is destroyed from underneath us
        // (shell shutdown destroys chrome from C before disable() runs);
        // guards the signal handlers that would otherwise poke disposed
        // actors — the ~40 "has been already disposed" journal lines per
        // logout all came through 'workareas-changed' → _layoutDock().
        this._chromeGone = false;

        this._dragIcon = null;

        this._iconSizeCacheKey = null;
        this._iconSizeCache = 0;
        this._appliedIconSize = 0;
        this._layingOut = false;
        this._launcherEntries = null;
        this._dragMonitor = null;
    }

    enable() {
        // First, and before anything can write to the recents queue: the
        // first redisplay has to know which apps were already running when
        // the session came up (see _loadRecentAppsState).
        this._loadRecentAppsState();

        // Note: no disable_unredirect() here, deliberately. The glass blur
        // samples a clone of the static background group only (see
        // glass.js), which does not go stale when a fullscreen window
        // bypasses compositing — so fullscreen apps/games keep mutter's
        // unredirect fast path while the dock is enabled.
        this._buildChrome();
        this._connectSignals();
        this._hideNativeDash();
        this._enableMagnification();

        // Real, app-published progress for the dock icons (see
        // modules/launcherEntry.js for why this is the only channel that
        // carries a genuine total).
        this._launcherEntries = new LauncherEntryWatcher(
            (appId, entry) => this._onLauncherEntry(appId, entry));
        this._launcherEntries.enable();

        this._queueRedisplay();
    }

    /**
     * Applies one app's published progress straight to its icon, without a
     * full redisplay: a transfer emits this signal several times a second
     * and rebuilding the whole row at that rate would be absurd.
     */
    _onLauncherEntry(appId, entry) {
        const icon = this._appIcons.get(appId);
        icon?.setProgress(entry.progress);
        if (entry.urgent)
            icon?.attentionBounce();
    }

    disable() {
        // Set before anything else: teardown must not start animations on
        // actors it is about to destroy. _resetMagnification() did exactly
        // that, and the springs it launched kept writing scale/translation
        // on icons that disable() had already destroyed a few lines later
        // — about thirty `Gjs-CRITICAL: has been already disposed` lines
        // per teardown, visible only with --debug-control.
        this._tearingDown = true;
        this._restoreNativeDash();
        this._disableMagnification();
        this._disconnectSignals();

        this._launcherEntries?.disable();
        this._launcherEntries = null;

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
        const surface = createGlassPanel({
            cornerRadius: this._dockMetrics().radius,
            clipContent: false,
            variant: 'macos-dock-panel',
        });
        const { panel, content, blurEffect } = surface;
        this._surface = surface;
        this._blurEffect = blurEffect;
        this._dockActor = panel;
        this._content = content;
        this._dockActor.set({ reactive: true });

        // Unlike the Stack panel (which animates blur in on open),
        // the dock is always visible, so its blur radius is just set
        // once from the existing blur-intensity preference rather than
        // driven by an open/close spring.
        blurEffect.radius = (this._settings.blurIntensity / 100) * MAX_BLUR_RADIUS;

        // Light/dark/follow-the-system. The palette itself lives in the
        // stylesheet, selected by a marker class on this root actor —
        // St has no media queries, so this is what stands in for one.
        this._appearance = new AppearanceManager(this._settings);
        this._appearanceListener = this._appearance.connect(() => this._applyAppearance());
        this._applyAppearance();

        // The macOS Dock has exactly TWO sections and therefore exactly
        // ONE divider: applications on the left (Finder, Launchpad, then
        // everything else), and stacks plus the Trash on the right. Ours
        // drew three dividers — one after the launcher, one before the
        // stacks and one before the Trash — which is the main reason the
        // bar read as a GNOME panel with sections rather than as a Dock.
        // The only extra rule is the divider inside the app section that
        // marks off running-but-unpinned apps, which macOS does draw when
        // "show recent applications" is on.
        this._iconBox = new St.BoxLayout({
            vertical: false,
            reactive: true, // needed to receive motion-event for magnification
            style_class: 'macos-dock-icon-box',
            x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._content.add_child(this._iconBox);

        this._showAppsIcon = this._watchIconLifetime(new DockShowAppsIcon(this._settings.dockIconSize));
        this._showAppsIcon.set_pivot_point(0.5, 1); // grow upward from the dock's baseline
        this._appsBox = new St.BoxLayout({ vertical: false });
        this._stacksBox = new St.BoxLayout({ vertical: false });
        // Divides pinned apps from merely-running ones; lives inside
        // appsBox and is repositioned/hidden by _redisplayApps.
        this._sepRunning = createDockSeparator();
        this._appsBox.add_child(this._sepRunning);
        this._trashIcon = this._watchIconLifetime(new DockTrashIcon(this._settings.dockIconSize));
        this._trashIcon.set_pivot_point(0.5, 1); // grow upward from the dock's baseline

        this._trackTooltip(this._showAppsIcon, () => _('Applications'));
        this._trackTooltip(this._trashIcon, () => _('Trash'));

        // The launcher belongs *inside* the app section (Launchpad sits
        // among the apps on a real Dock), and the Trash shares the trailing
        // section with the stacks rather than being fenced off from them.
        this._sepTrailing = createDockSeparator();
        this._iconBox.add_child(this._showAppsIcon);
        this._iconBox.add_child(this._appsBox);
        this._iconBox.add_child(this._sepTrailing);
        this._iconBox.add_child(this._stacksBox);
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
        //
        // reactive:false is NOT enough on its own, and this was the whole
        // reason drag-to-reorder never worked. Clicks are routed by
        // reactive picking, which does skip this actor — but ui/dnd.js
        // resolves a drop target with
        // `get_actor_at_pos(Clutter.PickMode.ALL, …)`, and PickMode.ALL
        // ignores reactivity entirely. This actor spans the full monitor
        // width down to the screen edge (so it covers the whole dock) and
        // is added to the chrome *after* the dock, so it paints above it
        // and won every DnD pick. dnd.js then walked up from it — through
        // Main.layoutManager's chrome group, which has no `_delegate` —
        // found nothing that would accept the drop, and cancelled the
        // drag. Measured: a synthetic drag emitted 'drag-begin' correctly
        // and then always 'drag-cancelled', with the actor picked at an
        // app icon's own centre coming back as a bare ClutterActor that
        // the icon did not contain. Hidden from picking outright, since a
        // pure geometry placeholder should never be the answer to "what is
        // under the pointer" in any pick mode.
        this._strutActor = new Clutter.Actor({ opacity: 0, reactive: false });
        Shell.util_set_hidden_from_pick(this._strutActor, true);

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

        this._dockActor.connect('destroy', () => {
            this._chromeGone = true;
        });

        this._installDropTargets();

        this._layoutDock();
        // After the first layout, so the very first allocation the watcher
        // sees is already the correct one.
        this._watchDockGeometry();
        this._updateAutohide();

        // Persistent, not one-shot, and deliberately nothing but the strut
        // settle: earlier rounds also fired stage-wide queue_redraw()s and
        // a per-frame "redraw pump" from here as insurance against stale
        // pixels on this NVIDIA stack. Those stale pixels (tooltip ghost
        // trails, the frozen startup frame) turned out to be symptoms of
        // the window_group backdrop clone that the blur used to carry —
        // see glass.js — and the forced full-stage redraws were themselves
        // a large part of the "everything is slow until the first app
        // opens" report. With the wallpaper-only backdrop there is nothing
        // left for them to repair.
        this._overviewHiddenId = Main.overview.connect('hidden', () => {
            this._settleStrut();
        });

        // Enabled mid-session (or on a session that never shows the login
        // overview) there is nothing to wait for — reserve space now.
        if (!Main.layoutManager._startingUp && !Main.overview.visible)
            this._settleStrut();
    }

    _trackStrutActor() {
        Main.layoutManager.addChrome(this._strutActor, {
            affectsStruts: !this._settings.dockAutohide && this._strutSettled,
        });
    }

    /**
     * Lets the strut start reserving space — deliberately NOT done while
     * the login overview-exit is still on screen.
     *
     * A black band under the dock at session start traces back to
     * no-overview@fthx's Main.overview.hide() call wedging before
     * _hideDone() runs: overviewGroup stays visible, frozen on a frame
     * whose wallpaper is sized to the work area (see
     * overviewControls._computeWorkspacesBoxForState). Our strut is what
     * shrinks that work area, so the frozen frame shows wallpaper cut off
     * above the dock with black below it. Activating any dock icon fixes
     * it as a side effect, because AppIcon.activate() calls
     * Main.overview.hide() again, completing the wedged hide.
     *
     * Two-part fix: (1) the strut only starts reserving space once the
     * overview is genuinely hidden, so every startup frame keeps a
     * full-height wallpaper and there is nothing black to freeze on; and
     * (2) a watchdog (see _scheduleOverviewWatchdog) issues that same
     * Main.overview.hide() itself, in case the wedge happens anyway.
     */
    _settleStrut() {
        if (this._strutSettled)
            return;
        this._strutSettled = true;
        this._updateStrutTracking();
    }

    /**
     * Unwedges a stuck overview hide. Predicate: `visible` with
     * `visibleTarget === false` means a hide was requested and never
     * finished — a user-opened overview has visibleTarget true and is left
     * strictly alone (the explicit `=== false` also keeps this a no-op if
     * a future shell drops the getter). A healthy hide lasts ~300ms; these
     * checks run 1s+ after startup-complete, so matching the predicate
     * then means the transition is dead, not merely slow.
     *
     * `hide()` (see overview.js) early-returns unless `_shown` is still
     * true, so it only repairs the case where the hide request itself got
     * lost. The wedge this guards against is the other case: hide() ran,
     * `_shown` went false, `_animateNotVisible()` started
     * `animateFromOverview()`, and that ease's completion callback never
     * fired — leaving `_visible` stuck true with the cover pane up and the
     * workspace clones frozen at work-area size. `_hideDone()` is exactly
     * that dropped callback (resets `_visible`/`_animationInProgress`,
     * hides overviewGroup, re-syncs the grab), so calling it finishes the
     * shell's own transition rather than improvising a new teardown.
     * The last check also force-settles the strut: whatever happened to
     * the overview, the dock must eventually reserve its space or
     * maximized windows would cover it for the rest of the session.
     */
    _scheduleOverviewWatchdog() {
        for (const delay of [1000, 3000, 8000]) {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                this._watchdogIds = this._watchdogIds.filter(other => other !== id);
                const overview = Main.overview;
                if (overview.visible && overview.visibleTarget === false) {
                    if (overview._shown)
                        overview.hide();
                    else if (typeof overview._hideDone === 'function')
                        overview._hideDone();
                }
                if (delay === 8000)
                    this._settleStrut();
                return GLib.SOURCE_REMOVE;
            });
            this._watchdogIds.push(id);
        }
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
            {
                duration: 120, preset: SPRING.SOFT, id: 'tooltip',
                onComplete: () => this._tooltip?.hide(),
            });
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
        // Must stay reactive (that is how it notices the pointer), so it
        // cannot be hidden from picking the way the strut actor is — and a
        // revealed dock overlaps this band. Lowered below the dock instead,
        // so wherever the two overlap the dock is what a pick returns and
        // dragging an icon near the screen's bottom edge still finds a drop
        // target. Same failure mode as the strut actor above, different fix.
        Main.layoutManager.uiGroup.set_child_below_sibling(this._autohideStrip, this._dockActor);
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
        // The tooltip is separate chrome, so it would otherwise be left
        // floating over the desktop naming an icon that just slid away.
        this._hideTooltip();

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
        // Wiping the recents history needed *some* entry point: "Remove
        // from Dock" only ever drops one app, and clearing the lot by
        // right-clicking each icon in turn is not a gesture anyone would
        // find. Hidden while there is nothing to clear, so the menu stays a
        // single item on a dock that has no recents.
        this._clearRecentsItem = this._contextMenu.addAction(
            _('Clear Recent Apps'), () => this._clearRecentApps());
        this._contextMenu.addAction(_('Dock Preferences…'), () => this._onOpenPreferences?.());
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
            if (this._clearRecentsItem)
                this._clearRecentsItem.visible = this._recents.ids.length > 0;
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
        // Before anything is destroyed: the magnification ticker takes its
        // frame clock from `_iconBox`, and a timeline still running on a
        // destroyed actor is the same "animation outlives its target" trap
        // the per-icon springs used to fall into on teardown.
        this._stopMagnifyTicker();

        for (const id of this._watchdogIds)
            GLib.Source.remove(id);
        this._watchdogIds = [];

        if (this._overviewHiddenId) {
            Main.overview.disconnect(this._overviewHiddenId);
            this._overviewHiddenId = 0;
        }

        if (this._dragMonitor) {
            DND.removeDragMonitor(this._dragMonitor);
            this._dragMonitor = null;
        }

        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }

        if (this._geometryFixId) {
            GLib.Source.remove(this._geometryFixId);
            this._geometryFixId = 0;
        }

        this._cancelScheduledHide();
        this._destroyAutohideStrip();

        this._appearance?.destroy();
        this._appearance = null;
        this._appearanceListener = null;

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
        this._surface = null;
        this._blurEffect = null;
        this._content = null;
        this._iconBox = null;
        this._appsBox = null;
        this._stacksBox = null;
        this._sepTrailing = null;
        this._sepRunning = null;
        this._trashIcon = null;
        this._showAppsIcon = null;
    }

    /**
     * The dock's own surface follows the scheme; so does the blur, because
     * macOS' light glass lifts the wallpaper behind it and its dark glass
     * pushes it down, and `brightness` is the only knob Shell.BlurEffect
     * gives us for that.
     */
    _applyAppearance() {
        const scheme = this._appearance?.scheme ?? 'dark';
        applyAppearanceClass(this._dockActor, scheme);
        if (this._blurEffect)
            this._blurEffect.brightness = blurBrightnessFor(scheme);
    }

    get appearanceScheme() {
        return this._appearance?.scheme ?? 'dark';
    }

    /**
     * The icon size actually used, which is the preference *or* less.
     *
     * macOS shrinks its Dock's icons as you pin more to it, so the bar
     * never runs off the screen — the preference is the size you get when
     * there is room for it, not a fixed size.
     *
     * Solved by search rather than algebra: the row's width is not a linear
     * function of the icon size, because both the inter-icon spacing and
     * the bar's padding are clamped to fixed pixel ranges, so there are
     * flat regions where shrinking the icons does not narrow the row by the
     * proportional amount. Walking down one pixel at a time from the
     * preference is exact, bounded (at most ~70 steps of integer maths) and
     * only ever runs on a layout pass, never per frame.
     */
    _effectiveIconSize() {
        const preferred = this._settings.dockIconSize;
        const monitorIndex = Main.layoutManager.primaryIndex;
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
        if (!workArea)
            return preferred;

        const available = workArea.width - this._settings.dockEdgeMargin * 2;
        // Memoised on everything the search actually depends on. A single
        // layout pass asks for this several times over (metrics, the row
        // rebuild, the stack rebuild), and 'workareas-changed' can bring a
        // couple of extra passes with it — without the cache that is a few
        // hundred redundant iterations for an answer that cannot have
        // changed in between.
        const key = `${preferred}|${available}|${this._appIcons.size}|${this._stackIcons.size}` +
            `|${this._sepRunning?.visible}|${this._sepTrailing?.visible}`;
        if (this._iconSizeCacheKey === key)
            return this._iconSizeCache;

        let result = DOCK_MIN_ICON_SIZE;
        for (let size = preferred; size > DOCK_MIN_ICON_SIZE; size--) {
            if (this._naturalRowWidth(this._dockMetrics(size)) <= available) {
                result = size;
                break;
            }
        }
        this._iconSizeCacheKey = key;
        this._iconSizeCache = result;
        return result;
    }

    /** Every proportional measurement of the bar, derived from icon size. */
    _dockMetrics(overrideIconSize = null) {
        const iconSize = overrideIconSize ?? this._effectiveIconSize();
        const padding = clamp(Math.round(iconSize * PADDING_RATIO), ...PADDING_RANGE);
        const height = iconSize + padding * 2;
        return {
            iconSize,
            padding,
            height,
            spacing: clamp(Math.round(iconSize * SPACING_RATIO), ...SPACING_RANGE),
            radius: clamp(Math.round(height * RADIUS_RATIO), ...RADIUS_RANGE),
            separatorHeight: Math.round(height * SEPARATOR_HEIGHT_RATIO),
            dotSize: Math.max(3, Math.round(iconSize * DOT_SIZE_RATIO)),
            dotOffset: Math.max(2, Math.round(iconSize * DOT_OFFSET_RATIO)),
        };
    }

    /**
     * Pushes those measurements onto the actors. Spacing and the row's end
     * padding live in an inline style rather than the stylesheet because
     * St's CSS has no way to express "a fraction of the icon size", and
     * they have to change the moment the icon-size preference does.
     */
    _applyDockMetrics(metrics) {
        // The row may have been auto-shrunk since the icons were built (a
        // newly pinned app can push it past the screen's width), so the
        // size is pushed down here on every layout rather than only when
        // the preference changes.
        this._applyIconSize(metrics.iconSize);

        // One spacing value everywhere — the outer row and the two inner
        // section boxes — so the gap between two apps is the same as the
        // gap between the last app and the divider. They used to differ
        // (10px outer, 6px inner), which read as the sections being
        // shoved apart.
        const spacing = `spacing: ${metrics.spacing}px;`;
        this._iconBox?.set_style(`${spacing} padding: 0 ${metrics.spacing}px;`);
        this._appsBox?.set_style(spacing);
        this._stacksBox?.set_style(spacing);

        // An empty-but-visible section box still earns a spacing gap from
        // its parent, leaving a phantom hole beside the divider when no
        // stack is configured. Hiding it makes Clutter's box layout skip
        // it — and the gap — entirely.
        if (this._appsBox)
            this._appsBox.visible = this._appIcons.size > 0;
        if (this._stacksBox)
            this._stacksBox.visible = this._stackIcons.size > 0;

        for (const separator of [this._sepRunning, this._sepTrailing])
            sizeDockSeparator(separator, metrics.separatorHeight);

        // The running dot's size and offset are per-icon-size values that
        // St's CSS cannot express, so they are pushed inline. Only the
        // colour stays in the stylesheet, because that one flips with the
        // light/dark scheme. AppIcon reads `offset-y` back through its own
        // theme node (see _updateDotStyle in GNOME's appDisplay.js) and
        // applies it as a translation, so it has to stay inside the bar's
        // lower padding or the dot lands off the glass.
        const dotStyle = `height: ${metrics.dotSize}px; width: ${metrics.dotSize}px;` +
            ` border-radius: ${metrics.dotSize}px; offset-y: ${metrics.dotOffset}px;`;
        for (const icon of this._appIcons.values())
            icon.setDotStyle(dotStyle);

        if (this._surface)
            applyPanelRadius(this._surface, metrics.radius);
    }

    /**
     * The row's width, computed rather than measured.
     *
     * `_iconBox.get_preferred_width()` looks like the obvious source of
     * truth and is not one: changing the icon-size preference sets a new
     * `icon_size` on every St.Icon, but the resulting size invalidation
     * only reaches the parent box on the *next* relayout cycle — so a
     * measurement taken in the same call still describes the previous icon
     * size. Confirmed by measuring: at a 48px setting the bar came out
     * 275px wide while its own children ran to 299px, leaving the Trash
     * hanging 17px off the end of the glass; one step earlier, at 36px,
     * the bar was 56px too wide instead. Every dock item is exactly
     * `iconSize` across and every gap is known, so the sum is exact and
     * immune to when a texture happens to finish loading.
     */
    _naturalRowWidth(metrics) {
        const widths = [metrics.iconSize]; // show-apps launcher
        for (let i = 0; i < this._appIcons.size; i++)
            widths.push(metrics.iconSize);
        if (this._sepRunning?.visible)
            widths.push(SEPARATOR_TOTAL_WIDTH);
        if (this._sepTrailing?.visible)
            widths.push(SEPARATOR_TOTAL_WIDTH);
        for (let i = 0; i < this._stackIcons.size; i++)
            widths.push(metrics.iconSize);
        widths.push(metrics.iconSize); // trash

        const content = widths.reduce((total, width) => total + width, 0);
        const gaps = metrics.spacing * Math.max(0, widths.length - 1);
        return content + gaps + metrics.spacing * 2; // + the row's end padding
    }

    _layoutDock() {
        // `_chromeGone`: shell shutdown destroys our chrome from C before
        // disable() ever runs, but 'workareas-changed' still fires while
        // the display tears its struts down — without this, every such
        // emission walked disposed actors ("has been already disposed"
        // spam on every logout).
        if (!this._dockActor || this._layingOut || this._chromeGone)
            return;

        // Re-entrancy guard. _layoutDock() resizes the strut actor, which
        // makes ui/layout.js recompute struts, which emits
        // 'workareas-changed', which this class now listens to — without
        // this, a single settings change could recurse straight back into
        // the middle of its own layout pass.
        this._layingOut = true;
        try {
            this._layoutDockInner();
        } finally {
            this._layingOut = false;
        }
    }

    _layoutDockInner() {
        const metrics = this._dockMetrics();
        this._applyDockMetrics(metrics);

        const monitorIndex = Main.layoutManager.primaryIndex;
        const monitor = Main.layoutManager.monitors[monitorIndex];
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
        const margin = this._settings.dockEdgeMargin;

        // Computed from the row's contents, not measured off any actor —
        // see _naturalRowWidth for why measuring is unreliable here. (The
        // panel actor itself was never a candidate: its preferred width
        // goes through two nested BinLayouts, which report the *max* of
        // their overlapping children, and the blur/tint/sheen/border
        // layers all expand with no intrinsic size, so that max collapses
        // far below what the icon row needs.)
        const width = clamp(this._naturalRowWidth(metrics), DOCK_MIN_WIDTH, workArea.width - margin * 2);
        const height = metrics.height;

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
        const y = this._dockTargetY(bottom, height, margin);

        // Remembered as the "unmagnified" geometry so hover
        // magnification can widen the bar around it and return to it
        // afterwards without ever re-deriving it from the live (already
        // widened) actor.
        this._dockBaseX = Math.round(x);
        this._dockBaseWidth = Math.round(width);
        this._dockTargetWidth = this._dockBaseWidth;

        this._dockActor.set_position(Math.round(x), Math.round(y));
        this._dockActor.set_size(Math.round(width), Math.round(height));

        // The strut actor spans the monitor's *full* width and reaches
        // its literal bottom edge (not the work area's — struts are
        // measured against the real monitor rect, see ui/layout.js) so
        // it satisfies the "touches an entire edge" condition the strut
        // algorithm requires, regardless of how narrow/centered/margined
        // the visible dock bar itself is.
        //
        // It starts `dockWindowGap` px *above* the bar rather than at its
        // top edge. The strut is what decides where a maximized window
        // stops, and with the strut flush against the glass a maximized
        // window's own edge touched the dock with no gap at all — hence
        // this preference. Purely a strut change: the visible bar does not
        // move, so raising the gap pushes windows up rather than pushing
        // the dock down.
        if (this._strutActor && monitor) {
            const stripY = Math.round(y) - this._settings.dockWindowGap;
            const stripHeight = Math.round(monitor.y + monitor.height - stripY);
            this._strutActor.set_position(monitor.x, stripY);
            this._strutActor.set_size(monitor.width, Math.max(0, stripHeight));
        }

        this._layoutAutohideStrip();
    }

    /**
     * The bar's resting top edge. One line, but deliberately its own
     * method: _verifyDockGeometry() has to be able to ask "where should the
     * bar be right now?" without re-running a whole layout pass, and the
     * two answers must not be able to drift apart.
     */
    _dockTargetY(bottom, height, margin) {
        return bottom - height - margin;
    }

    /**
     * Watches for the bar being moved by anything that is not this class —
     * a fullscreen app's mode switch, a monitor hotplug settling, a
     * cancelled autohide spring — none of which a fixed virtual-monitor
     * test setup can reproduce.
     *
     * Rather than chase each cause individually, the geometry is treated
     * as an invariant: whenever the actor's own allocation stops agreeing
     * with the freshly computed target, it is put back, and the
     * disagreement is logged with every number needed to identify the
     * culprit.
     *
     * Deliberately only the *vertical* geometry is policed. Hover
     * magnification legitimately owns x and width (_stepDockWidth rewrites
     * both every frame), so checking those would fight it; nothing but
     * autohide has any business moving the bar up or down.
     */
    _watchDockGeometry() {
        // 'notify::allocation' covers anything that repositions or resizes
        // the actor; translation_y is a transform, which does not touch the
        // allocation at all, so it needs its own notification.
        this._dockActor.connect('notify::allocation', () => this._verifyDockGeometry());
        this._dockActor.connect('notify::translation-y', () => this._verifyDockGeometry());
    }

    _verifyDockGeometry() {
        if (!this._dockActor || this._chromeGone || this._tearingDown ||
            this._layingOut || this._geometryFixId || this._dockHidden)
            return;

        const monitor = Main.layoutManager.monitors[Main.layoutManager.primaryIndex];
        if (!monitor)
            return;

        const margin = this._settings.dockEdgeMargin;
        const height = Math.round(this._dockMetrics().height);
        const wantY = Math.round(this._dockTargetY(monitor.y + monitor.height, height, margin));

        // While autohide is on, translation_y belongs to the reveal/hide
        // spring and is non-zero for the whole of a 260ms animation, so
        // folding it in here would make this fight that animation. With
        // autohide off nothing else may touch it, so a non-zero value is
        // itself a fault worth repairing — a spring cancelled mid-flight
        // would strand the bar low in exactly this way.
        const translation = this._settings.dockAutohide ? 0 : this._dockActor.translation_y;
        const box = this._dockActor.get_allocation_box();
        const haveY = Math.round(box.y1 + translation);
        const haveHeight = Math.round(box.y2 - box.y1);

        if (haveY === wantY && haveHeight === height)
            return;

        // A repair does not land in the allocation the notification that
        // follows it reports — measured: the repaired actor still hands
        // back the stale box on the next check, which read as a second,
        // identical fault and logged the same warning twice. The cooldown
        // swallows that echo, and doubles as the ceiling on how often this
        // can act at all: if something out there genuinely fights us for
        // the bar's position, this settles into four repairs a second
        // instead of spinning the loop.
        const now = GLib.get_monotonic_time();
        if (now - this._lastGeometryFix < GEOMETRY_FIX_COOLDOWN)
            return;

        const detail = `y=${haveY} (expected ${wantY}), height=${haveHeight} (expected ${height}), ` +
            `translation_y=${this._dockActor.translation_y}, margin=${margin}, ` +
            `monitor=${monitor.x},${monitor.y} ${monitor.width}x${monitor.height}, ` +
            `overview=${Main.overview.visible}, autohide=${this._settings.dockAutohide}`;

        // Deferred rather than repaired in place: this runs from inside an
        // allocation notification, and re-entering the layout from there is
        // the relayout-during-allocate that Clutter complains about. The id
        // also coalesces a burst of notifications into a single repair.
        this._geometryFixId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._geometryFixId = 0;
            if (!this._dockActor || this._chromeGone || this._tearingDown)
                return GLib.SOURCE_REMOVE;
            this._lastGeometryFix = GLib.get_monotonic_time();
            console.warn(`macos-dock-stack: dock geometry drifted, repositioned — ${detail}`);
            if (!this._settings.dockAutohide)
                this._dockActor.translation_y = 0;
            this._layoutDock();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * Re-runs the layout once the monitor configuration has actually
     * settled.
     *
     * `_layoutDock()` is already immune to the strut feedback loop (it
     * anchors to the monitor rect, never to the work area), but it can
     * still run *before* the monitor list is meaningful — at enable() time
     * during login, ui/layout.js may not have finished its own monitor
     * setup, and `Main.layoutManager.monitors[primaryIndex]` is then
     * undefined. The dock lands using the work-area fallback, and because
     * nothing afterwards asked it to try again, that one bad position
     * simply persisted for the rest of the session: the bar sat flush
     * against the screen edge with no margin until some unrelated
     * preference change happened to re-trigger a layout, at which point it
     * silently corrected itself — a dock that appears to reposition itself
     * on its own, when really it was just stuck wrong from login.
     *
     * Two cheap subscriptions close it: 'workareas-changed' fires whenever
     * any strut on the display changes (including other panels' and our
     * own — declared on global.display, see ui/panel.js/ui/workspace.js),
     * and 'startup-complete' fires once the shell has finished bringing
     * the session up (declared in LayoutManager's own Signals block).
     *
     * Feeding our own strut change back in as a 'workareas-changed' cannot
     * run away: _layoutDock() derives its geometry from the *monitor* rect,
     * never from the work area, so the second pass computes the identical
     * position and size, writes the same values, produces no allocation
     * change and therefore no further 'workareas-changed'. It settles after
     * one extra pass. (A re-entrancy guard in _layoutDock() covers the
     * synchronous case separately.)
     */
    _connectLayoutStability() {
        this._objectSignals.push(
            {
                object: global.display,
                id: global.display.connect('workareas-changed', () => this._layoutDock()),
            },
            {
                object: Main.layoutManager,
                id: Main.layoutManager.connect('startup-complete', () => this._onStartupComplete()),
            });
    }

    // Runs BEFORE no-overview@fthx's own startup-complete handler calls
    // Main.overview.hide() (we connect at enable time and that extension
    // is enabled after this one), so at login the overview is still
    // visible here: the strut keeps waiting for the 'hidden' signal and
    // the watchdog is armed in case that hide wedges. Without the login
    // overview (or with no-overview gone) the strut settles immediately.
    _onStartupComplete() {
        if (Main.overview.visible) {
            this._layoutDock();
            this._scheduleOverviewWatchdog();
        } else {
            this._settleStrut();
            this._layoutDock();
        }
    }

    // -- live updates ------------------------------------------------------

    _connectSignals() {
        // Every one of these goes into _objectSignals, which
        // _disconnectSignals() empties on disable(): a handler that outlives
        // the manager would keep a destroyed dock alive and, on the next
        // enable(), run twice per event.
        this._objectSignals.push(
            { object: this._favorites, id: this._favorites.connect('changed', () => this._onFavoritesChanged()) },
            { object: this._appSystem, id: this._appSystem.connect('installed-changed', () => this._queueRedisplay()) },
            // Launches and quits both surface here, and quits are what fill
            // the recents queue — see _recordRecentApps().
            { object: this._appSystem, id: this._appSystem.connect('app-state-changed', () => this._queueRedisplay()) },
        );
        this._settingsChangedId = this._settings.connectChanged((_s, key) => this._onSettingChanged(key));
        this._connectLayoutStability();

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

    /**
     * Tells each window where its own dock icon is. GNOME's stock minimize
     * animation reads exactly this (`actor.meta_window.get_icon_geometry()`
     * in windowManager.js's _minimizeWindow) to decide what to shrink the
     * window toward, and falls back to a corner of the monitor when no one
     * has set it — which is why windows used to collapse toward the screen
     * edge rather than into the dock whenever the genie effect was off.
     * Re-published on every redisplay and every layout change, because the
     * icons move whenever the row's contents or the bar's size change.
     */
    _publishIconGeometries() {
        for (const window of global.display.list_all_windows()) {
            const icon = this._iconForWindow(window);
            if (!icon?.get_stage())
                continue;
            const { x, y, width, height } = getActorGeometry(icon);
            // Mtk.Rectangle, not Meta.Rectangle: the rect type moved out of
            // Meta into the Mtk namespace in this Mutter (verified against
            // the installed typelib — Meta.Rectangle is undefined here).
            window.set_icon_geometry(new Mtk.Rectangle({
                x: Math.round(x),
                y: Math.round(y),
                width: Math.round(width),
                height: Math.round(height),
            }));
        }
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
    // nothing until the next logout/login rebuilt everything from scratch.
    _onSettingChanged(key) {
        switch (key) {
        case 'stacks':
            this._queueRedisplay();
            break;
        case 'dock-icon-size':
        case 'dock-edge-margin':
        case 'dock-window-gap':
            this._layoutDock();
            break;
        case 'appearance':
            this._appearance?.refresh();
            break;
        case 'dock-recent-apps':
            this._queueRedisplay();
            break;
        case 'dock-autohide':
            this._updateStrutTracking();
            this._updateAutohide();
            break;
        case 'dock-magnification-enabled':
            this._disableMagnification();
            this._enableMagnification();
            break;
        case 'blur-intensity':
            // Same class of gap as the dock-* keys above: the dock reads
            // this once at build time, so without a listener the slider
            // did nothing to the bar until the next login.
            if (this._blurEffect)
                this._blurEffect.radius = (this._settings.blurIntensity / 100) * MAX_BLUR_RADIUS;
            break;
        }
    }

    _applyIconSize(size = null) {
        const iconSize = size ?? this._effectiveIconSize();
        if (this._appliedIconSize === iconSize)
            return;
        this._appliedIconSize = iconSize;

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
        // `_chromeGone`, not just a null check: at logout the shell destroys
        // its chrome from C before disable() ever runs, which leaves every
        // JS reference here non-null but pointing at a disposed actor. A
        // redisplay already queued at that moment then walked the whole row
        // calling set_child_at_index() on it — about twenty
        // `Gjs-CRITICAL: has been already disposed` lines per logout, plus a
        // `clutter_actor_set_child_at_index: assertion 'child->priv->parent
        // == self' failed`. _layoutDock() has guarded against exactly this
        // since the 'workareas-changed' round; the redisplay path never did.
        if (!this._appsBox || this._chromeGone || this._tearingDown)
            return;

        this._redisplayApps();
        this._redisplayStacks();
        this._layoutDock();
        this._publishIconGeometries();
    }

    /**
     * Session-start state for the recents queue: repair what was stored,
     * then tell the model what is already running so the first redisplay
     * does not read a restored session as a burst of launches — or, worse,
     * the redisplay after a disable/enable as everything quitting at once.
     */
    _loadRecentAppsState() {
        this._recents.load();
        this._recents.seedRunning(this._runningAppIds());
    }

    /**
     * Every running app, including the ones the shell could not match to a
     * desktop entry. Those have no id worth storing (see isPersistentAppId)
     * and the model never persists them, but they do need a slot while they
     * are open — and a slot from the model is a slot that stays put, which
     * a fallback appended at redisplay time would not be.
     */
    _runningAppIds() {
        return this._appSystem.get_running().map(app => app.get_id());
    }

    /**
     * Folds "what is running now" into the recents queue. Called at the top
     * of every redisplay, which is where launches and quits both surface
     * (via 'app-state-changed'): the model seats the launches at the end of
     * the row and lets the quits keep the seats they already have.
     */
    _recordRecentApps() {
        this._recents.syncRunning(this._runningAppIds());
    }

    /**
     * Pinning an app evicts it from the recents history outright, rather
     * than leaving an invisible entry that the display filter hides — see
     * RecentApps.dropPinned() for why that entry was a bug.
     */
    _onFavoritesChanged() {
        this._recents.dropPinned();
        this._queueRedisplay();
    }

    _redisplayApps() {
        // Favorites first (in their configured order), then the open and
        // recent apps in the order the model seated them — and existing
        // icons are repositioned rather than rebuilt, so apps already on the
        // dock never visibly jump around when an unrelated app launches or
        // quits.
        this._recordRecentApps();

        const favoriteApps = this._favorites.getFavorites();
        const favoriteIds = new Set(favoriteApps.map(app => app.get_id()));
        const runningApps = this._appSystem.get_running()
            .filter(app => !favoriteIds.has(app.get_id()));
        const runningById = new Map(runningApps.map(app => [app.get_id(), app]));

        // The whole trailing row in one list, running apps and recents
        // alike, in the order the model assigned their slots — see
        // RecentApps.visibleIds(). Nothing here is sorted by state: an app
        // stays exactly where it arrived whether it is open, quit or
        // reopened, which is the only way an icon never moves under the
        // cursor.
        const windowIds = this._recents.visibleIds();

        const trailingApps = [];
        const seenTrailingIds = new Set();
        const pushTrailing = (id, app) => {
            if (!app || seenTrailingIds.has(id))
                return;
            trailingApps.push(app);
            seenTrailingIds.add(id);
        };

        for (const id of windowIds)
            pushTrailing(id, runningById.get(id) ?? this._appSystem.lookup_app(id));

        // A running app the model has no slot for at all should not exist,
        // but an icon is the one thing a running app must never lack, so
        // any straggler is appended rather than dropped.
        for (const app of runningApps)
            pushTrailing(app.get_id(), app);

        const wantedIds = new Set([...favoriteIds, ...trailingApps.map(app => app.get_id())]);
        for (const [appId, icon] of this._appIcons) {
            if (!wantedIds.has(appId)) {
                icon.destroy();
                this._appIcons.delete(appId);
            }
        }

        const iconSize = this._effectiveIconSize();
        const iconFor = app => {
            const appId = app.get_id();
            let icon = this._appIcons.get(appId);
            if (!icon) {
                icon = this._watchIconLifetime(new DockAppIcon(app));
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
            this._sepRunning.visible = favoriteApps.length > 0 && trailingApps.length > 0;
            this._appsBox.set_child_at_index(this._sepRunning, index++);
        }

        for (const app of trailingApps)
            this._appsBox.set_child_at_index(iconFor(app), index++);

        // Run after the row is built, so icons created by iconFor() in this
        // same pass are covered too.
        //
        // "Remove from Dock" is offered only on icons that are on the dock
        // *purely* because the app was used recently — a pinned app is
        // removed by unpinning it (GNOME's own menu item, which AppMenu
        // already shows), and a running one cannot be removed at all while
        // it is open. Without this there was no way to take a recent app
        // off the dock at all. See DockAppIcon.popupMenu().
        const recentIds = new Set(windowIds.filter(id => !runningById.has(id)));
        for (const [appId, icon] of this._appIcons) {
            icon.removeAction = recentIds.has(appId)
                ? () => this._forgetRecentApp(appId)
                : null;
            icon.setProgress(this._launcherEntries?.entries.get(appId)?.progress ?? -1);
        }
    }

    /**
     * "Remove from Dock" on a recent icon, and the same gesture done by
     * dragging one off the dock. Offered only on icons that are on the dock
     * purely because the app was quit recently: an app that is still open
     * keeps its icon whatever the user drags, so removing it would have to
     * mean "and do not come back when I quit you", a promise nothing here
     * remembers. Dropping such an icon is left as a spring-back.
     */
    _forgetRecentApp(appId) {
        this._recents.forget(appId);
        this._queueRedisplay();
    }

    /** "Clear Recent Apps" on the dock's own context menu. */
    _clearRecentApps() {
        this._recents.clear();
        this._queueRedisplay();
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

        const iconSize = this._effectiveIconSize();
        configs.forEach((config, index) => {
            let icon = this._stackIcons.get(config.id);
            if (!icon) {
                icon = this._watchIconLifetime(new DockFolderIcon(config, iconSize, this._onActivateFolder));
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

    // A 'motion-event' arrives once per *mouse report* — 125Hz on a plain
    // mouse, up to 1000Hz on a gaming one — which is many times per
    // rendered frame. The handler therefore does nothing but record where
    // the pointer is; all the actual work happens once per frame in
    // _stepMagnification(). Doing it inline instead (as this used to) meant
    // recomputing every icon's geometry and tearing down/rebuilding a
    // Clutter.Timeline per icon on every single report — on the order of
    // ten thousand short-lived timelines a second across the row, each one
    // re-registering with the frame clock. That is what made the whole
    // session stutter the moment the pointer crossed the dock: the cost
    // lands in the compositor's own main loop, so it slows down everything
    // on screen, not just the dock.
    _enableMagnification() {
        if (!this._settings.dockMagnificationEnabled || !this._iconBox)
            return;
        this._magnifyMotionId = this._iconBox.connect('motion-event', (_actor, event) => {
            const [stageX] = event.get_coords();
            this._magnifyPointerX = stageX;
            this._magnifySettledFrames = 0;
            this._startMagnifyTicker();
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

    /**
     * Every icon the magnification may touch, minus the ones that are on
     * their way out.
     *
     * The `_gone` filter is not defensive padding. Tearing the shell down
     * destroys our chrome, and removing `_iconBox` from the scene graph
     * makes Clutter emit one last 'leave-event' on it — which lands in the
     * magnification handler and reads `icon.scale_x` off actors whose
     * GObjects are already disposed. That produced a stack-traced
     * `Gjs-CRITICAL` per icon on every logout, plus a Clutter-WARNING for
     * each spring that then tried to start on a stage-less actor. Holding a
     * JS reference is no evidence the underlying object is still alive; the
     * actor's own 'destroy' signal, which fires while it still is, is.
     */
    _magnifiableIcons() {
        const icons = [];
        if (this._showAppsIcon)
            icons.push(this._showAppsIcon);
        icons.push(...this._appIcons.values(), ...this._stackIcons.values());
        if (this._trashIcon)
            icons.push(this._trashIcon);
        return icons.filter(icon => !icon._gone);
    }

    _watchIconLifetime(icon) {
        icon.connect('destroy', () => {
            icon._gone = true;
        });
        return icon;
    }

    // The single frame-clock source that drives magnification. One
    // timeline for the whole row, created when the pointer arrives and
    // stopped once everything has settled — as opposed to one timeline
    // per icon per pointer report, which is what this cost before.
    // repeat_count -1 makes it a plain "tick me every frame" clock; the
    // nominal duration is never read, get_delta() is.
    _startMagnifyTicker() {
        if (this._magnifyTicker || !this._iconBox || this._tearingDown)
            return;

        const ticker = Clutter.Timeline.new_for_actor(this._iconBox, 1000);
        ticker.set_repeat_count(-1);
        ticker.connect('new-frame', () => {
            if (this._stepMagnification(ticker.get_delta()))
                this._magnifySettledFrames = 0;
            else
                this._magnifySettledFrames += 1;

            if (this._magnifySettledFrames >= MAGNIFY_IDLE_FRAMES)
                this._stopMagnifyTicker();
        });
        this._magnifySettledFrames = 0;
        this._magnifyTicker = ticker;
        ticker.start();
    }

    _stopMagnifyTicker() {
        if (!this._magnifyTicker)
            return;
        this._magnifyTicker.stop();
        this._magnifyTicker = null;
    }

    /**
     * Where every icon *wants* to be, given the current pointer position:
     * a Gaussian falloff around it, plus the sideways nudge that keeps
     * grown neighbours from colliding. Pure geometry — nothing is written
     * to any actor here.
     *
     * With the pointer away (`_magnifyPointerX === null`) every target is
     * simply "at rest", which is how the return-to-normal animation reuses
     * the exact same follow code instead of a separate spring.
     */
    _magnificationTargets(icons) {
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
        const entries = icons
            .map(icon => {
                const geometry = getActorGeometry(icon);
                return { icon, restingCenterX: geometry.centerX - icon.translation_x };
            })
            .sort((a, b) => a.restingCenterX - b.restingCenterX);

        const pointerX = this._magnifyPointerX;
        if (pointerX === null) {
            for (const entry of entries) {
                entry.scale = 1;
                entry.translation = 0;
            }
            return { entries, totalExtra: 0 };
        }

        const amount = this._settings.dockMagnificationAmount;
        const range = this._settings.dockMagnificationRange;
        for (const entry of entries) {
            const distance = pointerX - entry.restingCenterX;
            entry.scale = 1 + (amount - 1) * Math.exp(-(distance * distance) / (2 * range * range));
        }

        // Scaling an icon in place (pivot at bottom-center) grows it
        // symmetrically left/right without the row's layout making any
        // room for that growth, so two adjacent magnified icons would
        // visually collide/overlap. Real macOS (and every other
        // dock-magnify implementation) compensates by nudging each
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

        return { entries, totalExtra };
    }

    /**
     * One frame of the follow. Moves every icon (and the bar itself) a
     * fraction of the way toward its current target and returns whether
     * anything is still in motion — false means "settled, stop ticking".
     *
     * The step is `1 - exp(-dt/tau)` rather than a fixed fraction, so the
     * motion looks identical whether the frame clock is running at 60Hz
     * or 165Hz and it does not degrade if a frame is dropped.
     */
    _stepMagnification(deltaMs) {
        if (this._tearingDown || !this._dockActor || !this._iconBox)
            return false;

        const icons = this._magnifiableIcons();
        if (icons.length === 0)
            return false;

        // Clamped at both ends: get_delta() is 0 on a timeline's very first
        // frame, and after a stall (or a missed frame under load) it can
        // report long enough that `blend` saturates at 1 and the icons snap
        // to their target instead of easing into it.
        const dt = Math.min(50, Math.max(1, deltaMs));
        const blend = 1 - Math.exp(-dt / MAGNIFY_TAU);
        const { entries, totalExtra } = this._magnificationTargets(icons);
        let moving = false;

        for (const { icon, scale, translation } of entries) {
            let nextScale = icon.scale_x + (scale - icon.scale_x) * blend;
            let nextTranslation =
                icon.translation_x + (translation - icon.translation_x) * blend;

            // Snap the last sliver instead of approaching it forever: an
            // exponential never actually arrives, and a ticker that never
            // stops is the same class of always-on cost this rewrite is
            // removing. Sub-pixel differences are invisible anyway.
            if (Math.abs(scale - nextScale) < MAGNIFY_SCALE_EPSILON)
                nextScale = scale;
            else
                moving = true;
            if (Math.abs(translation - nextTranslation) < MAGNIFY_PIXEL_EPSILON)
                nextTranslation = translation;
            else
                moving = true;

            icon.set({
                scale_x: nextScale,
                scale_y: nextScale,
                translation_x: nextTranslation,
            });
        }

        if (this._stepDockWidth(this._dockBaseWidth + totalExtra, blend))
            moving = true;

        // Re-run on every frame, not just when the pointer moves: the icon
        // under the pointer keeps growing after the pointer has stopped,
        // and a label placed once at hover time would end up sitting on top
        // of the very icon it names as that icon rises past it.
        this._positionTooltip();

        return moving;
    }

    // Real macOS widens the dock's own bar as its icons grow, and without
    // that the outermost icons — pushed outward by the displacement in
    // _magnificationTargets — simply hang outside the glass, floating on
    // the desktop (the dock deliberately does not clip its children, so a
    // magnified icon can rise above the bar). Growing the bar by exactly
    // the accumulated extra width and re-centring it keeps every icon on
    // the glass. This cannot feed back into the resting positions: the
    // icon row is centre-aligned, so widening the panel by W while moving
    // it left by W/2 leaves the row's centre — and therefore every resting
    // centre — exactly where it was.
    _stepDockWidth(width, blend) {
        if (this._dockBaseWidth == null || this._dockBaseX == null)
            return false;

        const target = Math.round(width);
        const current = this._dockActor.width;
        if (Math.round(current) === target) {
            this._dockTargetWidth = target;
            return false;
        }

        // The width is an integer, so a proportional step smaller than a
        // pixel would round straight back to where it started and the
        // ticker would spin forever without the bar ever moving. Below one
        // pixel of travel, move exactly one.
        let delta = (target - current) * blend;
        if (Math.abs(delta) < 1)
            delta = Math.sign(target - current);

        const next = Math.round(current + delta);
        this._dockTargetWidth = next;
        this._dockActor.set_width(next);
        this._dockActor.set_x(Math.round(this._dockBaseX + (this._dockBaseWidth - next) / 2));
        return true;
    }

    _resetMagnification() {
        this._magnifyPointerX = null;

        if (!this._tearingDown) {
            // Nothing to animate by hand: with no pointer position every
            // target is "at rest", so the same follow that grew the icons
            // shrinks them back.
            this._startMagnifyTicker();
            return;
        }

        // Snap, don't ease: these actors are about to be destroyed and an
        // in-flight animation would outlive them.
        this._stopMagnifyTicker();
        for (const icon of this._magnifiableIcons()) {
            cancelSpring(icon);
            icon.set({ scale_x: 1, scale_y: 1, translation_x: 0 });
        }
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
        // A drag that starts inside an open stack panel is owned by that
        // Stack, not by us, so DockManager's own 'drag-end' wiring never
        // sees it — and ui/dnd.js has no "pointer left this target" call
        // at all. A global drag monitor is the one hook that runs on every
        // motion of every drag: clear the highlight here, and the target
        // walk immediately afterwards re-adds it to whichever icon is
        // actually under the pointer. CONTINUE so the walk still happens.
        this._dragMonitor = {
            dragMotion: () => {
                this._clearDropFeedback();
                return DND.DragMotionResult.CONTINUE;
            },
            dragDrop: () => {
                this._clearDropFeedback();
                return DND.DragDropResult.CONTINUE;
            },
        };
        DND.addDragMonitor(this._dragMonitor);

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
        this._clearDropFeedback();
        // Any live preview reordering is thrown away and the row rebuilt
        // from the model, so the actors can never drift out of sync with
        // what is actually saved.
        this._queueRedisplay();
    }

    /**
     * ui/dnd.js calls handleDragOver as the pointer moves but never tells a
     * target the pointer has left it, so the highlight a target adds has to
     * be cleared from the outside. Every icon is cleared rather than only
     * the last-highlighted one: a fast drag can light up several before any
     * of them is picked again.
     */
    _clearDropFeedback() {
        for (const icon of this._magnifiableIcons())
            icon.clearDropFeedback?.();
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
            if (this._favorites.getFavoriteMap()[appId])
                this._favorites.removeFavorite(appId);
            else if (icon.removeAction)
                // Not pinned, so there is no favourite to remove — but it
                // may still be on the dock as a recent app, and dragging an
                // icon off the Dock is macOS' own gesture for taking it
                // away. Without this the icon simply sprang back, which is
                // half of why recents felt impossible to get rid of.
                //
                // Gated on the same predicate as the menu item, so an app
                // that is merely running is not silently taken out of the
                // recents queue by a gesture that cannot remove its icon
                // anyway — see _forgetRecentApp().
                this._forgetRecentApp(appId);
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
