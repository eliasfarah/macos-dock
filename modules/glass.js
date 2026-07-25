/* glass.js
 *
 * Builds the layered "glass" visual used by the stack panel: a real
 * background blur (Shell.BlurEffect, the same effect GNOME Shell uses
 * for the overview search entry and the screen shield), a translucent
 * tint, a subtle top sheen, and an inner border/highlight — stacked
 * with Clutter.BinLayout so they all share the panel's allocation.
 */

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';

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
    panel.set_style(`border-radius: ${cornerRadius}px;`);

    const blur = new St.Widget({
        style_class: `${variant}-blur`,
        x_expand: true, y_expand: true,
    });
    blur.set_style(`border-radius: ${cornerRadius}px;`);
    const blurEffect = new Shell.BlurEffect({
        mode: Shell.BlurMode.BACKGROUND,
        radius: 0,
        brightness: 1.0,
    });
    blur.add_effect(blurEffect);

    const tint = new St.Widget({
        style_class: `${variant}-tint`,
        x_expand: true, y_expand: true,
    });
    tint.set_style(`border-radius: ${cornerRadius}px;`);

    const sheen = new St.Widget({
        style_class: `${variant}-sheen`,
        x_expand: true, y_expand: false,
        x_align: Clutter.ActorAlign.FILL,
        y_align: Clutter.ActorAlign.START,
        height: 46,
    });
    sheen.set_style(`border-radius: ${cornerRadius}px ${cornerRadius}px 0 0;`);

    const content = new St.Widget({
        style_class: `${variant}-content`,
        layout_manager: new Clutter.BinLayout(),
        x_expand: true, y_expand: true,
    });

    const border = new St.Widget({
        style_class: `${variant}-border`,
        x_expand: true, y_expand: true,
    });
    border.set_style(`border-radius: ${cornerRadius}px;`);

    panel.add_child(blur);
    panel.add_child(tint);
    panel.add_child(sheen);
    panel.add_child(content);
    panel.add_child(border);

    // `background` is every purely decorative layer, exposed so a caller
    // can switch the whole glass surface off and keep only `content` —
    // the macOS Fan view draws no panel at all, its items float free
    // over the desktop.
    return { panel, content, blurEffect, tint, background: [blur, tint, sheen, border] };
}

export function createShadowActor({ cornerRadius = 18 } = {}) {
    const shadow = new St.Widget({
        style_class: 'macos-stack-shadow',
        opacity: 0,
    });
    shadow.set_style(`border-radius: ${cornerRadius}px;`);
    return shadow;
}
