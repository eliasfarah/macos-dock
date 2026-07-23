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
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { SPRING, animateSpring, animateStagger, cancelSpring } from './animations.js';
import { createGlassPanel, createShadowActor } from './glass.js';
import { listDirectory, launchUri, clamp } from './utils.js';

const ITEM_WIDTH = 84;
const ITEM_HEIGHT = 92;
const ITEM_ICON_SIZE = 48;
const PANEL_MARGIN = 16;
const ICON_GAP = 18; // gap kept between the dock icon and the panel
const CORNER_RADIUS = 18;
const MAX_BLUR_RADIUS = 60;
const MAX_TILT_DEGREES = 2.5; // subtle — a hint of parallax, not a flip
const GLARE_OPACITY = 45;

/** One configured folder-stack, bound to a dock icon on open(). */
export class Stack {
    constructor(config, settings) {
        this.config = config; // { id, name, path, icon, mode }
        this._settings = settings;

        this._panel = null;
        this._content = null;
        this._shadow = null;
        this._blurEffect = null;
        this._glare = null;
        this._scrollView = null;
        this._gridWidget = null;
        this._items = [];
        this._entries = [];
        this._geometry = null;
        this._built = false;

        this._clickCatcher = null;
        this._catcherPressId = 0;
        this._keyPressId = 0;
        this._motionId = 0;
        this._leaveId = 0;
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

            this.createStack();
            this._applyPanelStyle();
            this._syncItems(entries);

            const origin = this.calculateOrigin(this._iconActor);
            const geometry = this.positionPanel(origin);
            this._applyGeometry(geometry);
            this._setPivotFromOrigin(origin, geometry);
            this._layoutItems(geometry);

            this._grabInput();
            this.animateGlass();
            this.animateShadow();
            this.animatePanel(() => {
                this._isAnimating = false;
                this._isOpen = true;
                this.animateItems();
                this._enableParallax();
            });
        });
    }

    closeStack() {
        if (this._isAnimating || !this._isOpen)
            return;

        this._isAnimating = true;
        this._releaseInput();
        this._disableParallax();

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
                    },
                });

            if (this._shadow) {
                animateSpring(this._shadow, { opacity: this._shadow.opacity }, { opacity: 0 },
                    { duration: 280, speed, preset: SPRING.SOFT });
            }
            if (this._blurEffect) {
                animateSpring(this._blurEffect, { radius: this._blurEffect.radius }, { radius: 0 },
                    { duration: 280, speed, preset: SPRING.SOFT });
            }
        };

        if (this._items.length === 0) {
            finishClose();
            return;
        }

        const timeoutIds = animateStagger(this._items, actor => ({
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

        const mode = this._settings.displayMode;
        const columns = clamp(this._settings.gridColumns, 2, 8);
        const width = clamp(this._settings.panelSize, 240, workArea.width - PANEL_MARGIN * 2);

        let height;
        let contentHeight;
        if (mode === 'grid') {
            const rows = Math.max(1, Math.ceil(this._entries.length / columns));
            // The panel/viewport height is clamped to fit the screen, but
            // the grid's own content can be taller — it scrolls instead of
            // silently clipping files past the visible rows.
            contentHeight = rows * ITEM_HEIGHT + PANEL_MARGIN * 2;
            height = clamp(contentHeight, 160, workArea.height - PANEL_MARGIN * 2);
        } else {
            // Fan / stack modes want open space to spread items in, so
            // they use a squarer area rather than growing with rows, and
            // don't scroll — items are deliberately laid out to fit.
            height = clamp(width * 0.72, 200, workArea.height - PANEL_MARGIN * 2);
            contentHeight = height;
        }

        let x = clamp(origin.x - width / 2, workArea.x + PANEL_MARGIN, workArea.x + workArea.width - width - PANEL_MARGIN);

        const spaceAbove = origin.iconTop - workArea.y;
        const spaceBelow = (workArea.y + workArea.height) - origin.iconBottom;

        let direction = this._settings.openDirection;
        if (direction === 'auto')
            direction = (spaceAbove >= height + ICON_GAP || spaceAbove >= spaceBelow) ? 'up' : 'down';

        let y;
        if (direction === 'up')
            y = Math.max(workArea.y + PANEL_MARGIN, origin.iconTop - height - ICON_GAP);
        else
            y = Math.min(workArea.y + workArea.height - height - PANEL_MARGIN, origin.iconBottom + ICON_GAP);

        this._geometry = { x, y, width, height, direction, columns, contentHeight };
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

        const { panel, content, blurEffect, glare } = createGlassPanel({ cornerRadius: CORNER_RADIUS });
        this._panel = panel;
        this._content = content;
        this._blurEffect = blurEffect;
        this._glare = glare;

        this._shadow = createShadowActor({ cornerRadius: CORNER_RADIUS });

        this._gridWidget = new St.Widget({
            style_class: 'macos-stack-grid',
            // FixedLayout, not BinLayout: _layoutGrid/_layoutFan/_layoutStack
            // position each item with set_position(), which BinLayout would
            // ignore (it aligns children via x-align/y-align instead of
            // honoring a fixed position) — every item would collapse onto
            // the same spot. FixedLayout is the one that actually respects
            // manually-set child positions.
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

        this._panel.set({ scale_x: 0.05, scale_y: 0.05, opacity: 0 });

        Main.layoutManager.addChrome(this._shadow, { trackFullscreen: true });
        Main.layoutManager.addChrome(this._panel, { trackFullscreen: true });

        this._built = true;
    }

    /** Refreshes the panel's tint/opacity from settings — cheap, so it
     * runs on every open even when the panel itself is being reused. */
    _applyPanelStyle() {
        const alpha = clamp(this._settings.panelOpacity, 20, 100) / 100;
        this._panel.set_style(`border-radius: ${CORNER_RADIUS}px; background-color: rgba(30, 30, 32, ${alpha.toFixed(2)});`);
    }

    /**
     * Reconciles `this._items` with a fresh directory listing: reused
     * actors are kept (and simply repositioned by `_layoutItems`),
     * actors for entries that disappeared are destroyed, and new
     * entries get new actors. Avoids rebuilding the whole grid just
     * because the stack is being reopened.
     */
    _syncItems(entries) {
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
        if (!entry.isDirectory && entry.thumbnailValid && entry.thumbnailPath) {
            try {
                return new Gio.FileIcon({ file: Gio.File.new_for_path(entry.thumbnailPath) });
            } catch (error) {
                // Fall through to the generic content-type icon below.
            }
        }
        return entry.gicon;
    }

    _createItemActor(entry) {
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

        const label = new St.Label({ text: entry.name, style_class: 'macos-stack-item-label' });
        label.clutter_text.set_line_wrap(true);
        label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        label.clutter_text.set_lines(2);

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
        const mode = this._settings.displayMode;
        if (mode === 'fan')
            this._layoutFan(geometry);
        else if (mode === 'stack')
            this._layoutStack(geometry);
        else
            this._layoutGrid(geometry);
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

    _layoutFan(geometry) {
        const centerX = geometry.width / 2;
        const baseY = geometry.height - ITEM_HEIGHT / 2 - PANEL_MARGIN;
        const radius = Math.min(geometry.width, geometry.height * 1.6) / 2 - ITEM_WIDTH / 2;
        const count = this._items.length;
        const spread = Math.min(Math.PI * 0.8, 0.22 * count + 0.2);

        this._items.forEach((item, index) => {
            const t = count === 1 ? 0.5 : index / (count - 1);
            const angle = -spread / 2 + t * spread;
            const x = centerX + radius * Math.sin(angle) - ITEM_WIDTH / 2;
            const y = baseY - radius * Math.cos(angle) * 0.9 - ITEM_HEIGHT / 2;
            item.set_position(x, y);
            item.rotation_angle_z = (angle * 180) / Math.PI;
        });
    }

    _layoutStack(geometry) {
        const centerX = (geometry.width - ITEM_WIDTH) / 2;
        const centerY = (geometry.height - ITEM_HEIGHT) / 2;
        this._items.forEach((item, index) => {
            const cascade = index * 8;
            const x = centerX + cascade;
            const y = centerY - cascade;
            item.set_position(x, y);
            item.rotation_angle_z = index * 1.5;
        });
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
        const speed = this._settings.animationSpeed;
        const targetRadius = (this._settings.blurIntensity / 100) * MAX_BLUR_RADIUS;
        animateSpring(this._blurEffect, { radius: 0 }, { radius: targetRadius },
            { duration: 420, speed, preset: SPRING.SOFT });
    }

    animateShadow() {
        if (!this._settings.shadowEnabled)
            return;
        const speed = this._settings.animationSpeed;
        animateSpring(this._shadow, { opacity: 0 }, { opacity: 200 },
            { duration: 520, speed, preset: SPRING.SOFT });
    }

    animateItems() {
        const speed = this._settings.animationSpeed;
        const delay = this._settings.staggerDelay;

        for (const item of this._items)
            item.set({ opacity: 0, scale_x: 0.85, scale_y: 0.85, translation_y: 12 });

        const timeoutIds = animateStagger(this._items, () => ({
            from: { opacity: 0, scale_x: 0.85, scale_y: 0.85, translation_y: 12 },
            to: { opacity: 255, scale_x: 1, scale_y: 1, translation_y: 0 },
        }), { baseDelay: delay, duration: 260, speed, preset: SPRING.ITEM });
        this._timeouts.push(...timeoutIds);
    }

    // -- pointer parallax / glass glare -----------------------------------
    //
    // Purely cosmetic material response to the cursor: a very small tilt
    // of the whole panel plus a soft glare that follows the pointer,
    // like light catching a glass/aqua surface. Only active once the
    // opening spring has fully settled (and turned off before the
    // closing spring starts) so it never fights the panel's own
    // rotation_angle_x, which the open/close springs also drive.

    _enableParallax() {
        if (this._motionId || !this._panel)
            return;

        this._motionId = this._panel.connect('motion-event', (_actor, event) => {
            const [stageX, stageY] = event.get_coords();
            this._updateParallax(stageX, stageY);
            return Clutter.EVENT_PROPAGATE;
        });
        this._leaveId = this._panel.connect('leave-event', () => {
            this._resetParallax();
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _disableParallax() {
        if (this._motionId) {
            this._panel.disconnect(this._motionId);
            this._motionId = 0;
        }
        if (this._leaveId) {
            this._panel.disconnect(this._leaveId);
            this._leaveId = 0;
        }
        if (this._panel)
            this._panel.rotation_angle_y = 0;
        if (this._glare)
            this._glare.opacity = 0;
    }

    _updateParallax(stageX, stageY) {
        // A leave→enter within the same idle period can catch the
        // "return to neutral" spring from _resetParallax() still
        // in-flight; cancel it so our direct writes below aren't
        // fighting its per-frame updates on the same properties.
        cancelSpring(this._panel);

        const g = this._geometry;
        const localX = clamp((stageX - g.x) / g.width, 0, 1);
        const localY = clamp((stageY - g.y) / g.height, 0, 1);

        this._panel.rotation_angle_y = (localX - 0.5) * 2 * MAX_TILT_DEGREES;
        this._panel.rotation_angle_x = -(localY - 0.5) * 2 * MAX_TILT_DEGREES;

        if (this._glare) {
            this._glare.set({
                translation_x: stageX - g.x - this._glare.width / 2,
                translation_y: stageY - g.y - this._glare.height / 2,
                opacity: GLARE_OPACITY,
            });
        }
    }

    _resetParallax() {
        if (!this._panel)
            return;
        const speed = this._settings.animationSpeed;
        animateSpring(this._panel,
            { rotation_angle_x: this._panel.rotation_angle_x, rotation_angle_y: this._panel.rotation_angle_y },
            { rotation_angle_x: 0, rotation_angle_y: 0 },
            { duration: 260, speed, preset: SPRING.SOFT });

        if (this._glare) {
            animateSpring(this._glare, { opacity: this._glare.opacity }, { opacity: 0 },
                { duration: 220, speed, preset: SPRING.SOFT });
        }
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
        this._disableParallax();
        this._releaseInput();

        for (const id of this._timeouts) {
            try {
                GLib.Source.remove(id);
            } catch (error) {
                // Already fired (and self-removed) — nothing to clean up.
            }
        }
        this._timeouts = [];

        cancelSpring(this._panel);
        cancelSpring(this._shadow);
        cancelSpring(this._blurEffect);
        cancelSpring(this._glare);
        for (const item of this._items)
            cancelSpring(item);

        this._panel?.destroy();
        this._shadow?.destroy();

        this._panel = null;
        this._content = null;
        this._shadow = null;
        this._blurEffect = null;
        this._glare = null;
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
            stack = new Stack(config, this._settings);
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
    }
}
