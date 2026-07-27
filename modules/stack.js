/* stack.js
 *
 * The core of the extension: a Stack represents one configured folder
 * bound to a dock icon. It owns the lifecycle of the floating glass
 * panel — build, animate open, animate close, tear down — and the
 * StackManager coordinates the (at most one) currently open Stack
 * across every configured folder and every dock the extension found.
 */

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import Graphene from 'gi://Graphene';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';

import { SPRING, animateSpring, animateStagger, cancelSpring } from './animations.js';
import { createGlassPanel, createShadowActor } from './glass.js';
import { listDirectory, launchUri, clamp, iconForEntry } from './utils.js';
import { AppearanceManager, applyAppearanceClass } from './appearance.js';

const ITEM_WIDTH = 84;
const ITEM_HEIGHT = 92;
const ITEM_ICON_SIZE = 48;
// macOS' third stack view is a List: one compact row per file, small
// icon on the left, name beside it. What used to live under the same
// setting was a cascading pile of overlapping, rotated tiles — a look
// that corresponds to nothing in macOS, and the reason an opened stack
// read as "nada parecido com mac" for anyone who had that mode selected.
const LIST_ROW_HEIGHT = 26;
const LIST_ICON_SIZE = 18;
const LIST_MARGIN = 8;
// Fan view. Unlike Grid and List this draws NO glass panel at all — in
// macOS the items simply float over the desktop, rising from the dock
// icon along a gentle arc, each one a large icon with its name in a
// dark rounded plate to its left. Ours used to lay the same items out
// *inside* the glass rectangle, which is why it never read as the real
// thing.
const FAN_ICON_SIZE = 56;
const FAN_ROW_HEIGHT = 68; // vertical distance between consecutive items
// The arc. macOS' fan is a curve, not a lean: the column leaves the dock
// icon vertically and swings further out with every row it climbs, so a
// short fan is nearly straight and a tall one bends noticeably. That is why
// the drift grows with the *square* of the row index rather than linearly —
// a flat per-row lean either looks like nothing on a five-item fan or like a
// diagonal on a fifteen-item one.
//
// The unit was first calibrated on the reference shot, which has four
// folders plus the Open in Finder cap: five rows, i.e. a top index of 4,
// and a measured drift of about 9px against 56px icons — 0.01 x 56 x 4^2.
// That reference is simply too short to show much bend, and calibrating the
// whole curve on it made a real, taller fan read as a straight column ("a
// curvatura do leque parece que nao existe"). Raised once to 0.018 (five-row
// drift ~16px), then again here to 0.03 after he asked for more bend a
// second time ("pode encurvar mais a stack de pilha") — a five-row fan now
// drifts ~27px. FAN_ARC_MAX is scaled up by the same factor so a full
// fifteen-item fan still hits its ceiling just before the top row, same as
// before, instead of flattening out several rows early. The quadratic shape
// is unchanged: the column leaves the dock icon vertically and swings
// further out with every row it climbs.
const FAN_ARC_UNIT = FAN_ICON_SIZE * 0.03;
const FAN_ARC_MAX = Math.round(FAN_ICON_SIZE * 4.2);
// How many files the fan will show. macOS switches to Grid once a folder
// outgrows the screen; this instead keeps the fan and shows the newest
// items, capped, with the Open in Finder row as the way to the rest — his
// call, and it means a busy Downloads folder still opens as a fan.
const FAN_MAX_ITEMS = 15;
// macOS keeps the icons and their name plates upright: the arc is in the
// path the column takes, not in the items themselves. Ours tilted every
// row progressively, so thumbnails came out visibly skewed and the text
// plates sat at an angle — which is most of what looked "esquisito".
const FAN_MIN_WIDTH = 200; // floor for the name plates near a screen edge
const FAN_LABEL_GAP = 10; // must match .macos-stack-fan-box's spacing
const FAN_GAP = 8; // clearance between the dock icon and the first fan item
// The "Open in Finder" cap is drawn distinctly smaller than the file icons
// under it — about 60% of their size in the reference shot. Ours matched
// them exactly, so it read as a big grey disc dominating the top of the
// fan instead of as a small badge finishing it off.
const FAN_FINDER_SIZE = Math.round(FAN_ICON_SIZE * 0.6);

// Size of the ghost that follows the pointer when a file is dragged out of
// an open stack. Matched to the Fan's own icon size so the ghost reads as
// the item you grabbed rather than as a new, differently-scaled thing.
const DRAG_ICON_SIZE = FAN_ICON_SIZE;

const LABEL_MAX_HEIGHT = 30; // ~2 lines at the label's 11px font size
const PANEL_MARGIN = 16;
const ARROW_SQUARE = 16; // side of the square that, rotated 45°, forms the pointer
const ARROW_WIDTH = Math.round(ARROW_SQUARE * Math.SQRT2);
const ARROW_HEIGHT = Math.round((ARROW_SQUARE * Math.SQRT2) / 2);
const ICON_GAP = ARROW_HEIGHT + 8; // panel clears the dock icon by the pointer's height
const CORNER_RADIUS = 18;
const MAX_BLUR_RADIUS = 60;

/** Sideways drift of row `index`, measured from the bottom of the fan. */
function fanDrift(index) {
    return Math.min(FAN_ARC_MAX, Math.round(FAN_ARC_UNIT * index * index));
}

/** One configured folder-stack, bound to a dock icon on open(). */
export class Stack {
    constructor(config, settings, appearance) {
        this.config = config; // { id, name, path, icon, mode }
        this._settings = settings;
        this._appearance = appearance;

        this._panel = null;
        this._content = null;
        this._shadow = null;
        this._blurEffect = null;
        this._tint = null;
        this._arrow = null;
        this._arrowSquare = null;
        this._scrollView = null;
        this._gridWidget = null;
        this._items = [];
        this._entries = [];
        this._geometry = null;
        this._built = false;

        this._clickCatcher = null;
        this._catcherPressId = 0;
        this._keyPressId = 0;
        this._timeouts = [];

        this._iconActor = null;
        this._isOpen = false;
        this._isAnimating = false;
    }

    get isOpen() { return this._isOpen; }
    get isAnimating() { return this._isAnimating; }

    // -- public lifecycle ---------------------------------------------

    openStack(iconActor) {
        if (this._isAnimating)
            return;
        if (this._isOpen) {
            this.closeStack();
            return;
        }

        this._isAnimating = true;
        this._iconActor = iconActor;

        listDirectory(this.config.path, entries => {
            // The icon may have been destroyed (dash rebuilt) while we
            // were waiting on the async directory listing.
            if (!this._iconActor || !this._iconActor.get_stage()) {
                this._isAnimating = false;
                return;
            }

            // Resolved once per open and reused by every step below, so
            // the item actors, the panel geometry and the layout can
            // never disagree about which view is being drawn.
            this._mode = this._resolveMode(entries.length);

            // Entries arrive newest-first (see utils.js sortEntries), so
            // truncating from the end keeps the most recent files — which
            // are the ones a Downloads stack exists to show.
            const shown = this._mode === 'fan'
                ? entries.slice(0, this._fanCapacity())
                : entries;

            this.createStack();
            this._applyChromeForMode();
            this._applyPanelStyle();
            this._syncItems(shown);

            const origin = this.calculateOrigin(this._iconActor);
            const geometry = this.positionPanel(origin);
            this._applyGeometry(geometry);
            this._setPivotFromOrigin(origin, geometry);
            this._layoutArrow(origin, geometry);
            this._layoutItems(geometry);

            this._grabInput();
            this.animateGlass();
            this.animateShadow();
            this.animatePanel(() => {
                this._isAnimating = false;
                this._isOpen = true;
                this.animateItems();
            });
        });
    }

    closeStack() {
        if (this._isAnimating || !this._isOpen)
            return;

        this._isAnimating = true;
        this._releaseInput();

        const speed = this._settings.animationSpeed;
        const itemDelay = Math.max(8, Math.round(this._settings.staggerDelay / 2));

        const finishClose = () => {
            const preset = this._settings.overshootEnabled ? SPRING.PANEL : SPRING.SOFT;
            const tilt = this._geometry.direction === 'up' ? 10 : -10;

            animateSpring(this._panel,
                { scale_x: this._panel.scale_x, scale_y: this._panel.scale_y, opacity: this._panel.opacity, rotation_angle_x: this._panel.rotation_angle_x },
                { scale_x: 0.05, scale_y: 0.05, opacity: 0, rotation_angle_x: tilt },
                {
                    duration: 340, speed, preset,
                    onComplete: () => {
                        this._isOpen = false;
                        this._isAnimating = false;
                        // Actors are parked (hidden, tiny, out of the
                        // input path) rather than destroyed, so
                        // reopening the same stack reuses the glass
                        // panel instead of rebuilding it from scratch.
                        //
                        // The stagger timeout ids are not: every open/close
                        // pair appended a dozen more to this array and only
                        // destroyStack() ever emptied it, so a stack opened
                        // repeatedly across a session accumulated ids for
                        // sources that had long since fired and removed
                        // themselves. Harmless individually, unbounded in
                        // aggregate — and it made destroyStack() walk a list
                        // of thousands of stale ids looking each one up in
                        // the main context.
                        this._timeouts = [];
                    },
                });

            if (this._shadow) {
                animateSpring(this._shadow, { opacity: this._shadow.opacity }, { opacity: 0 },
                    { duration: 280, speed, preset: SPRING.SOFT });
            }
            if (this._blurEffect) {
                animateSpring(this._blurEffect, { radius: this._blurEffect.radius }, { radius: 0 },
                    { duration: 280, speed, preset: SPRING.SOFT, actor: this._panel });
            }
        };

        if (this._items.length === 0) {
            finishClose();
            return;
        }

        const timeoutIds = animateStagger(this._animatedActors(), actor => ({
            from: { opacity: actor.opacity, scale_x: actor.scale_x, scale_y: actor.scale_y, translation_y: actor.translation_y },
            to: { opacity: 0, scale_x: 0.85, scale_y: 0.85, translation_y: 8 },
        }), {
            baseDelay: itemDelay, duration: 160, speed, preset: SPRING.SOFT,
            reverse: true, onAllComplete: finishClose,
        });
        this._timeouts.push(...timeoutIds);
    }

    /** Immediate, non-animated teardown — used when the extension is disabled. */
    forceClose() {
        this.destroyStack(); // also releases input and disables parallax
        this._isOpen = false;
        this._isAnimating = false;
    }

    // -- geometry --------------------------------------------------------

    /**
     * The view actually drawn. Fan degrades to Grid once a folder holds
     * more items than can fan up the screen — macOS does the same rather
     * than running the column off the top edge.
     */
    _resolveMode(entryCount) {
        const mode = this._settings.displayMode;
        if (mode !== 'fan')
            return mode;
        // A folder with more files than fit no longer drops to Grid: the
        // fan just shows the newest FAN_MAX_ITEMS of them (see
        // _fanCapacity). Grid is kept only for the case where the screen
        // cannot hold even a token fan, where a one-item "fan" would be
        // nonsense rather than a compromise.
        return this._fanCapacity() >= 2 ? 'fan' : 'grid';
    }

    /**
     * How many files the fan will draw: the smaller of the flat cap and
     * what the screen can actually hold, leaving one row for the "Open in
     * Finder" cap that tops the column off.
     */
    _fanCapacity() {
        const monitorIndex = Main.layoutManager.findIndexForActor(this._iconActor);
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
        const rowsThatFit = Math.floor((workArea.height - FAN_GAP - PANEL_MARGIN) / FAN_ROW_HEIGHT) - 1;
        return Math.max(0, Math.min(FAN_MAX_ITEMS, rowsThatFit));
    }

    calculateOrigin(iconActor) {
        const [x, y] = iconActor.get_transformed_position();
        const [width, height] = iconActor.get_transformed_size();
        return {
            x: x + width / 2,
            y: y + height / 2,
            iconTop: y,
            iconBottom: y + height,
        };
    }

    positionPanel(origin) {
        const monitorIndex = Main.layoutManager.findIndexForActor(this._iconActor);
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);

        const mode = this._mode;
        const columns = clamp(this._settings.gridColumns, 2, 8);

        // In grid mode the panel is sized to its *contents*, the way a
        // real Finder stack is: a folder holding two files opens a small
        // two-item panel, not a fixed-width sheet with a large empty
        // area beside them (which is what a flat `panel-size` floor
        // produced — the single biggest reason this stopped reading as
        // macOS). `panel-size` still applies, but as a ceiling on how
        // wide the grid may get rather than a floor forcing it open, and
        // gridColumns still caps the columns independently.
        let effectiveColumns = columns;
        if (mode === 'grid') {
            const columnsAllowedByWidth = Math.max(1,
                Math.floor((this._settings.panelSize - PANEL_MARGIN * 2) / ITEM_WIDTH));
            effectiveColumns = Math.max(1,
                Math.min(columns, columnsAllowedByWidth, this._entries.length || 1));
        }

        const gridWidth = effectiveColumns * ITEM_WIDTH + PANEL_MARGIN * 2;

        // Fan geometry is driven by one anchor: the icon column has to sit
        // directly above the dock icon the stack came from, with the name
        // plates trailing off to its side. `anchor` is the distance from the
        // container's left edge to that column's right edge; the container's
        // x is then derived from it below rather than centred on the icon,
        // which is what left the whole column about half a panel-width off
        // to the right of its own dock icon.
        //
        // `lean` bends the column away from the nearer screen edge (macOS
        // does the same), and is the only reason the container is ever wider
        // than `anchor`: leaning right needs slack on the right for the drift.
        let lean = 0;
        let anchor = 0;
        let maxDrift = 0;

        let width;
        if (mode === 'grid') {
            width = clamp(gridWidth, ITEM_WIDTH + PANEL_MARGIN * 2, workArea.width - PANEL_MARGIN * 2);
        } else if (mode === 'stack') { // list
            width = clamp(this._settings.panelSize, 180, workArea.width - PANEL_MARGIN * 2);
        } else { // fan
            // The fan splays *outward*, away from the middle of the screen,
            // the way a hand of cards held at the dock would — that is what
            // the reference shot shows (its stack sits right of centre and
            // the column drifts further right as it climbs). This used to
            // lean the other way, toward the centre. Falls back to leaning
            // inward when the outward side has no room, since running the
            // top of the column off the screen edge would be worse than
            // curving the "wrong" way.
            const outward = origin.x >= workArea.x + workArea.width / 2 ? 1 : -1;
            const roomOutward = outward > 0
                ? (workArea.x + workArea.width - PANEL_MARGIN) - (origin.x + FAN_ICON_SIZE / 2)
                : (origin.x - FAN_ICON_SIZE / 2) - (workArea.x + PANEL_MARGIN);
            // The topmost row's drift is what has to fit, and on a tall fan
            // that is far more than one icon's width.
            maxDrift = fanDrift(this._entries.length);
            lean = roomOutward >= maxDrift ? outward : -outward;
            // Name plates always trail to the *left* of the column (as in the
            // reference shot), so the room they have is whatever lies between
            // the dock icon and the left edge of the work area. Near that
            // edge the plates simply get shorter rather than running off it.
            const roomForPlates = origin.x + FAN_ICON_SIZE / 2 - (workArea.x + PANEL_MARGIN);
            anchor = Math.round(clamp(this._settings.panelSize, FAN_MIN_WIDTH,
                Math.max(FAN_MIN_WIDTH, roomForPlates)));
            width = anchor + (lean > 0 ? maxDrift : 0);
        }

        let height;
        let contentHeight;
        if (mode === 'grid') {
            const rows = Math.max(1, Math.ceil(this._entries.length / effectiveColumns));
            // The panel/viewport height is clamped to fit the screen, but
            // the grid's own content can be taller — it scrolls instead of
            // silently clipping files past the visible rows.
            contentHeight = rows * ITEM_HEIGHT + PANEL_MARGIN * 2;
            height = clamp(contentHeight, ITEM_HEIGHT + PANEL_MARGIN * 2, workArea.height - PANEL_MARGIN * 2);
        } else if (mode === 'stack') {
            // List: one row per file, sized to the row count and
            // scrolling once it would run off the screen.
            contentHeight = Math.max(1, this._entries.length) * LIST_ROW_HEIGHT + LIST_MARGIN * 2;
            height = clamp(contentHeight, LIST_ROW_HEIGHT + LIST_MARGIN * 2, workArea.height - PANEL_MARGIN * 2);
        } else {
            // Fan: an invisible container just big enough to hold the
            // arc, one row per item plus the "Open in Finder" cap. It
            // never scrolls — _resolveMode() has already switched to Grid
            // if the column wouldn't fit on screen. No margin: the bottom
            // row has to sit right on the container's bottom edge so the
            // fan visually grows out of the dock icon instead of floating
            // a gap above it.
            const rows = this._entries.length + 1;
            contentHeight = rows * FAN_ROW_HEIGHT;
            height = Math.min(contentHeight, workArea.height - PANEL_MARGIN);
        }

        // Derived from the anchor in fan mode (see above), centred on the
        // icon otherwise.
        let x = mode === 'fan'
            ? Math.round(origin.x + FAN_ICON_SIZE / 2 - anchor)
            : origin.x - width / 2;
        x = clamp(x, workArea.x + PANEL_MARGIN, workArea.x + workArea.width - width - PANEL_MARGIN);

        // The fan draws no pointer, so it needs only a small breathing gap
        // rather than the pointer's full height.
        const gap = mode === 'fan' ? FAN_GAP : ICON_GAP;

        const spaceAbove = origin.iconTop - workArea.y;
        const spaceBelow = (workArea.y + workArea.height) - origin.iconBottom;

        let direction = this._settings.openDirection;
        if (direction === 'auto')
            direction = (spaceAbove >= height + gap || spaceAbove >= spaceBelow) ? 'up' : 'down';

        let y;
        if (direction === 'up')
            y = Math.max(workArea.y + PANEL_MARGIN, origin.iconTop - height - gap);
        else
            y = Math.min(workArea.y + workArea.height - height - PANEL_MARGIN, origin.iconBottom + gap);

        this._geometry = { x, y, width, height, direction, columns: effectiveColumns, contentHeight, anchor, lean, maxDrift };
        return this._geometry;
    }

    _applyGeometry(geometry) {
        this._panel.set_position(geometry.x, geometry.y);
        this._panel.set_size(geometry.width, geometry.height);
        this._shadow.set_position(geometry.x, geometry.y);
        this._shadow.set_size(geometry.width, geometry.height);
        // The scroll view is the visible viewport (clamped to the panel);
        // the grid widget inside it is sized to the full, possibly-taller
        // content so overflow scrolls instead of being clipped and lost.
        this._scrollView.set_size(geometry.width, geometry.height);
        this._gridWidget.set_size(geometry.width, geometry.contentHeight);
    }

    _setPivotFromOrigin(origin, geometry) {
        const px = clamp((origin.x - geometry.x) / geometry.width, 0, 1);
        const py = clamp((origin.y - geometry.y) / geometry.height, 0, 1);
        this._panel.set_pivot_point(px, py);
        this._shadow.set_pivot_point(px, py);
    }

    // -- construction ------------------------------------------------------

    /** Builds the panel actor tree once; a no-op on subsequent opens. */
    createStack() {
        if (this._built)
            return;

        // clipContent: false — the pointer/arrow below is a child of the
        // panel (so it inherits the open/close spring for free) but sits
        // outside the panel's own rectangle, and would be clipped away
        // entirely otherwise. Safe to drop here: the item grid is
        // clipped by its own St.ScrollView viewport, and every
        // background layer carries its own border-radius, so the panel's
        // clip was never what kept those in shape.
        const { panel, content, blurEffect, tint, background } = createGlassPanel({
            cornerRadius: CORNER_RADIUS,
            clipContent: false,
        });
        this._background = background;
        this._panel = panel;
        this._content = content;
        this._blurEffect = blurEffect;
        this._tint = tint;

        this._shadow = createShadowActor({ cornerRadius: CORNER_RADIUS });

        // St.BoxLayout, not plain St.Widget: St.ScrollView.set_child()
        // requires its child to implement the St.Scrollable interface
        // (confirmed via GIRepository introspection —
        // GObject.type_is_a(St.BoxLayout, St.Scrollable) is true,
        // St.Widget's is false), which is also why the child actually
        // gets allocated a size/position by the scroll view's own
        // viewport logic. A previous fix swapped set_child() for
        // add_child() to dodge the "cannot convert to StScrollable"
        // exception that a plain St.Widget threw there — that stopped
        // the crash, but add_child() only inserts the actor into the
        // scene graph without ever feeding it through the scroll view's
        // adjustment/allocation cycle, so the grid (and every item
        // inside it) rendered with no allocation at all: invisible,
        // confirmed live via "Can't update stage views ... needs an
        // allocation" warnings in the real session's journal for
        // exactly these actor types (StBoxLayout/StIcon/StLabel) — the
        // panel chrome still showed, hence an empty-looking balloon.
        // The layout_manager override below still applies on top of
        // St.BoxLayout: _layoutGrid/_layoutFan/_layoutStack position
        // each item with set_position(), which BoxLayout's own default
        // layout would fight, but Clutter.FixedLayout (which honors
        // manually-set positions) works the same on any St.Widget
        // subclass regardless of which one it is.
        // St.Viewport, not St.BoxLayout. Both implement St.Scrollable
        // (which St.ScrollView.set_child() demands, and which a plain
        // St.Widget fails), but St.BoxLayout carries its own box layout
        // and quietly ignores an assigned layout_manager — so every
        // set_position() call in _layoutGrid/_layoutList/_layoutFan was
        // discarded and the items were simply packed left-to-right in a
        // single row, whatever view was selected. Confirmed live: four
        // items reported x=0/460/920/1380 with y=0 across the board.
        // That is why an opened stack never resembled macOS in any mode.
        // St.Viewport is what GNOME's own IconGrid extends for exactly
        // this reason: scrollable *and* it honours its layout manager.
        this._gridWidget = new St.Viewport({
            style_class: 'macos-stack-grid',
            layout_manager: new Clutter.FixedLayout(),
        });

        this._scrollView = new St.ScrollView({
            style_class: 'macos-stack-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true, // thin, auto-hiding — not a GTK trough
            x_expand: true, y_expand: true,
        });
        this._scrollView.set_child(this._gridWidget);
        content.add_child(this._scrollView);

        this._createArrow();

        this._finderButton = this._createFinderButton();
        this._gridWidget.add_child(this._finderButton);

        this._panel.set({ scale_x: 0.05, scale_y: 0.05, opacity: 0 });

        Main.layoutManager.addChrome(this._shadow, { trackFullscreen: true });
        Main.layoutManager.addChrome(this._panel, { trackFullscreen: true });

        this._built = true;
    }

    /**
     * The little triangle that ties the panel back to the dock icon it
     * came from — the single most recognisable piece of a macOS Finder
     * stack, and something this panel simply never drew.
     *
     * Built as a square rotated 45° inside a container clipped to half
     * the resulting diamond's height, so only the lower (downward-
     * pointing) triangle shows. That gets the two angled edges *and*
     * their border for free; drawing a real triangle would otherwise
     * mean a Clutter.Canvas and hand-rolled Cairo paths.
     *
     * It is a child of the panel rather than a sibling so it inherits
     * the panel's own open/close spring, pivot and opacity — no second
     * animation to keep in sync.
     */
    _createArrow() {
        this._arrow = new St.Widget({
            width: ARROW_WIDTH,
            height: ARROW_HEIGHT,
            clip_to_allocation: true,
            layout_manager: new Clutter.FixedLayout(),
            // START alignment stops the panel's BinLayout from
            // stretching it; actual placement is done with
            // translation_x/y, a post-allocation transform the layout
            // manager won't overwrite (a post-allocation transform the
            // BinLayout does not get to override).
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
        });

        this._arrowSquare = new St.Widget({
            style_class: 'macos-stack-arrow',
            width: ARROW_SQUARE,
            height: ARROW_SQUARE,
            pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 }),
            rotation_angle_z: 45,
        });
        // Centred horizontally, with the diamond's own centre level with
        // the container's top edge, so the clip keeps exactly its lower
        // half.
        this._arrowSquare.set_position(
            Math.round(ARROW_WIDTH / 2 - ARROW_SQUARE / 2),
            Math.round(-ARROW_SQUARE / 2));

        this._arrow.add_child(this._arrowSquare);
        this._panel.add_child(this._arrow);
    }

    /**
     * Points the arrow at the dock icon the stack opened from, and
     * flips it to the other edge when the panel opens downward.
     */
    _layoutArrow(origin, geometry) {
        if (!this._arrow)
            return;

        const pointingUp = geometry.direction === 'down';
        this._arrow.rotation_angle_z = pointingUp ? 180 : 0;
        this._arrow.pivot_point = new Graphene.Point({ x: 0.5, y: 0.5 });

        // Kept clear of the rounded corners so the triangle always meets
        // a straight run of the panel's edge.
        const x = clamp(origin.x - geometry.x - ARROW_WIDTH / 2,
            CORNER_RADIUS, geometry.width - CORNER_RADIUS - ARROW_WIDTH);

        this._arrow.translation_x = Math.round(x);
        this._arrow.translation_y = pointingUp
            ? Math.round(-ARROW_HEIGHT)
            : Math.round(geometry.height);
    }

    /** Refreshes the panel's tint/opacity from settings — cheap, so it
     * runs on every open even when the panel itself is being reused. */
    _applyPanelStyle() {
        // The opacity preference drives the *tint layer's* alpha, not a
        // background colour on the root panel actor. Painting an opaque
        // colour on the panel itself defeats the whole glass effect:
        // the panel's own background is drawn into the framebuffer
        // first, so Shell.BlurEffect (BACKGROUND mode, on a child of
        // that same panel) ends up blurring that flat fill instead of
        // the desktop behind it — the blur radius, the sheen and the
        // border all still ran, but the result was a flat opaque grey
        // slab. That is exactly the "fundo feio / não parece o do Mac"
        // report. Capped well below full opacity so the blurred
        // backdrop always stays visible through it, the way a real
        // Finder stack reads.
        const alpha = (clamp(this._settings.panelOpacity, 20, 100) / 100) * 0.6;

        // The fan has no surface of its own. Hiding the decorative layers
        // in _applyChromeForMode() is not enough on its own: the root panel
        // actor carries `.macos-stack-panel`'s own 1px border, which is
        // what still drew a hairline rectangle around the floating items.
        if (this._mode === 'fan') {
            this._panel.set_style('border: none; background: none;');
            return;
        }

        // The tint's *colour* has to follow the light/dark scheme, and
        // because the opacity preference is applied here inline it cannot
        // simply be left to the stylesheet the way the other layers are —
        // an inline background-color wins over the cascade, so this one
        // rule has to know about the scheme itself.
        const scheme = this._appearance?.scheme ?? 'dark';
        applyAppearanceClass(this._panel, scheme);
        const base = scheme === 'light' ? '245, 246, 248' : '28, 28, 32';
        this._panel.set_style(`border-radius: ${CORNER_RADIUS}px;`);
        this._tint?.set_style(
            `border-radius: ${CORNER_RADIUS}px; background-color: rgba(${base}, ${alpha.toFixed(2)});`);
        // The pointer is a separate actor from the tint layer, so it has
        // to be told the same colour or it would read as a differently
        // shaded tab stuck to the panel's edge.
        this._arrowSquare?.set_style(`background-color: rgba(${base}, ${alpha.toFixed(2)});`);
    }

    /**
     * Reconciles `this._items` with a fresh directory listing: reused
     * actors are kept (and simply repositioned by `_layoutItems`),
     * actors for entries that disappeared are destroyed, and new
     * entries get new actors. Avoids rebuilding the whole grid just
     * because the stack is being reopened.
     */
    _syncItems(entries) {
        // A row and a grid tile are built from different actor trees, so
        // switching display mode has to rebuild them rather than reuse
        // and reposition — otherwise a stack reopened in List mode would
        // still be holding grid tiles (icon above, centred caption) laid
        // out on list coordinates.
        const mode = this._mode;
        if (this._itemsMode !== mode) {
            for (const item of this._items) {
                cancelSpring(item);
                item.destroy();
            }
            this._items = [];
            this._entries = [];
            this._itemsMode = mode;
        }

        const stillWanted = new Set(entries.map(e => e.uri));
        const alreadyPresent = new Set(this._entries.map(e => e.uri));

        this._items = this._items.filter(item => {
            if (stillWanted.has(item._entryUri))
                return true;
            cancelSpring(item);
            item.destroy();
            return false;
        });

        for (const entry of entries) {
            if (!alreadyPresent.has(entry.uri)) {
                const item = this._createItemActor(entry);
                item.set_pivot_point(0.5, 0.5);
                this._gridWidget.add_child(item);
                this._items.push(item);
            }
        }

        const order = new Map(entries.map((entry, index) => [entry.uri, index]));
        this._items.sort((a, b) => order.get(a._entryUri) - order.get(b._entryUri));

        this._entries = entries;
    }

    _iconForEntry(entry) {
        return iconForEntry(entry);
    }

    _createItemActor(entry) {
        let item;
        if (this._mode === 'stack')
            item = this._createListRowActor(entry);
        else if (this._mode === 'fan')
            item = this._createFanRowActor(entry);
        else
            item = this._createTileActor(entry);
        this._makeEntryDraggable(item, entry);
        return item;
    }

    /**
     * Lets a file be dragged straight out of an open stack, the way a
     * macOS stack's contents can be dragged onto the Trash or onto another
     * app in the Dock. Wired here rather than in each of the three item
     * builders so the three views can never drift apart on this.
     *
     * What this is NOT: a drag into another *application's* window. GNOME
     * Shell's DND (ui/dnd.js) is entirely internal to the compositor
     * process — it has no bridge to the Wayland data-device protocol, so
     * there is no way for an extension to hand a drag off to a client
     * window the way the Finder hands one to another Mac app. Everything
     * the shell itself draws is reachable; nothing a client draws is.
     */
    _makeEntryDraggable(item, entry) {
        // ui/dnd.js reads getDragActor/getDragActorSource off
        // `actor._delegate`, and passes that same object to a drop
        // target's acceptDrop as `source`. So the delegate is the item
        // itself, and the two `stack*` properties below are the contract
        // the dock's drop targets match on (see dockTrashIcon.js,
        // dockAppIcon.js, dockFolderIcon.js).
        item._delegate = item;
        item.stackEntryUri = entry.uri;
        item.stackFolderPath = this.config.path;

        // A lightweight clone follows the pointer, so the real item is
        // never reparented out of the panel's grid mid-drag — the same
        // reason DockFolderIcon does this.
        item.getDragActor = () => new St.Icon({
            gicon: this._iconForEntry(entry),
            icon_size: DRAG_ICON_SIZE,
        });
        item.getDragActorSource = () => item;

        const draggable = DND.makeDraggable(item, { timeoutThreshold: 200 });
        // macOS closes the stack the moment you pull an item out of it, and
        // here that is load-bearing rather than cosmetic: _grabInput()
        // parks a full-screen reactive click catcher over the desktop, and
        // ui/dnd.js resolves drop targets with
        // get_actor_at_pos(PickMode.ALL, …) — which that catcher would win
        // for every drop, everywhere on screen. closeStack() calls
        // _releaseInput(), which destroys it. Item actors are only parked
        // (never destroyed) by a close, so `item` stays valid for the rest
        // of the drag.
        draggable.connect('drag-begin', () => this.closeStack());
        item._entryDraggable = draggable;
    }

    /** One row of the List view: small icon, then the name beside it. */
    _createListRowActor(entry) {
        const button = new St.Button({
            style_class: 'macos-stack-row',
            can_focus: true,
            reactive: true,
            height: LIST_ROW_HEIGHT,
        });
        button._entryUri = entry.uri;

        const box = new St.BoxLayout({
            vertical: false,
            style_class: 'macos-stack-row-box',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true, y_expand: true,
        });

        box.add_child(new St.Icon({
            gicon: this._iconForEntry(entry),
            icon_size: LIST_ICON_SIZE,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const label = new St.Label({
            text: entry.name,
            style_class: 'macos-stack-row-label',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        // A row is a single line; long names truncate rather than wrap.
        label.clutter_text.set_line_wrap(false);
        label.clutter_text.set_ellipsize(Pango.EllipsizeMode.MIDDLE);
        box.add_child(label);

        button.set_child(box);
        button.connect('clicked', () => {
            launchUri(entry.uri);
            this.closeStack();
        });
        return button;
    }

    /**
     * One item of the Fan: a dark name plate, then a large icon to its
     * right, the pair pushed against the row's right edge so every icon
     * lines up in a column while the plates trail off to the left at
     * whatever width their text needs.
     */
    _createFanRowActor(entry) {
        const button = new St.Button({
            style_class: 'macos-stack-fan-item',
            can_focus: true,
            reactive: true,
            height: FAN_ROW_HEIGHT,
        });
        button._entryUri = entry.uri;

        const box = new St.BoxLayout({
            vertical: false,
            style_class: 'macos-stack-fan-box',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true, y_expand: true,
        });

        const label = new St.Label({
            text: entry.name,
            style_class: 'macos-stack-fan-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.set_line_wrap(false);
        label.clutter_text.set_ellipsize(Pango.EllipsizeMode.MIDDLE);
        box.add_child(label);
        // _layoutFan caps this once the row's width is known — an
        // unconstrained ellipsized St.Label reports its full natural width
        // and would push the icon out of the column instead of truncating.
        button._fanLabel = label;

        box.add_child(this._createFanIcon(this._iconForEntry(entry)));

        button.set_child(box);
        button.connect('clicked', () => {
            launchUri(entry.uri);
            this.closeStack();
        });
        return button;
    }

    /**
     * A fan icon inside a fixed square. St.Icon treats `icon_size` as a
     * bound on the longer side, so a portrait thumbnail (a screenshot, say)
     * comes out narrower and taller than a square app icon — enough to
     * break both the column's right edge and the row rhythm. The bin pins
     * the footprint; the icon just centres inside it at its own aspect.
     */
    _createFanIcon(gicon) {
        const bin = new St.Bin({
            width: FAN_ICON_SIZE,
            height: FAN_ICON_SIZE,
            y_align: Clutter.ActorAlign.CENTER,
        });
        bin.set_child(new St.Icon({
            gicon,
            icon_size: FAN_ICON_SIZE,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        return bin;
    }

    /** The "Open in Finder" cap that tops off a macOS fan. */
    _createFinderButton() {
        const button = new St.Button({
            style_class: 'macos-stack-fan-item',
            can_focus: true,
            reactive: true,
            height: FAN_ROW_HEIGHT,
        });

        const box = new St.BoxLayout({
            vertical: false,
            style_class: 'macos-stack-fan-box',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true, y_expand: true,
        });

        const label = new St.Label({
            text: 'Abrir no Gerenciador de Arquivos',
            style_class: 'macos-stack-fan-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.set_line_wrap(false);
        label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        box.add_child(label);
        button._fanLabel = label;

        // The circular badge macOS uses for this row, rather than the
        // folder's own icon.
        // Centred inside a full-width bin so the badge, though smaller than
        // the file icons below it, still sits on the same column axis they
        // do rather than hugging the row's right edge.
        const slot = new St.Bin({
            width: FAN_ICON_SIZE,
            height: FAN_ICON_SIZE,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const badge = new St.Bin({
            style_class: 'macos-stack-fan-finder',
            width: FAN_FINDER_SIZE,
            height: FAN_FINDER_SIZE,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        badge.set_style(`border-radius: ${FAN_FINDER_SIZE}px;`);
        badge.set_child(new St.Icon({
            icon_name: 'go-next-symbolic',
            icon_size: Math.round(FAN_FINDER_SIZE * 0.55),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        slot.set_child(badge);
        box.add_child(slot);

        button.set_child(box);
        button.connect('clicked', () => {
            launchUri(Gio.File.new_for_path(this.config.path).get_uri());
            this.closeStack();
        });
        return button;
    }

    _createTileActor(entry) {
        const button = new St.Button({
            style_class: 'macos-stack-item',
            can_focus: true,
            reactive: true,
            width: ITEM_WIDTH,
            height: ITEM_HEIGHT,
        });
        button._entryUri = entry.uri;

        const box = new St.BoxLayout({
            vertical: true,
            style_class: 'macos-stack-item-box',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true, y_expand: true,
        });

        const icon = new St.Icon({
            gicon: this._iconForEntry(entry),
            icon_size: ITEM_ICON_SIZE,
            style_class: 'macos-stack-item-icon',
        });

        // Clutter.Text has no set_lines()/"max lines" API at all (that's
        // a Gtk.Label-ism) — calling it threw a TypeError inside the
        // async listDirectory callback every time a stack was opened,
        // silently aborting the whole open (confirmed live via headless
        // testing: this is why folder-stacks appeared to do nothing on
        // click). The correct native way to clamp wrapped text to N
        // lines with a trailing ellipsis is line_wrap + ellipsize
        // together with a capped actor height — Pango wraps up to
        // whatever fits in that height and ellipsizes the last line.
        const label = new St.Label({
            text: entry.name,
            style_class: 'macos-stack-item-label',
            height: LABEL_MAX_HEIGHT,
        });
        label.clutter_text.set_line_wrap(true);
        label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);

        box.add_child(icon);
        box.add_child(label);
        button.set_child(box);
        button.connect('clicked', () => {
            launchUri(entry.uri);
            this.closeStack();
        });
        return button;
    }

    // -- layout (grid / fan / stack) ---------------------------------------

    _layoutItems(geometry) {
        const mode = this._mode;
        if (mode === 'fan')
            this._layoutFan(geometry);
        else if (mode === 'stack')
            this._layoutList(geometry);
        else
            this._layoutGrid(geometry);
    }

    /** macOS' List view: one full-width row per file, top to bottom. */
    _layoutList(geometry) {
        const rowWidth = geometry.width - LIST_MARGIN * 2;
        this._items.forEach((item, index) => {
            item.set_size(rowWidth, LIST_ROW_HEIGHT);
            item.set_position(LIST_MARGIN, LIST_MARGIN + index * LIST_ROW_HEIGHT);
            item.rotation_angle_z = 0;
        });
    }

    _layoutGrid(geometry) {
        const columns = geometry.columns;
        this._items.forEach((item, index) => {
            const col = index % columns;
            const row = Math.floor(index / columns);
            const rowWidth = Math.min(columns, this._items.length - row * columns) * ITEM_WIDTH;
            const offsetX = (geometry.width - rowWidth) / 2;
            item.set_position(
                offsetX + col * ITEM_WIDTH,
                PANEL_MARGIN + row * ITEM_HEIGHT
            );
        });
    }

    /**
     * Items stack upward from the dock icon, the column bending gently
     * outward as it climbs, with the "Open in Finder" row on top. The rows
     * themselves stay upright — in macOS the arc is in the path, not in the
     * items.
     *
     * Rows are right-aligned and *resized* rather than shifted: their
     * right edge is the icon column, so setting each row's width sets
     * where its icon lands. Shifting a full-width row along the arc
     * instead (what this used to do) pushed the topmost icons past the
     * container's own right edge, which is why the "Open in Finder" badge
     * came out sliced in half.
     */
    _layoutFan(geometry) {
        const rows = [...this._items];
        if (this._finderButton)
            rows.push(this._finderButton);

        const bottom = geometry.contentHeight;

        rows.forEach((row, index) => {
            // Quadratic in the row index: the column leaves the dock icon
            // vertically and swings out further with each row, so the
            // bottom item still sits squarely on its own icon while the top
            // of a tall fan curves away properly. A sin() ramp normalised
            // over the row count did the opposite — it produced the same
            // small total drift whether the fan had four items or fifteen,
            // which is why a long fan read as a straight line.
            const drift = fanDrift(index);
            const rowWidth = geometry.anchor + geometry.lean * drift;
            row.set_size(rowWidth, FAN_ROW_HEIGHT);
            row.set_position(0, bottom - (index + 1) * FAN_ROW_HEIGHT);
            // Explicitly flattened, not merely left unset: a row actor can
            // be reused across opens, and a rotation left over from the
            // previous layout would survive a plain resize.
            row.rotation_angle_z = 0;

            if (row._fanLabel) {
                // Measured unconstrained (a previous open may have pinned a
                // width), then capped to whatever the row leaves beside the
                // icon column so long names ellipsize instead of shoving the
                // icon out of alignment.
                row._fanLabel.set_width(-1);
                const [, natural] = row._fanLabel.get_preferred_width(-1);
                row._fanLabel.set_width(
                    Math.max(48, Math.min(natural, rowWidth - FAN_ICON_SIZE - FAN_LABEL_GAP)));
            }
        });
    }

    /**
     * The Fan draws no panel: macOS shows its items floating over the
     * desktop with nothing behind them. Every decorative layer, the
     * pointer and the drop shadow are switched off for it, leaving the
     * panel as a bare, invisible container for the rows.
     */
    _applyChromeForMode() {
        const bare = this._mode === 'fan';
        for (const layer of this._background ?? [])
            layer.visible = !bare;
        if (this._arrow)
            this._arrow.visible = !bare;
        if (this._shadow)
            this._shadow.visible = !bare;

        // The fan is taller than its rows strictly need and must not be
        // clipped to a viewport; grid/list keep their scrolling one.
        this._scrollView.vscrollbar_policy = bare ? St.PolicyType.NEVER : St.PolicyType.AUTOMATIC;

        if (this._finderButton)
            this._finderButton.visible = bare;
    }

    // -- animation -----------------------------------------------------

    animatePanel(onComplete) {
        const preset = this._settings.overshootEnabled ? SPRING.PANEL : SPRING.SOFT;
        const speed = this._settings.animationSpeed;
        const tilt = this._geometry.direction === 'up' ? 14 : -14;

        animateSpring(this._panel,
            { scale_x: 0.05, scale_y: 0.05, opacity: 0, rotation_angle_x: tilt },
            { scale_x: 1, scale_y: 1, opacity: 255, rotation_angle_x: 0 },
            { duration: 480, speed, preset, onComplete });
    }

    animateGlass() {
        // No glass surface in fan mode — nothing to blur behind.
        if (this._mode === 'fan')
            return;
        const speed = this._settings.animationSpeed;
        const targetRadius = (this._settings.blurIntensity / 100) * MAX_BLUR_RADIUS;
        animateSpring(this._blurEffect, { radius: 0 }, { radius: targetRadius },
            { duration: 420, speed, preset: SPRING.SOFT, actor: this._panel });
    }

    animateShadow() {
        if (!this._settings.shadowEnabled || this._mode === 'fan')
            return;
        const speed = this._settings.animationSpeed;
        animateSpring(this._shadow, { opacity: 0 }, { opacity: 200 },
            { duration: 520, speed, preset: SPRING.SOFT });
    }

    /** Items plus, in fan mode, the "Open in Finder" cap. */
    _animatedActors() {
        return this._mode === 'fan' && this._finderButton
            ? [...this._items, this._finderButton]
            : this._items;
    }

    animateItems() {
        const speed = this._settings.animationSpeed;
        const delay = this._settings.staggerDelay;

        for (const item of this._animatedActors())
            item.set({ opacity: 0, scale_x: 0.85, scale_y: 0.85, translation_y: 12 });

        const timeoutIds = animateStagger(this._animatedActors(), () => ({
            from: { opacity: 0, scale_x: 0.85, scale_y: 0.85, translation_y: 12 },
            to: { opacity: 255, scale_x: 1, scale_y: 1, translation_y: 0 },
        }), { baseDelay: delay, duration: 260, speed, preset: SPRING.ITEM });
        this._timeouts.push(...timeoutIds);
    }

    // -- input handling --------------------------------------------------

    _grabInput() {
        this._clickCatcher = new Clutter.Actor({ reactive: true });
        this._clickCatcher.set_position(0, 0);
        this._clickCatcher.set_size(global.stage.width, global.stage.height);

        Main.layoutManager.addChrome(this._clickCatcher);
        Main.layoutManager.uiGroup.set_child_below_sibling(this._clickCatcher, this._shadow);

        this._catcherPressId = this._clickCatcher.connect('button-press-event', () => {
            this.closeStack();
            return Clutter.EVENT_STOP;
        });

        this._keyPressId = global.stage.connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this.closeStack();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _releaseInput() {
        if (this._clickCatcher) {
            this._clickCatcher.disconnect(this._catcherPressId);
            this._clickCatcher.destroy();
            this._clickCatcher = null;
            this._catcherPressId = 0;
        }
        if (this._keyPressId) {
            global.stage.disconnect(this._keyPressId);
            this._keyPressId = 0;
        }
    }

    // -- teardown --------------------------------------------------------

    destroyStack() {
        this._releaseInput();

        // Looked up before removing, rather than removing inside a
        // try/catch: an already-fired stagger timeout has self-removed, and
        // g_source_remove() on a stale id *logs* "Source ID N was not found
        // when attempting to remove it" as a GLib-CRITICAL and returns
        // false — it never throws, so the catch below caught nothing and
        // every close-while-animating spewed one critical per item.
        const context = GLib.MainContext.default();
        for (const id of this._timeouts) {
            const source = context.find_source_by_id(id);
            if (source && !source.is_destroyed())
                source.destroy();
        }
        this._timeouts = [];

        cancelSpring(this._panel);
        cancelSpring(this._shadow);
        cancelSpring(this._blurEffect);
        for (const item of this._items)
            cancelSpring(item);

        this._panel?.destroy();
        this._shadow?.destroy();

        this._panel = null;
        this._content = null;
        this._shadow = null;
        this._blurEffect = null;
        this._tint = null;
        this._arrow = null;
        this._arrowSquare = null;
        this._background = null;
        this._finderButton = null;
        this._scrollView = null;
        this._gridWidget = null;
        this._items = [];
        this._entries = [];
        this._iconActor = null;
        this._built = false;
    }
}

/** Coordinates every configured Stack, ensuring only one is open at a time. */
export class StackManager {
    constructor(settings) {
        this._settings = settings;
        this._stacks = new Map();
        this._active = null;

        // Shared with every Stack this manager owns: a panel is built
        // lazily on first open, so each one asks for the current scheme
        // when it needs it rather than being told about changes it may
        // not have actors for yet.
        this._appearance = new AppearanceManager(settings);

        // A Stack now keeps its actors parked (not destroyed) between
        // opens for reuse, so if its folder is ever removed from
        // preferences it needs an explicit teardown here — otherwise
        // it would just sit around fully built but unreachable.
        this._settingsChangedId = this._settings.connectChanged((_s, key) => {
            if (key === 'stacks')
                this._pruneRemoved();
        });
    }

    toggle(config, iconActor) {
        let stack = this._stacks.get(config.id);
        if (!stack) {
            stack = new Stack(config, this._settings, this._appearance);
            this._stacks.set(config.id, stack);
        }

        if (this._active && this._active !== stack && this._active.isOpen)
            this._active.closeStack();

        stack.openStack(iconActor);
        this._active = stack;
    }

    _pruneRemoved() {
        const validIds = new Set(this._settings.getStacks().map(s => s.id));
        for (const [id, stack] of this._stacks) {
            if (validIds.has(id))
                continue;
            stack.forceClose();
            this._stacks.delete(id);
            if (this._active === stack)
                this._active = null;
        }
    }

    destroy() {
        this._settings.disconnectChanged(this._settingsChangedId);
        for (const stack of this._stacks.values())
            stack.forceClose();
        this._stacks.clear();
        this._active = null;
        this._appearance?.destroy();
        this._appearance = null;
    }
}
