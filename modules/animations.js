/* animations.js
 *
 * Manual spring-physics easing for Clutter actors (and other GObjects
 * exposing plain numeric properties, e.g. Shell.BlurEffect).
 *
 * Clutter's built-in Clutter.AnimationMode curves (EASE_*, ELASTIC,
 * BOUNCE...) do not reproduce the specific damped-oscillator feel of
 * Core Animation's CASpringAnimation, so instead of `actor.ease()` we
 * drive a Clutter.Timeline as a frame clock and compute the position
 * ourselves from the closed-form solution of a damped harmonic
 * oscillator. This gives full control over mass/stiffness/damping,
 * matching the ~3% overshoot the macOS Dock uses.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import { clamp } from './utils.js';

/**
 * Spring presets, expressed the same way CASpringAnimation expresses
 * them: mass, stiffness and damping. Tuned by hand to land close to
 * ~3% overshoot with a natural, non-mushy settle.
 */
export const SPRING = {
    // Used for the panel's expand/collapse transform.
    PANEL: { mass: 1, stiffness: 140, damping: 18 },
    // Snappier, slightly livelier spring for individual grid items.
    ITEM: { mass: 1, stiffness: 230, damping: 20 },
    // Near-critically-damped: reaches 1 with (almost) no overshoot.
    // Used when "overshoot" is disabled in preferences, and for
    // secondary layers (shadow, blur) that should not bounce.
    SOFT: { mass: 1, stiffness: 170, damping: 26 },
    // Fast, essentially non-bouncy — dock icon hover magnification needs
    // to track the pointer crisply, not oscillate like the panel open/close.
    MAGNIFY: { mass: 1, stiffness: 320, damping: 30 },
};

/**
 * Evaluates a damped harmonic oscillator at time `t` (seconds),
 * starting at rest (x=0, v=0) and driven toward a target of 1.
 */
export function springValue(t, { mass, stiffness, damping }) {
    if (t <= 0)
        return 0;

    const w0 = Math.sqrt(stiffness / mass);
    const zeta = damping / (2 * Math.sqrt(stiffness * mass));

    if (zeta < 1) {
        // Underdamped: oscillates around the target before settling.
        // This is what produces the overshoot.
        const wd = w0 * Math.sqrt(1 - zeta * zeta);
        const envelope = Math.exp(-zeta * w0 * t);
        return 1 - envelope * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
    }

    // Critically/over-damped: approaches the target monotonically.
    const envelope = Math.exp(-w0 * t);
    return 1 - envelope * (1 + w0 * t);
}

function lerpValue(a, b, t) {
    return a + (b - a) * t;
}

function applyProp(target, key, value) {
    if (key === 'opacity')
        value = Math.round(clamp(value, 0, 255));
    target.set({ [key]: value });
}

/**
 * Animates `target`'s properties (any subset of `toProps`' keys) from
 * `fromProps` to `toProps` following a manually-computed spring curve.
 *
 * `duration` is a nominal duration in ms used only to relate real time
 * to the spring's internal clock; the spring itself decides exactly
 * when it "looks done" (it may under/overshoot around that point).
 */
export function animateSpring(target, fromProps, toProps, options = {}) {
    const {
        duration = 450,
        speed = 1,
        preset = SPRING.PANEL,
        onUpdate = null,
        onComplete = null,
        // Identifies *which* concurrent animation this is on `target`.
        // Animations are tracked per-id, so two unrelated concerns can
        // drive disjoint properties of the same actor at the same time
        // (a dock icon's launch bounce animates translation_y while
        // hover magnification animates scale/translation_x — with a
        // single slot per target, starting either one silently killed
        // the other mid-flight, which is why a bouncing icon stopped
        // dead the moment the pointer moved over it). Same id ==
        // same slot, so re-targeting one concern still cancels only
        // its own previous animation, as before.
        id = 'default',
        // A Clutter.Timeline only actually starts if it's bound to either
        // an actor that has a stage, or an explicit frame clock — a bare
        // `new Clutter.Timeline({duration})` has neither, so start() is a
        // silent no-op (a "runtime check failed" Clutter-WARNING, not a
        // thrown error) and nothing ever animates. `target` itself is the
        // actor to bind to in the common case; callers animating a
        // non-actor GObject (e.g. Shell.BlurEffect) must pass the real
        // on-stage actor driving that effect via `actor`.
        actor = target,
    } = options;

    cancelSpring(target, id);

    const realDuration = Math.max(1, Math.round(duration / Math.max(0.01, speed)));
    const timeline = Clutter.Timeline.new_for_actor(actor, realDuration);
    const keys = Object.keys(toProps);

    timeline.connect('new-frame', (_tl, elapsedMs) => {
        const tSeconds = (elapsedMs * speed) / 1000;
        const progress = springValue(tSeconds, preset);

        for (const key of keys)
            applyProp(target, key, lerpValue(fromProps[key], toProps[key], progress));

        if (onUpdate)
            onUpdate(progress);
    });

    timeline.connect('completed', () => {
        // Snap exactly to the final values so float rounding never
        // leaves a visible 1px/1-unit gap once the spring "settles".
        for (const key of keys)
            applyProp(target, key, toProps[key]);

        if (target._springTimelines?.get(id) === timeline)
            target._springTimelines.delete(id);

        if (onComplete)
            onComplete();
    });

    if (!target._springTimelines)
        target._springTimelines = new Map();
    target._springTimelines.set(id, timeline);
    timeline.start();
    return timeline;
}

/**
 * Stops in-flight spring animations on `target`. With no `id`, stops
 * every concurrent animation on it (the teardown case); with an `id`,
 * stops only that one, leaving unrelated concerns running.
 */
export function cancelSpring(target, id = null) {
    const timelines = target?._springTimelines;
    if (!timelines)
        return;

    if (id === null) {
        for (const timeline of timelines.values())
            timeline.stop();
        timelines.clear();
        return;
    }

    const timeline = timelines.get(id);
    if (timeline) {
        timeline.stop();
        timelines.delete(id);
    }
}

/**
 * Runs `buildProps(actor, index)` -> { from, to } on each actor in
 * `actors`, starting each one's spring animation `baseDelay`ms after
 * the previous (the "stagger" effect used when items appear/disappear).
 * Returns the GLib timeout source ids, so callers can cancel pending
 * (not yet started) animations on teardown.
 */
export function animateStagger(actors, buildProps, options = {}) {
    const {
        baseDelay = 25,
        duration = 260,
        speed = 1,
        preset = SPRING.ITEM,
        reverse = false,
        onAllComplete = null,
    } = options;

    const order = reverse ? [...actors].reverse() : actors;
    if (order.length === 0) {
        if (onAllComplete)
            onAllComplete();
        return [];
    }

    let remaining = order.length;
    const timeoutIds = [];

    order.forEach((actor, index) => {
        const delay = Math.round((index * baseDelay) / Math.max(0.01, speed));
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            const { from, to } = buildProps(actor, index);
            animateSpring(actor, from, to, {
                duration, speed, preset,
                onComplete: () => {
                    remaining -= 1;
                    if (remaining === 0 && onAllComplete)
                        onAllComplete();
                },
            });
            return GLib.SOURCE_REMOVE;
        });
        timeoutIds.push(id);
    });

    return timeoutIds;
}
