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
 *   - `paint_node()` (here: vfunc_paint_node) captures "what is behind
 *     the panel" into an offscreen texture. Since DIAG 3 (below) this is
 *     NOT done the way the reference does it (a `Clutter.BlitNode` copy
 *     of the live stage framebuffer): that read is driver-dependent and
 *     comes back solid black on this machine. Instead the actor carries a
 *     `Clutter.Clone` of `global.window_group` (see glass.js), and this
 *     effect simply paints the actor's own content — that clone, aligned
 *     by `_alignBackdrop()` — into the blur's input framebuffer.
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
//
//    DIAG 2 (2026-07-27, later the same day — the bottom-left "mancha"):
//    `gl_FragCoord` varies correctly, but it is in *device coordinates of
//    the framebuffer being drawn into*, origin at the bottom-left of the
//    screen — not in the quad's own 0..width/0..height space this shader
//    assumes. Drawn straight to the stage, the rounded-box test was
//    therefore anchored to the screen's bottom-left corner instead of to
//    the dock: only the dock's left end overlapped it (mask≈1, blur
//    visible), the rest read mask=0 (blur layer fully transparent). That
//    is exactly the reported symptom — a left-side patch that is dark
//    when a dark maximized window sits behind the dock and light over the
//    wallpaper — and it slipped through the headless screenshot check
//    because that backdrop was a flat colour, over which blurred and
//    unblurred pixels are identical. The fix keeps `gl_FragCoord` but
//    changes *where this pipeline draws*: the mask pass now renders into
//    a dedicated offscreen of exactly texWidth×texHeight (where device
//    coords ARE local coords, whatever the dock's position on screen),
//    and a final plain pass copies the finished result to the stage. The
//    y-axis may be flipped relative to the actor in that offscreen, but
//    the rounded-box SDF is symmetric in both axes, so that is harmless.
//    DIAG 3 (2026-07-27, evening — "quando maximiza a janela a dock volta a
//    ficar toda preta"): with the mask finally covering the whole panel,
//    the panel went uniformly, opaquely black whenever a maximized window
//    was open — while the wallpaper strip *around* the dock (same pixels
//    the blit reads: the strut keeps maximized windows above the dock, so
//    the backdrop is still wallpaper) rendered normally. So the BlitNode
//    copy of the live onscreen framebuffer was returning black-with-alpha
//    despite the very same region displaying correctly on screen. This
//    could not be reproduced in the isolated harnesses at all — both
//    `--headless` and GNOME 50's pipewire-based `--devkit` render stage
//    views into *offscreen* framebuffers, where the same blit works fine
//    (verified with real screenshots: window forced behind the dock,
//    glass correct) — and the machine's real session is the only real
//    CoglOnscreen: gnome-shell on an NVIDIA RTX 3080 via nvidia-drm/GBM,
//    a driver stack notorious for exactly this class of
//    read-back-from-the-window-system-buffer breakage (GNOME Shell itself
//    only ever blits *full-screen* regions in its own BACKGROUND-mode
//    uses, so the partial-region-from-onscreen path is essentially
//    unexercised upstream). Rather than fight the driver, the capture
//    was rearchitected to never touch the screen framebuffer: the actor
//    now holds a Clutter.Clone of global.window_group (wallpaper + all
//    windows — the exact subtree the overview thumbnails clone, so the
//    pattern is battle-tested, including meta's is-in-clone-paint culling
//    exemptions), and this effect paints that clone into the blur input
//    instead of blitting. `_alignBackdrop()` keeps the clone registered
//    with the panel's stage position (and inverse scale, for the stack
//    panel's opening spring) every paint. Bonus: this also removes the
//    stale-pixel feedback risk partial clipped redraws carried, and it no
//    longer depends on what mutter happened to composite before us.
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
    // This pipeline no longer draws to the stage — it draws into the
    // persistent `_out` offscreen (see DIAG 2 above). Blending must be
    // off for that: the corner fragments have alpha < 1, and blending
    // them over the previous frame's texels would accumulate ghosting
    // instead of replacing them.
    pipeline.set_blend('RGBA = ADD (SRC_COLOR, 0)');
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
        this._backdrop = params.backdrop ?? null;

        this._texWidth = -1;
        this._texHeight = -1;

        this._final = null;
        this._out = null;
    }

    // Keeps the backdrop clone aligned so the desktop pixel currently under
    // the panel's top-left corner lands exactly at the actor's local (0,0):
    // translation is the negated stage position, and scale is the inverse of
    // the panel's own stage scale (identity for the dock; briefly non-1 for
    // the stack panel's opening spring). Setting transform properties from
    // inside a paint is deliberate and safe here — the guards mean it only
    // queues further repaints while the values are actually changing, i.e.
    // during animations that already repaint every frame.
    _alignBackdrop(actor) {
        const backdrop = this._backdrop;
        if (!backdrop)
            return;

        const extents = actor.get_transformed_extents();
        const extentsWidth = extents.get_width();
        const extentsHeight = extents.get_height();
        if (extentsWidth <= 0 || extentsHeight <= 0)
            return;

        const [width, height] = actor.get_size();
        const scaleX = width / extentsWidth;
        const scaleY = height / extentsHeight;
        const translationX = -extents.get_x() * scaleX;
        const translationY = -extents.get_y() * scaleY;
        if (backdrop.scale_x !== scaleX || backdrop.scale_y !== scaleY)
            backdrop.set_scale(scaleX, scaleY);
        if (backdrop.translation_x !== translationX ||
            backdrop.translation_y !== translationY)
            backdrop.set_translation(translationX, translationY, 0);
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
        // With the blur off there is nothing sensible to paint: the actor's
        // only content is the backdrop clone, which must never reach the
        // screen sharp. (The pre-clone code painted the actor as-is here,
        // but the actor was empty then.)
        if (!actor || this._radius <= 0)
            return;

        this._alignBackdrop(actor);

        const [width, height] = actor.get_size();
        const texWidth = Math.max(1, Math.round(width));
        const texHeight = Math.max(1, Math.round(height));

        if (!this._ctx)
            this._ctx = getCoglContext(actor);
        const ctx = this._ctx;

        if (!this._final)
            this._final = createFinalPipeline(ctx);
        if (!this._out) {
            this._out = {
                pipeline: createBasePipeline(ctx),
                texture: null,
                framebuffer: null,
            };
        }

        if (texWidth !== this._texWidth || texHeight !== this._texHeight) {
            updateFbo(ctx, this._final, texWidth, texHeight);
            updateFbo(ctx, this._out, texWidth, texHeight);
            this._texWidth = texWidth;
            this._texHeight = texHeight;
        }

        this._final.pipeline.set_uniform_1f(this._final.brightnessLoc, this._brightness);
        this._final.pipeline.set_uniform_1f(this._final.cornerRadiusLoc, this._cornerRadius);
        this._final.pipeline.set_uniform_float(this._final.pixelSizeLoc, 2, 1, [texWidth, texHeight]);

        // Input half (diverges from shell-blur-effect.c since DIAG 3):
        // blurNode blurs whatever paints into it, and what paints into it
        // is the actor's own content — the aligned window_group clone —
        // via a plain ActorNode. The actor's paint lands in blurNode's
        // internal framebuffer in actor-local coordinates (its transform
        // chain was applied to the *stage* framebuffer's matrix stack, and
        // matrix stacks are per-framebuffer), so the fb window [0..w,0..h]
        // shows exactly the panel-sized slice of the clone; everything
        // beyond it falls outside the fb and costs nothing.
        //
        // Composite half, unchanged from DIAG 2: the corner mask reads
        // `gl_FragCoord`, which is only meaningful in an offscreen whose
        // device coords are the quad's own local coords. So blurTargetNode
        // collects the blurred pixels into `_final.framebuffer` (drawing
        // nothing itself — no rectangle is added); maskNode then draws them
        // through the corner-mask shader into `_out.framebuffer` (same
        // size, local coords); and outNode finally copies the finished
        // rounded result to the stage with a plain pipeline.
        const outNode = Clutter.LayerNode.new_to_framebuffer(this._out.framebuffer, this._out.pipeline);
        outNode.set_name('RoundedBackgroundBlurEffect (out)');
        node.add_child(outNode);
        outNode.add_rectangle(new Clutter.ActorBox({ x1: 0, y1: 0, x2: texWidth, y2: texHeight }));

        const blurTargetNode = Clutter.LayerNode.new_to_framebuffer(this._final.framebuffer, this._final.pipeline);
        blurTargetNode.set_name('RoundedBackgroundBlurEffect (blur target)');
        outNode.add_child(blurTargetNode);

        const blurNode = Clutter.BlurNode.new(texWidth, texHeight, this._radius);
        blurNode.set_name('RoundedBackgroundBlurEffect (blur)');
        blurTargetNode.add_child(blurNode);
        blurNode.add_rectangle(new Clutter.ActorBox({ x1: 0, y1: 0, x2: texWidth, y2: texHeight }));

        blurNode.add_child(Clutter.ActorNode.new(actor, -1));

        const maskNode = Clutter.PipelineNode.new(this._final.pipeline);
        maskNode.set_name('RoundedBackgroundBlurEffect (mask)');
        outNode.add_child(maskNode);
        maskNode.add_rectangle(new Clutter.ActorBox({ x1: 0, y1: 0, x2: texWidth, y2: texHeight }));
    }
});
