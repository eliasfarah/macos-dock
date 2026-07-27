/* glass.js
 *
 * Builds the layered "glass" visual used by the stack panel: a real
 * background blur with genuinely rounded corners
 * (RoundedBackgroundBlurEffect, see roundedBlurEffect.js), a translucent
 * tint, a subtle top sheen, and an inner border/highlight — stacked
 * with Clutter.BinLayout so they all share the panel's allocation.
 */

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { RoundedBackgroundBlurEffect } from './roundedBlurEffect.js';

/**
 * Creates the panel actor tree. Returns the root `panel` actor (add
 * this to the stage), the inner `content` container (add grid/item
 * actors to this), and the `blurEffect` so callers can animate its
 * `radius` property independently of the panel's own transform.
 */
export function createGlassPanel({ cornerRadius = 18, clipContent = true, variant = 'macos-stack-panel' } = {}) {
    // clip_to_allocation clips every child to the panel's own rectangle,
    // including `content`. The Stack panel wants that (a fixed-size glass
    // sheet with a scrolling item grid), but the dock does not: a
    // magnified icon needs to visually overflow above the dock bar, the
    // way it does on real macOS, rather than being cut off at the bar's
    // top edge. The background layers (blur/tint/sheen/border) all carry
    // their own border-radius via set_style() below, so they stay rounded
    // on their own regardless of this flag — only `content`'s clipping
    // actually changes.
    // `variant` namespaces every layer's style class. The dock and the
    // Stack panel are both built by this function but are two visually
    // distinct surfaces (a dark, always-on bar vs. a lighter floating
    // sheet), so they must not share one set of CSS rules — they did
    // originally, and restyling the Stack panel's glass silently
    // repainted the whole dock along with it.
    const panel = new St.Widget({
        style_class: variant,
        layout_manager: new Clutter.BinLayout(),
        reactive: true,
        clip_to_allocation: clipContent,
    });
    const blur = new St.Widget({
        style_class: `${variant}-blur`,
        x_expand: true, y_expand: true,
        clip_to_allocation: true,
    });
    // What the blur effect samples. Two earlier sources both failed on
    // this machine:
    //  - the screen's own framebuffer (a BlitNode of the live stage, the
    //    way Shell.BlurEffect's BACKGROUND mode does it) comes back solid
    //    black on the NVIDIA driver whenever a maximized window is open —
    //    DIAG 3 in roundedBlurEffect.js;
    //  - a Clutter.Clone of global.window_group fixed that but wrecked
    //    the whole session's rendering (DIAG 4): every window's damage
    //    propagated into the clone, so any animation anywhere re-rendered
    //    the entire desktop a second time through the blur, a permanently
    //    mapped clone of every window disabled mutter's occlusion culling
    //    stage-wide, and it forced disable_unredirect() on top.
    // So the backdrop is now a clone of the WALLPAPER only
    // (Main.layoutManager._backgroundGroup — the same subtree Blur my
    // Shell samples for its panel blur, long-proven on NVIDIA). It is
    // static: window animations no longer touch the dock's paint at all,
    // and unredirect can stay enabled. The visual difference is nil in
    // practice — the dock's strut keeps windows out of the strip behind
    // the bar, so what is behind the glass is the wallpaper anyway. The
    // effect realigns the clone on every paint so the slice visible
    // through the panel is exactly the desktop area behind the panel; it
    // is never painted sharp — the effect consumes the widget's content
    // and only ever emits the blurred, rounded result.
    const backdrop = new Clutter.Clone({ source: Main.layoutManager._backgroundGroup });
    const syncBackdropSize = () => backdrop.set_size(global.stage.width, global.stage.height);
    syncBackdropSize();
    const stageWidthId = global.stage.connect('notify::width', syncBackdropSize);
    const stageHeightId = global.stage.connect('notify::height', syncBackdropSize);
    blur.connect('destroy', () => {
        global.stage.disconnect(stageWidthId);
        global.stage.disconnect(stageHeightId);
    });
    blur.add_child(backdrop);
    // A note on the bar's four corners, because two earlier attempts at
    // this were investigated properly and failed for real, documented
    // reasons before this third one worked. See roundedBlurEffect.js for
    // the mechanism; the short version of the first two attempts:
    //
    // 1. A rounded-rect mask chained in front of Shell.BlurEffect. Breaks
    //    the blur outright: Shell.BlurEffect's BACKGROUND mode samples the
    //    *current* framebuffer, and the mask (a ClutterOffscreenEffect)
    //    pushes its own empty FBO in front of it first.
    // 2. A small flat-colour "cap" over each corner, matching the tint.
    //    Tested live: it stood out worse than the original wedge, because
    //    the surrounding blur is textured (live desktop detail) and a flat
    //    fill is not.
    //
    // The actual fix (`RoundedBackgroundBlurEffect`) doesn't touch
    // Shell.BlurEffect at all — it's a from-scratch clone of what
    // Shell.BlurEffect's BACKGROUND mode does internally (mirrored from
    // GNOME Shell's own C source), with a rounded-rect discard baked into
    // the same fragment shader pass that draws the live blurred pixels.
    // Real blur, real rounded corners, one draw call — see that file's
    // header comment for the full mechanism and why the other two
    // approaches couldn't get there.
    const blurEffect = new RoundedBackgroundBlurEffect({
        radius: 0,
        brightness: 1.0,
        cornerRadius,
        backdrop,
    });
    blur.add_effect(blurEffect);

    const tint = new St.Widget({
        style_class: `${variant}-tint`,
        x_expand: true, y_expand: true,
    });

    // The two specular rims. macOS' Liquid Glass catches light along the
    // *whole* outline, not just the top: sampling the reference dark-mode
    // dock across its top edge gives backdrop 28 -> rim 53 -> interior 19,
    // and across its bottom edge interior 10 -> rim 79 -> backdrop 12, so
    // the lower edge is actually the brighter of the two. A single top
    // sheen (which is all this used to draw) reads as a flat panel with a
    // highlight stuck on it rather than as a piece of glass.
    // Both are full-size and paint nothing but a one-pixel inset line, so
    // they trace the rounded rectangle exactly. They used to be fixed-height
    // *bands* — a 46px gradient anchored to the top, a size chosen for the
    // 300px-tall Stack panel. On a 50-88px dock bar that covered more than
    // half the surface and its upper edge drew a hard horizontal line
    // straight across the dock: measured on a real screenshot, a step of
    // +30 levels at the band's top, and it read as a thick stripe rather
    // than as a highlight. The vertical shading belongs to the tint's own
    // full-height gradient; these two are only the rims.
    // (Two actors rather than two shadows on one, because St's box-shadow
    // takes a single shadow per rule.)
    const sheen = new St.Widget({
        style_class: `${variant}-sheen`,
        x_expand: true, y_expand: true,
    });

    const underglow = new St.Widget({
        style_class: `${variant}-underglow`,
        x_expand: true, y_expand: true,
    });

    const content = new St.Widget({
        style_class: `${variant}-content`,
        layout_manager: new Clutter.BinLayout(),
        x_expand: true, y_expand: true,
    });

    const border = new St.Widget({
        style_class: `${variant}-border`,
        x_expand: true, y_expand: true,
    });

    panel.add_child(blur);
    panel.add_child(tint);
    panel.add_child(sheen);
    panel.add_child(underglow);
    panel.add_child(content);
    panel.add_child(border);

    // None of the decorative layers is reactive, which is enough to keep
    // them out of the way of *clicks* — but not out of the way of drag and
    // drop. ui/dnd.js resolves a drop target with
    // `get_actor_at_pos(Clutter.PickMode.ALL, …)`, and PickMode.ALL ignores
    // reactivity: `border` is added last, so it paints above `content` and
    // covers the entire surface, and it was therefore the actor every drag
    // over the dock picked. dnd.js walked up from it and found no
    // `_delegate` willing to accept the drop, so every reorder was
    // cancelled and snapped back. Decoration must be invisible to picking
    // in every mode, not just to the reactive one.
    for (const layer of [blur, tint, sheen, underglow, border])
        Shell.util_set_hidden_from_pick(layer, true);

    // `background` is every purely decorative layer, exposed so a caller
    // can switch the whole glass surface off and keep only `content` —
    // the macOS Fan view draws no panel at all, its items float free
    // over the desktop.
    const surface = {
        panel, content, blurEffect, tint,
        background: [blur, tint, sheen, underglow, border],
    };
    applyPanelRadius(surface, cornerRadius);
    return surface;
}

/**
 * Rounds every layer of a glass surface at once. St has no way to inherit
 * a border-radius, so each layer carries its own — which means a caller
 * that wants to *change* the radius later (the dock scales it with its
 * icon size, the way macOS does) has to restyle all five actors together
 * or end up with a rounded bar wearing a square sheen.
 */
export function applyPanelRadius({ panel, background, blurEffect }, cornerRadius) {
    const [blur, tint, sheen, underglow, border] = background;
    panel.set_style(`border-radius: ${cornerRadius}px;`);
    blur.set_style(`border-radius: ${cornerRadius}px;`);
    if (blurEffect)
        blurEffect.cornerRadius = cornerRadius;
    tint.set_style(`border-radius: ${cornerRadius}px;`);
    // The rims carry the panel's full radius: each is a full-size actor
    // whose only paint is a one-pixel inset line, so the radius is what
    // makes that line follow the rounded corners instead of cutting across
    // them.
    sheen.set_style(`border-radius: ${cornerRadius}px;`);
    underglow.set_style(`border-radius: ${cornerRadius}px;`);
    border.set_style(`border-radius: ${cornerRadius}px;`);
}

export function createShadowActor({ cornerRadius = 18 } = {}) {
    const shadow = new St.Widget({
        style_class: 'macos-stack-shadow',
        opacity: 0,
    });
    shadow.set_style(`border-radius: ${cornerRadius}px;`);
    return shadow;
}
