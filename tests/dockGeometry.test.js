#!/usr/bin/env -S gjs -m
/* tests/dockGeometry.test.js
 *
 * Regression coverage for the dock-to-monitor margin invariant.
 */

import { dockGeometryStatus, dockTargetY } from '../modules/dockGeometry.js';

let failures = 0;
let run = 0;

function test(name, fn) {
    run += 1;
    try {
        fn();
        print(`  ok   ${name}`);
    } catch (error) {
        failures += 1;
        print(`  FAIL ${name}\n         ${error.message}`);
    }
}

function assertEqual(actual, expected, message) {
    if (actual !== expected)
        throw new Error(`${message ?? 'mismatch'}: expected ${expected}, actual ${actual}`);
}

const PRIMARY = { x: 0, y: 0, width: 1600, height: 900 };

print('dock geometry');

test('target position leaves the configured gap below the dock', () => {
    assertEqual(dockTargetY(PRIMARY, 68, 6), 826);
    const status = dockGeometryStatus(PRIMARY, 68, 6, 826, 68);
    assertEqual(status.actualGap, 6);
    assertEqual(status.drifted, false);
});

test('a dock that slipped down and became flush is detected', () => {
    const status = dockGeometryStatus(PRIMARY, 68, 6, 832, 68);
    assertEqual(status.actualGap, 0);
    assertEqual(status.drifted, true);
});

test('monitor offsets are part of the target instead of assuming y zero', () => {
    const monitor = { x: 1920, y: 240, width: 2560, height: 1440 };
    assertEqual(dockTargetY(monitor, 80, 12), 1588);
    assertEqual(dockGeometryStatus(monitor, 80, 12, 1588, 80).drifted, false);
});

test('an unexpected painted height cannot consume the margin silently', () => {
    const status = dockGeometryStatus(PRIMARY, 68, 6, 826, 74);
    assertEqual(status.actualGap, 0);
    assertEqual(status.drifted, true);
});

print(`\n${run - failures}/${run} tests passed`);
if (failures > 0)
    imports.system.exit(1);
