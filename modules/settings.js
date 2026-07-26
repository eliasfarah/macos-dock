/* settings.js
 *
 * Thin wrapper around the extension's Gio.Settings object. Scalar
 * preferences map directly to gschema keys; the list of configured
 * stacks is not representable well as native GSettings types, so it
 * is stored as a single JSON-encoded string key ("stacks") and
 * (de)serialized here.
 */

const STACKS_KEY = 'stacks';

export class StackSettings {
    constructor(gioSettings) {
        this._gsettings = gioSettings;
    }

    get animationSpeed() { return this._gsettings.get_double('animation-speed'); }
    get blurIntensity() { return this._gsettings.get_double('blur-intensity'); }
    get panelSize() { return this._gsettings.get_int('panel-size'); }
    get openDirection() { return this._gsettings.get_string('open-direction'); }
    get gridColumns() { return this._gsettings.get_int('grid-columns'); }
    get displayMode() { return this._gsettings.get_string('display-mode'); }
    get panelOpacity() { return this._gsettings.get_double('panel-opacity'); }
    get shadowEnabled() { return this._gsettings.get_boolean('shadow-enabled'); }
    get overshootEnabled() { return this._gsettings.get_boolean('overshoot-enabled'); }
    get staggerDelay() { return this._gsettings.get_int('stagger-delay'); }

    get dockIconSize() { return this._gsettings.get_int('dock-icon-size'); }
    get dockEdgeMargin() { return this._gsettings.get_int('dock-edge-margin'); }
    get dockAutohide() { return this._gsettings.get_boolean('dock-autohide'); }
    get dockMagnificationEnabled() { return this._gsettings.get_boolean('dock-magnification-enabled'); }
    get dockMagnificationAmount() { return this._gsettings.get_double('dock-magnification-amount'); }
    get dockMagnificationRange() { return this._gsettings.get_int('dock-magnification-range'); }
    get dockMinimizeEffect() { return this._gsettings.get_string('dock-minimize-effect'); }
    get appearance() { return this._gsettings.get_string('appearance'); }
    get dockRecentApps() { return this._gsettings.get_int('dock-recent-apps'); }

    getRecentApps() { return this._gsettings.get_strv('recent-apps'); }
    setRecentApps(ids) { this._gsettings.set_strv('recent-apps', ids); }

    getStacks() {
        const raw = this._gsettings.get_string(STACKS_KEY);
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            return [];
        }
    }

    setStacks(stacks) {
        this._gsettings.set_string(STACKS_KEY, JSON.stringify(stacks));
    }

    addStack(stack) {
        const stacks = this.getStacks();
        stacks.push(stack);
        this.setStacks(stacks);
    }

    updateStack(id, patch) {
        const stacks = this.getStacks().map(s => (s.id === id ? { ...s, ...patch } : s));
        this.setStacks(stacks);
    }

    removeStack(id) {
        this.setStacks(this.getStacks().filter(s => s.id !== id));
    }

    connectChanged(callback) {
        return this._gsettings.connect('changed', callback);
    }

    disconnectChanged(handlerId) {
        if (handlerId)
            this._gsettings.disconnect(handlerId);
    }

    destroy() {
        this._gsettings = null;
    }
}
