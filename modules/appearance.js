/* appearance.js
 *
 * Light / dark / follow-the-system appearance for the two glass surfaces.
 *
 * St's CSS engine has no media queries, so a stylesheet cannot react to
 * the desktop's colour scheme on its own. Instead every surface carries
 * one of two marker classes on its *root* actor and the stylesheet keys
 * its palette off that with descendant selectors — the decorative layers
 * are separate actors, so a class on the parent is the only thing that
 * can restyle all of them at once without hand-writing inline colours for
 * every layer (which would then also fight applyPanelRadius()'s own
 * set_style() calls).
 *
 * The palettes themselves were measured off real macOS Tahoe screenshots
 * rather than invented — see stylesheet.css for the numbers and where
 * each one came from.
 */

import Gio from 'gi://Gio';

export const LIGHT_CLASS = 'macos-appearance-light';
export const DARK_CLASS = 'macos-appearance-dark';

const INTERFACE_SCHEMA = 'org.gnome.desktop.interface';

/**
 * Watches the extension's `appearance` preference and, when it is set to
 * "system", GNOME's own colour-scheme key underneath it. Callers register
 * a listener and get told the effective scheme ('light' | 'dark') every
 * time it changes.
 */
export class AppearanceManager {
    constructor(settings) {
        this._settings = settings;
        this._listeners = new Set();

        // `color-scheme` is the key GNOME's own Quick Settings toggle
        // writes ('default' | 'prefer-dark' | 'prefer-light'). 'default'
        // means the user never expressed a preference, which on GNOME
        // means light.
        this._interface = new Gio.Settings({ schema_id: INTERFACE_SCHEMA });
        this._interfaceId = this._interface.connect('changed::color-scheme', () => this._notify());

        this._scheme = this._resolve();
    }

    get scheme() {
        return this._scheme;
    }

    get styleClass() {
        return this._scheme === 'light' ? LIGHT_CLASS : DARK_CLASS;
    }

    _resolve() {
        const preference = this._settings.appearance;
        if (preference === 'light' || preference === 'dark')
            return preference;
        return this._interface.get_string('color-scheme') === 'prefer-dark' ? 'dark' : 'light';
    }

    /** Called by the settings listener when the `appearance` key changes. */
    refresh() {
        this._notify();
    }

    _notify() {
        const scheme = this._resolve();
        if (scheme === this._scheme)
            return;
        this._scheme = scheme;
        for (const listener of this._listeners)
            listener(scheme);
    }

    connect(listener) {
        this._listeners.add(listener);
        return listener;
    }

    disconnect(listener) {
        this._listeners.delete(listener);
    }

    destroy() {
        if (this._interfaceId) {
            this._interface.disconnect(this._interfaceId);
            this._interfaceId = 0;
        }
        this._interface = null;
        this._listeners.clear();
    }
}

/**
 * Stamps the right marker class on a root actor, removing the other one.
 * Both are removed first because an actor can be restyled many times over
 * its life and St keeps every class it was ever given.
 */
export function applyAppearanceClass(actor, scheme) {
    if (!actor)
        return;
    actor.remove_style_class_name(LIGHT_CLASS);
    actor.remove_style_class_name(DARK_CLASS);
    actor.add_style_class_name(scheme === 'light' ? LIGHT_CLASS : DARK_CLASS);
}

/**
 * How much the blur should brighten what it samples. macOS' light dock
 * lifts the wallpaper behind it slightly and its dark dock pushes it down
 * — measured at roughly +11% and -20% respectively off the reference
 * screenshots. Shell.BlurEffect exposes `brightness` but no saturation, so
 * this is the one knob available for that part of the look.
 */
export function blurBrightnessFor(scheme) {
    return scheme === 'light' ? 1.10 : 0.82;
}
