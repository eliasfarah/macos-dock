/* dockSeparator.js
 *
 * A thin vertical hairline dividing the dock's app section from its
 * stacks/Trash section, and (inside the app section) pinned apps from
 * merely-running ones.
 */

import St from 'gi://St';
import Clutter from 'gi://Clutter';

// The hairline itself and the clearance either side of it. Exported
// because dockManager.js computes the bar's width arithmetically rather
// than by measuring the row, and a separator's footprint has to be part
// of that sum — a constant here and a `margin` in the stylesheet would be
// two numbers free to drift apart, so the margin is applied from this one.
export const SEPARATOR_LINE_WIDTH = 1;
export const SEPARATOR_MARGIN = 4;
export const SEPARATOR_TOTAL_WIDTH = SEPARATOR_LINE_WIDTH + SEPARATOR_MARGIN * 2;

export function createDockSeparator() {
    // Centred, not stretched: Apple's Dock draws these as short hairlines
    // sitting inside the bar's padding, at roughly 60% of its height.
    // y_expand + FILL made them full-height rules from glass edge to glass
    // edge, which is a GNOME panel's idiom, not the Dock's.
    const separator = new St.Widget({
        style_class: 'macos-dock-separator',
        width: SEPARATOR_LINE_WIDTH,
        y_expand: false,
        y_align: Clutter.ActorAlign.CENTER,
    });
    separator.set_style(`margin-left: ${SEPARATOR_MARGIN}px; margin-right: ${SEPARATOR_MARGIN}px;`);
    return separator;
}

/** Height comes from the bar's own metrics — see dockManager.js. */
export function sizeDockSeparator(separator, height) {
    separator?.set_height(height);
}
