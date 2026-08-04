/* dockGeometry.js
 *
 * Pure geometry used by DockManager's screen-edge invariant. Keeping the
 * arithmetic free of Clutter imports lets the exact failure mode be covered
 * without a compositor: the dock is wrong whenever its painted bottom edge
 * leaves a different gap from the configured monitor-edge margin.
 */

const GEOMETRY_EPSILON = 0.5;

export function dockTargetY(monitor, height, margin) {
    return monitor.y + monitor.height - height - margin;
}

export function dockGeometryStatus(monitor, expectedHeight, margin,
    actualY, actualHeight) {
    const expectedY = dockTargetY(monitor, expectedHeight, margin);
    const expectedBottom = monitor.y + monitor.height - margin;
    const actualBottom = actualY + actualHeight;

    return {
        expectedY,
        expectedHeight,
        actualY,
        actualHeight,
        expectedGap: margin,
        actualGap: monitor.y + monitor.height - actualBottom,
        drifted: Math.abs(actualY - expectedY) > GEOMETRY_EPSILON ||
            Math.abs(actualHeight - expectedHeight) > GEOMETRY_EPSILON ||
            Math.abs(actualBottom - expectedBottom) > GEOMETRY_EPSILON,
    };
}
