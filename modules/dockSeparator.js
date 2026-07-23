/* dockSeparator.js
 *
 * A thin vertical hairline dividing sections of the dock (apps / stacks
 * / trash) — present even when the section it precedes is empty, so
 * the dock's layout reads consistently as sections fill in.
 */

import St from 'gi://St';
import Clutter from 'gi://Clutter';

export function createDockSeparator() {
    return new St.Widget({
        style_class: 'macos-dock-separator',
        width: 1,
        y_expand: true,
        y_align: Clutter.ActorAlign.FILL,
    });
}
