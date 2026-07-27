/* roundedBlurEffect.js
 *
 * A from-scratch clone of GNOME Shell's own Shell.BlurEffect (BACKGROUND
 * mode only), with one addition Shell.BlurEffect doesn't have: rounded
 * corners baked into the *same* fragment shader pass that draws the
 * blurred result, the way macOS's Dock does it. See the long comment in
 * glass.js for the two approaches that were tried and failed before this
 * one (a rounded mask *chained in front of* Shell.BlurEffect, and a flat
 * colour-matched corner patch) — both failed because they're bolted onto
 * Shell.BlurEffect from outside, and Shell.BlurEffect's own background
 * capture only works if it's the only thing touching the actor's paint.
 *
 * This effect doesn't touch Shell.BlurEffect at all. It reimplements the
 * same mechanism directly, mirroring the real GNOME Shell 50 source
 * (src/shell-blur-effect.c, fetched from
 * https://gitlab.gnome.org/GNOME/gnome-shell for this):
 *
 *   - `paint_node()` (here: vfunc_paint_node) blits the region of the
 *     stage the actor currently occupies — via
 *     `paint_context.get_framebuffer()` + a `Clutter.BlitNode` — into an
 *     offscreen texture. This is the same trick Shell.BlurEffect's
 *     BACKGROUND mode uses to "see" the desktop behind the actor, and it
 *     only works because nothing else sits between this effect and the
 *     actor's own paint.
 *   - That texture is blurred with `Clutter.BlurNode`, the same public
 *     Clutter primitive Shell.BlurEffect itself uses internally — so the
 *     blur quality/cost is the same, not a hand-rolled approximation.
 *   - The blurred result is drawn back with a *custom* Cogl pipeline
 *     carrying a fragment shader snippet that does two things in one
 *     pass: multiplies by `brightness` (same as Shell.BlurEffect) and
 *     discards/fades alpha outside a rounded-rect signed-distance
 *     function. That second part is the whole point: because it runs in
 *     the same draw call that outputs the live blurred pixels, the
 *     corners are genuinely rounded blur, not a mask or a patch.
 *
 * Deliberately dropped relative to the real Shell.BlurEffect: ACTOR mode
 * (this codebase only ever uses BACKGROUND), the actor-content cache
 * (BACKGROUND mode's own `needs_repaint()` always returns true in the
 * real source too — it never benefits from that cache), and downscaling
 * for large radii (a real perf optimisation there, skipped here for a
 * first correct version — the panel sizes in this dock are modest).
 * Also dropped: stage-view scale-factor correction (`get_stage_view()` on
 * `Clutter.PaintContext` doesn't exist in this system's installed Clutter
 * typelib at all — the upstream source fetched was newer than what's
 * installed — so this assumes scale 1, fine for this non-fractional-
 * scaling setup but worth revisiting on a HiDPI/fractional-scale system).
 */

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Graphene from 'gi://Graphene';
import GObject from 'gi://GObject';

// DIAG (2026-07-27): two real bugs were found here via a live pixel-readback
// test (Shell.Screenshot.pick_color on a headless test scene, comparing a
// plain backdrop against the same backdrop under this effect — see
// modules/_diagCorner.js). Neither is what the original "uninitialised Cogl
// texture" theory in the node-tree comment below assumed.
//
// 1. `cogl_tex_coord0_in` does not vary per-fragment inside this pipeline-
//    level FRAGMENT snippet — every pixel of the quad read back the exact
//    same value, so the corner mask was always evaluated at one fixed point
//    (reading as "always inside", mask≈1 everywhere). Swapping in a custom
//    VERTEX-hook varying carrying `cogl_position_in` had the *same* problem
//    (frozen at a different fixed point instead). `gl_FragCoord.xy` — a
//    true per-fragment rasteriser output, not something threaded through our
//    own vertex/varying plumbing — was confirmed live to vary correctly
//    across the quad and is what actually fixes this.
// 2. Even with a correctly-varying mask, the corner still bloomed bright:
//    `cogl_color_out.a *= mask` was applied without also scaling `.rgb`, but
//    Cogl's default pipeline blending is premultiplied
//    (ONE, ONE_MINUS_SRC_ALPHA) — at partial/zero alpha this *adds* the full
//    unmasked colour on top of whatever is behind instead of fading it out
//    (confirmed by exact arithmetic: a brightness=3 test on a (90,40,40)
//    backdrop read back (255,160,160) = clamp(90*3)+90, clamp(40*3)+40 —
//    literally backdrop-plus-source, the additive signature of this exact
//    mismatch). Scaling `.rgb` by `mask` too (premultiplying) fixes it.
const FINAL_DECLARATIONS = `
uniform float brightness;
uniform float corner_radius;
uniform vec2 pixel_size;
`;

// Standard rounded-box signed-distance function (Inigo Quilez): distance
// from the fragment to the rounded rectangle's edge, negative inside,
// positive outside. `smoothstep` over a 2px band around dist=0 gives a
// cheap anti-aliased edge instead of a hard cutoff.
const FINAL_SNIPPET = `
cogl_color_out.rgb *= brightness;
{
  vec2 pos = gl_FragCoord.xy - pixel_size * 0.5;
  vec2 half_size = pixel_size * 0.5;
  vec2 q = abs(pos) - half_size + vec2(corner_radius);
  float dist = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - corner_radius;
  float mask = 1.0 - smoothstep(-1.0, 1.0, dist);
  cogl_color_out.rgb *= mask;
  cogl_color_out.a *= mask;
}
`;

function getCoglContext(actor) {
    return actor.get_context().get_backend().get_cogl_context();
}

function createBasePipeline(ctx) {
    const pipeline = Cogl.Pipeline.new(ctx);
    pipeline.set_layer_null_texture(0);
    pipeline.set_layer_filters(0, Cogl.PipelineFilter.LINEAR, Cogl.PipelineFilter.LINEAR);
    pipeline.set_layer_wrap_mode(0, Cogl.PipelineWrapMode.CLAMP_TO_EDGE);
    return pipeline;
}

function createFinalPipeline(ctx) {
    const pipeline = createBasePipeline(ctx);
    const snippet = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, FINAL_DECLARATIONS, FINAL_SNIPPET);
    pipeline.add_snippet(snippet);
    return {
        pipeline,
        brightnessLoc: pipeline.get_uniform_location('brightness'),
        cornerRadiusLoc: pipeline.get_uniform_location('corner_radius'),
        pixelSizeLoc: pipeline.get_uniform_location('pixel_size'),
    };
}

function setupProjection(framebuffer, width, height) {
    const matrix = new Graphene.Matrix();
    matrix.init_translate(new Graphene.Point3D({ x: -width / 2, y: -height / 2, z: 0 }));
    matrix.scale(2.0 / width, -2.0 / height, 1);
    framebuffer.set_projection_matrix(matrix);
}

function updateFbo(ctx, data, width, height) {
    data.texture = Cogl.Texture2D.new_with_size(ctx, width, height);
    data.pipeline.set_layer_texture(0, data.texture);
    data.framebuffer = Cogl.Offscreen.new_with_texture(data.texture);
    setupProjection(data.framebuffer, width, height);
}

export const RoundedBackgroundBlurEffect = GObject.registerClass(
class RoundedBackgroundBlurEffect extends Clutter.Effect {
    _init(params = {}) {
        super._init();

        this._radius = params.radius ?? 0;
        this._cornerRadius = params.cornerRadius ?? 0;
        this._brightness = params.brightness ?? 1.0;

        this._texWidth = -1;
        this._texHeight = -1;

        this._blit = null;
        this._final = null;
    }

    get radius() {
        return this._radius;
    }

    set radius(value) {
        if (this._radius === value)
            return;
        this._radius = value;
        this.queue_repaint();
    }

    get cornerRadius() {
        return this._cornerRadius;
    }

    set cornerRadius(value) {
        if (this._cornerRadius === value)
            return;
        this._cornerRadius = value;
        this.queue_repaint();
    }

    get brightness() {
        return this._brightness;
    }

    set brightness(value) {
        if (this._brightness === value)
            return;
        this._brightness = value;
        this.queue_repaint();
    }

    vfunc_paint_node(node, paintContext) {
        const actor = this.get_actor();
        if (!actor || this._radius <= 0) {
            node.add_child(Clutter.ActorNode.new(actor, -1));
            return;
        }

        const [origX, origY] = actor.get_transformed_position();
        const [width, height] = actor.get_transformed_size();
        const texWidth = Math.max(1, Math.round(width));
        const texHeight = Math.max(1, Math.round(height));

        if (!this._ctx)
            this._ctx = getCoglContext(actor);
        const ctx = this._ctx;

        if (!this._final)
            this._final = createFinalPipeline(ctx);
        if (!this._blit) {
            this._blit = {
                pipeline: createBasePipeline(ctx),
                texture: null,
                framebuffer: null,
            };
        }

        if (texWidth !== this._texWidth || texHeight !== this._texHeight) {
            updateFbo(ctx, this._blit, texWidth, texHeight);
            updateFbo(ctx, this._final, texWidth, texHeight);
            this._texWidth = texWidth;
            this._texHeight = texHeight;
        }

        this._final.pipeline.set_uniform_1f(this._final.brightnessLoc, this._brightness);
        this._final.pipeline.set_uniform_1f(this._final.cornerRadiusLoc, this._cornerRadius);
        this._final.pipeline.set_uniform_float(this._final.pixelSizeLoc, 2, 1, [texWidth, texHeight]);

        // Mirrors shell-blur-effect.c's node tree exactly (see the file
        // comment): finalNode (draws the finished, rounded, blurred
        // rectangle) -> blurNode (blurs whatever paints into it) ->
        // blitLayerNode (captures the blit into its own texture, the way
        // the real paint_background() does — a bare BlitNode with no
        // framebuffer of its own to render into left this whole branch
        // producing nothing usable) -> blitNode (copies the live stage
        // framebuffer into that texture). This part was already correct;
        // see the DIAG comment above the shader source for the two bugs
        // that were actually causing the flat white corner square.
        const finalNode = Clutter.LayerNode.new_to_framebuffer(this._final.framebuffer, this._final.pipeline);
        finalNode.set_name('RoundedBackgroundBlurEffect (final)');
        node.add_child(finalNode);
        finalNode.add_rectangle(new Clutter.ActorBox({ x1: 0, y1: 0, x2: texWidth, y2: texHeight }));

        const blurNode = Clutter.BlurNode.new(texWidth, texHeight, this._radius);
        blurNode.set_name('RoundedBackgroundBlurEffect (blur)');
        finalNode.add_child(blurNode);
        blurNode.add_rectangle(new Clutter.ActorBox({ x1: 0, y1: 0, x2: texWidth, y2: texHeight }));

        const blitLayerNode = Clutter.LayerNode.new_to_framebuffer(this._blit.framebuffer, this._blit.pipeline);
        blitLayerNode.set_name('RoundedBackgroundBlurEffect (blit layer)');
        blurNode.add_child(blitLayerNode);
        blitLayerNode.add_rectangle(new Clutter.ActorBox({ x1: 0, y1: 0, x2: texWidth, y2: texHeight }));

        const blitNode = Clutter.BlitNode.new(paintContext.get_framebuffer());
        blitNode.set_name('RoundedBackgroundBlurEffect (blit)');
        blitLayerNode.add_child(blitNode);
        blitNode.add_blit_rectangle(Math.round(origX), Math.round(origY), 0, 0, texWidth, texHeight);

        node.add_child(Clutter.ActorNode.new(actor, -1));
    }
});
