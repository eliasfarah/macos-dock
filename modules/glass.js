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
export function createGlassPanel({ cornerRadius = 18 } = {}) {
    const panel = new St.Widget({
        style_class: 'macos-stack-panel',
        layout_manager: new Clutter.BinLayout(),
        reactive: true,
        clip_to_allocation: true,
    });
    panel.set_style(`border-radius: ${cornerRadius}px;`);

    const blur = new St.Widget({
        style_class: 'macos-stack-panel-blur',
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
        style_class: 'macos-stack-panel-tint',
        x_expand: true, y_expand: true,
    });
    tint.set_style(`border-radius: ${cornerRadius}px;`);

    const sheen = new St.Widget({
        style_class: 'macos-stack-panel-sheen',
        x_expand: true, y_expand: false,
        x_align: Clutter.ActorAlign.FILL,
        y_align: Clutter.ActorAlign.START,
        height: 46,
    });
    sheen.set_style(`border-radius: ${cornerRadius}px ${cornerRadius}px 0 0;`);

    const content = new St.Widget({
        style_class: 'macos-stack-panel-content',
        layout_manager: new Clutter.BinLayout(),
        x_expand: true, y_expand: true,
    });

    const border = new St.Widget({
        style_class: 'macos-stack-panel-border',
        x_expand: true, y_expand: true,
    });
    border.set_style(`border-radius: ${cornerRadius}px;`);

    // Soft, pointer-following glare — the panel's material reacting to
    // the cursor, the way glass/aqua surfaces catch a passing light.
    // Anchored at the panel's origin with a fixed size (x/y-align START
    // so BinLayout doesn't stretch it to fill the panel like the other
    // layers); the caller then moves it with translation_x/y, since
    // that's a post-allocation transform BinLayout won't override
    // (plain set_position() would be, on every relayout).
    const glare = new St.Widget({
        style_class: 'macos-stack-panel-glare',
        width: 200, height: 200,
        x_align: Clutter.ActorAlign.START,
        y_align: Clutter.ActorAlign.START,
        opacity: 0,
        reactive: false,
    });
    glare.set_style('border-radius: 100px;');
    glare.add_effect(new Shell.BlurEffect({ mode: Shell.BlurMode.ACTOR, radius: 40, brightness: 1.0 }));

    panel.add_child(blur);
    panel.add_child(tint);
    panel.add_child(sheen);
    panel.add_child(content);
    panel.add_child(glare);
    panel.add_child(border);

    return { panel, content, blurEffect, glare };
}

export function createShadowActor({ cornerRadius = 18 } = {}) {
    const shadow = new St.Widget({
        style_class: 'macos-stack-shadow',
        opacity: 0,
    });
    shadow.set_style(`border-radius: ${cornerRadius}px;`);
    return shadow;
}
