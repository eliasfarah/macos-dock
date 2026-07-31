#!/usr/bin/env -S gjs -m
/* tests/recentApps.test.js
 *
 * Covers the recents queue's ordering rules end to end. modules/recentApps.js
 * imports nothing from gi, which is the whole reason this can run under bare
 * gjs with no compositor, no GSettings and no dock:
 *
 *     gjs -m tests/recentApps.test.js
 *
 * The fake world below stands in for the four ports DockManager supplies —
 * GSettings storage, AppFavorites, Shell.AppSystem and the size preference.
 *
 * Every expectation here is in *display order*: left to right along the dock,
 * so the last id in an array is the one nearest the trash.
 */

import {
    RecentApps, RECENT_APPS_MEMORY, RECENTS_FORMAT, isPersistentAppId,
} from '../modules/recentApps.js';

// -- tiny harness ---------------------------------------------------------

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

function assert(condition, message) {
    if (!condition)
        throw new Error(message ?? 'assertion failed');
}

function assertEqual(actual, expected, message) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e)
        throw new Error(`${message ?? 'mismatch'}\n         expected ${e}\n         actual   ${a}`);
}

// -- fake world -----------------------------------------------------------

class World {
    // `format` defaults to the current one, so a test says nothing about
    // migration unless it means to: the interesting case is state written
    // by an older version, which sets it explicitly.
    constructor({ limit = 3, pinned = [], stored = [], suppressed = 0,
        format = RECENTS_FORMAT } = {}) {
        this.limit = limit;
        this.pinned = new Set(pinned);
        this.uninstalled = new Set();
        this.stored = [...stored];
        this.suppressed = suppressed;
        this.format = format;
        this.writes = 0;
    }

    model() {
        return new RecentApps({
            storage: {
                getIds: () => [...this.stored],
                setIds: ids => {
                    this.stored = [...ids];
                    this.writes += 1;
                },
                getSuppressed: () => this.suppressed,
                setSuppressed: count => {
                    this.suppressed = count;
                },
                getFormat: () => this.format,
                setFormat: version => {
                    this.format = version;
                },
            },
            isPinned: id => this.pinned.has(id),
            appExists: id => !this.uninstalled.has(id),
            limit: () => this.limit,
        });
    }

    /** A loaded model plus a running set already seeded to `running`. */
    started({ running = [], ...options } = {}) {
        Object.assign(this, options);
        const recents = this.model();
        recents.load();
        recents.seedRunning(running);
        return recents;
    }
}

/**
 * Drives the model the way the shell does: one 'app-state-changed' per app,
 * each with its own redisplay, so the model sees a single launch or quit at
 * a time. `session` is the mutable set of running app ids.
 */
class Session {
    constructor(recents, running = []) {
        this.recents = recents;
        this.running = [...running];
    }

    open(...ids) {
        for (const id of ids) {
            this.running.push(id);
            this.recents.syncRunning([...this.running]);
        }
        return this;
    }

    quit(...ids) {
        for (const id of ids) {
            this.running = this.running.filter(other => other !== id);
            this.recents.syncRunning([...this.running]);
        }
        return this;
    }

    /** The whole trailing row, open zone first, exactly as the dock draws it. */
    get row() {
        return [...this.recents.openIds(), ...this.recents.visibleIds()];
    }
}

const SPOTIFY = 'com.spotify.Client.desktop';
const DISCORD = 'com.discordapp.Discord.desktop';
const CALC = 'org.gnome.Calculator.desktop';
const EDITOR = 'org.gnome.TextEditor.desktop';
const FILES = 'org.gnome.Nautilus.desktop';

// -- open apps ------------------------------------------------------------

print('open apps');

test('an open app is not a recent', () => {
    const world = new World();
    const session = new Session(world.started()).open(SPOTIFY);

    assertEqual(session.recents.visibleIds(), [], 'nothing in the queue yet');
    assertEqual(session.recents.openIds(), [SPOTIFY], 'shown because it is running');
    assertEqual(world.stored, [], 'and nothing persisted');
});

test('open apps do not spend the limit of three', () => {
    const world = new World();
    const session = new Session(world.started());
    session.open(SPOTIFY, DISCORD, CALC, EDITOR, FILES);

    assertEqual(session.recents.openIds().length, 5, 'all five stay on the dock');
    assertEqual(session.recents.visibleIds(), [], 'none of them is a recent');
});

test('open apps sit left of the recents', () => {
    const world = new World();
    const session = new Session(world.started());
    session.open(SPOTIFY).quit(SPOTIFY);
    session.open(DISCORD);

    assertEqual(session.row, [DISCORD, SPOTIFY], 'the recent is the one by the trash');
});

test('the open zone is ordered by launch, and a second window changes nothing', () => {
    const world = new World();
    const session = new Session(world.started());
    session.open(CALC, SPOTIFY, DISCORD);

    // Another window of an app that is already running leaves the running
    // *app* set alone, which is the only thing the model looks at.
    assert(!session.recents.syncRunning([...session.running]), 'no change');
    assertEqual(session.recents.openIds(), [CALC, SPOTIFY, DISCORD], 'launch order');
});

// -- quitting -------------------------------------------------------------

print('quitting');

test('quitting an unpinned app files it as the newest recent', () => {
    const world = new World();
    const session = new Session(world.started()).open(SPOTIFY);

    assert(session.recents.syncRunning([]), 'the section changed');
    assertEqual(session.recents.visibleIds(), [SPOTIFY]);
    assertEqual(session.recents.openIds(), [], 'no longer an open app');
    assertEqual(world.stored, [SPOTIFY], 'persisted');
});

test('each new quit pushes the older ones left', () => {
    const world = new World();
    const session = new Session(world.started()).open(SPOTIFY, DISCORD, CALC);

    session.quit(SPOTIFY);
    assertEqual(session.recents.visibleIds(), [SPOTIFY], 'after quitting Spotify');

    session.quit(DISCORD);
    assertEqual(session.recents.visibleIds(), [SPOTIFY, DISCORD], 'after quitting Discord');

    session.quit(CALC);
    assertEqual(session.recents.visibleIds(), [SPOTIFY, DISCORD, CALC], 'after quitting Calculator');
});

test('an app with more than one window is filed only when the last one goes', () => {
    // Two windows of one app are still one entry in get_running(), so the
    // model cannot see the first one close — and must not, because the app
    // has not been quit.
    const world = new World();
    const session = new Session(world.started()).open(SPOTIFY);

    assert(!session.recents.syncRunning([SPOTIFY]), 'first window closed: no change');
    assertEqual(session.recents.visibleIds(), []);

    session.quit(SPOTIFY);
    assertEqual(session.recents.visibleIds(), [SPOTIFY], 'last window closed: filed');
});

test('a pinned app never enters the queue', () => {
    const world = new World({ pinned: [SPOTIFY] });
    const session = new Session(world.started()).open(SPOTIFY).quit(SPOTIFY);

    assertEqual(session.recents.visibleIds(), [], 'nothing visible');
    assertEqual(session.recents.ids, [], 'no invisible entry either');
    assertEqual(world.writes, 0, 'and nothing written to storage');
});

test('an id with no stable .desktop entry is never stored', () => {
    const world = new World();
    const session = new Session(world.started()).open('window:12').quit('window:12');

    assertEqual(session.recents.ids, []);
    assert(!isPersistentAppId('window:12'), 'synthetic ids are not persistent');
    assert(isPersistentAppId(SPOTIFY), 'desktop ids are');
});

// -- reopening ------------------------------------------------------------

print('reopening');

test('reopening a recent leaves its icon exactly where it was', () => {
    const world = new World();
    const session = new Session(world.started()).open(SPOTIFY, DISCORD, CALC);
    session.quit(SPOTIFY, DISCORD, CALC);
    assertEqual(session.row, [SPOTIFY, DISCORD, CALC], 'three recents');

    session.open(DISCORD);

    assertEqual(session.row, [SPOTIFY, DISCORD, CALC], 'same row, same indices');
    assertEqual(session.recents.openIds(), [], 'it keeps its slot rather than moving left');
});

test('a reopened app is no longer removable as a recent', () => {
    // DockManager offers "Remove from Dock" on the window entries that are
    // not running; reopening one takes it out of that set.
    const world = new World();
    const session = new Session(world.started()).open(SPOTIFY).quit(SPOTIFY);
    session.open(SPOTIFY);

    const removable = session.recents.visibleIds().filter(id => !session.running.includes(id));
    assertEqual(removable, [], 'nothing to remove while it is open');
});

test('quitting a reopened app refiles it at the recent end', () => {
    const world = new World();
    const session = new Session(world.started()).open(SPOTIFY, DISCORD, CALC);
    session.quit(SPOTIFY, DISCORD, CALC);   // row: SPOTIFY, DISCORD, CALC

    session.open(SPOTIFY).quit(SPOTIFY);

    assertEqual(session.row, [DISCORD, CALC, SPOTIFY], 'newest close is nearest the trash');
});

test('reopening does not duplicate an entry', () => {
    const world = new World();
    const session = new Session(world.started()).open(SPOTIFY).quit(SPOTIFY);
    session.open(SPOTIFY).quit(SPOTIFY).open(SPOTIFY).quit(SPOTIFY);

    assertEqual(session.recents.ids, [SPOTIFY]);
    assertEqual(session.row, [SPOTIFY]);
});

test('an open app pushed out of the window falls back to the open zone', () => {
    // Its slot is gone, but a running app has an icon no matter what.
    const world = new World();
    const session = new Session(world.started()).open(SPOTIFY).quit(SPOTIFY);
    session.open(SPOTIFY);                              // holds slot 1 of 3

    const others = [DISCORD, CALC, EDITOR];
    new Session(session.recents, session.running).open(...others).quit(...others);
    session.running = [SPOTIFY];

    assertEqual(session.recents.visibleIds(), [DISCORD, CALC, EDITOR], 'three newer closes');
    assertEqual(session.recents.openIds(), [SPOTIFY], 'still on the dock, in the open zone');
});

// -- the limit ------------------------------------------------------------

print('limit');

test('a fourth close pushes the oldest out of the visible three', () => {
    const world = new World();
    const session = new Session(world.started()).open(SPOTIFY, DISCORD, CALC, EDITOR);
    session.quit(SPOTIFY, DISCORD, CALC, EDITOR);

    assertEqual(session.recents.visibleIds(), [DISCORD, CALC, EDITOR], 'Spotify dropped out');
});

test('the deeper memory is bounded too', () => {
    const world = new World();
    const recents = world.started();
    for (let i = 0; i < RECENT_APPS_MEMORY + 5; i++) {
        recents.syncRunning([`app${i}.desktop`]);
        recents.syncRunning([]);
    }

    assertEqual(recents.ids.length, RECENT_APPS_MEMORY, 'memory capped');
    assertEqual(recents.visibleIds().length, 3, 'window still three');
});

test('raising the limit again shows what the deeper memory kept', () => {
    const world = new World();
    const session = new Session(world.started()).open(SPOTIFY, DISCORD, CALC, EDITOR);
    session.quit(SPOTIFY, DISCORD, CALC, EDITOR);

    world.limit = 4;

    assertEqual(session.recents.visibleIds(), [SPOTIFY, DISCORD, CALC, EDITOR]);
});

test('a limit of zero shows nothing and records nothing', () => {
    const world = new World({ limit: 0 });
    const session = new Session(world.started()).open(SPOTIFY);

    assert(!session.recents.syncRunning([]), 'no change');
    assertEqual(session.recents.visibleIds(), []);
    assertEqual(session.recents.ids, [], 'history not written while the section is off');
});

test('a limit of zero still leaves open apps on the dock', () => {
    const world = new World({ limit: 0 });
    const session = new Session(world.started()).open(SPOTIFY);

    assertEqual(session.recents.openIds(), [SPOTIFY]);
});

// -- removal --------------------------------------------------------------

print('removal');

test('forgetting an app drops it and leaves the slot empty', () => {
    const world = new World();
    const session = new Session(world.started()).open(SPOTIFY, DISCORD, CALC, EDITOR);
    session.quit(SPOTIFY, DISCORD, CALC, EDITOR);
    // visible: DISCORD, CALC, EDITOR — with SPOTIFY still in memory.

    session.recents.forget(CALC);

    assertEqual(session.recents.visibleIds(), [DISCORD, EDITOR], 'gone, and no backfill');
    assertEqual(session.recents.suppressedSlots, 1, 'one slot stays empty');
});

test('closing another app reclaims a suppressed slot', () => {
    const world = new World();
    const session = new Session(world.started()).open(SPOTIFY, DISCORD, CALC);
    session.quit(SPOTIFY, DISCORD, CALC);
    session.recents.forget(DISCORD);
    assertEqual(session.recents.visibleIds().length, 2, 'suppressed down to two');

    session.open(EDITOR).quit(EDITOR);

    assertEqual(session.recents.visibleIds(), [SPOTIFY, CALC, EDITOR], 'back to three');
    assertEqual(session.recents.suppressedSlots, 0);
});

test('forgetting something that is not shown costs no slot', () => {
    const world = new World();
    const session = new Session(world.started()).open(SPOTIFY).quit(SPOTIFY);

    session.recents.forget(DISCORD);

    assertEqual(session.recents.suppressedSlots, 0, 'no unrelated recent blanked');
    assertEqual(session.recents.visibleIds(), [SPOTIFY]);
});

test('forgetting an app that is running costs no slot either', () => {
    // Its icon stays put — it is open — so nothing was emptied to hold open.
    const world = new World();
    const session = new Session(world.started()).open(SPOTIFY, DISCORD);
    session.quit(SPOTIFY, DISCORD);
    session.open(SPOTIFY);

    session.recents.forget(SPOTIFY);

    assertEqual(session.recents.suppressedSlots, 0, 'no slot claimed');
    assertEqual(session.row, [SPOTIFY, DISCORD], 'still on the dock, now in the open zone');
});

test('clearing wipes the history and the suppressed slots with it', () => {
    const world = new World();
    const session = new Session(world.started()).open(SPOTIFY, DISCORD, CALC);
    session.quit(SPOTIFY, DISCORD, CALC);
    session.recents.forget(CALC);

    session.recents.clear();

    assertEqual(session.recents.ids, []);
    assertEqual(session.recents.visibleIds(), []);
    assertEqual(session.recents.suppressedSlots, 0, 'a cleared list is not also a suppressed one');
});

test('an uninstalled app is skipped rather than shown', () => {
    const world = new World();
    const session = new Session(world.started()).open(SPOTIFY, DISCORD);
    session.quit(SPOTIFY, DISCORD);
    world.uninstalled.add(DISCORD);

    assertEqual(session.recents.visibleIds(), [SPOTIFY]);
});

// -- pinning and unpinning ------------------------------------------------

print('pinning');

test('pinning a recent app removes it from the history immediately', () => {
    const world = new World();
    const session = new Session(world.started()).open(SPOTIFY, DISCORD);
    session.quit(SPOTIFY, DISCORD);

    world.pinned.add(SPOTIFY);
    assert(session.recents.dropPinned(), 'the queue changed');

    assertEqual(session.recents.visibleIds(), [DISCORD], 'not shown');
    assertEqual(session.recents.ids, [DISCORD], 'and no invisible leftover entry');
});

test('pinning an open app keeps it out of recents when it is quit', () => {
    const world = new World();
    const session = new Session(world.started()).open(SPOTIFY);
    world.pinned.add(SPOTIFY);
    session.recents.dropPinned();

    session.quit(SPOTIFY);

    assertEqual(session.recents.ids, [], 'a pinned app has its own section');
});

test('unpinning does not put an app back into recents on its own', () => {
    const world = new World({ pinned: [SPOTIFY] });
    const session = new Session(world.started()).open(SPOTIFY, DISCORD);
    session.quit(SPOTIFY, DISCORD);
    session.recents.dropPinned();

    world.pinned.delete(SPOTIFY);

    assertEqual(session.recents.visibleIds(), [DISCORD], 'Spotify stays off until it is used');
});

test('an unpinned app earns its place back by being opened and quit', () => {
    const world = new World({ pinned: [SPOTIFY] });
    const session = new Session(world.started()).open(SPOTIFY, DISCORD);
    session.quit(SPOTIFY, DISCORD);
    session.recents.dropPinned();
    world.pinned.delete(SPOTIFY);

    session.open(SPOTIFY).quit(SPOTIFY);

    assertEqual(session.recents.visibleIds(), [DISCORD, SPOTIFY]);
});

test('a pinned app is filtered even if an old queue still names it', () => {
    const world = new World({ stored: [SPOTIFY, DISCORD], pinned: [SPOTIFY] });
    const recents = world.started();

    assertEqual(recents.visibleIds(), [DISCORD]);
    assertEqual(recents.openIds(), [], 'and not smuggled in through the open zone');
});

// -- restart --------------------------------------------------------------

print('restart');

test('disable/enable preserves the list, its order and its limit', () => {
    const world = new World();
    const first = new Session(world.started()).open(SPOTIFY, DISCORD, CALC);
    first.quit(SPOTIFY, DISCORD);
    const before = first.recents.visibleIds();

    // A fresh manager over the same GSettings, with Calculator still up.
    const second = world.started({ running: [CALC] });

    assertEqual(second.visibleIds(), before, 'same section, same order');
    assertEqual(second.openIds(), [CALC], 'and the open app is still open');
});

test('apps already running at enable time are not read as launches or quits', () => {
    const world = new World({ stored: [SPOTIFY, DISCORD] });
    const recents = world.started({ running: [CALC, EDITOR] });

    assert(!recents.syncRunning([CALC, EDITOR]), 'nothing filed');
    assertEqual(recents.ids, [SPOTIFY, DISCORD], 'restored order untouched');
    assertEqual(recents.visibleIds(), [DISCORD, SPOTIFY], 'oldest first, left to right');
});

test('an app running at enable time keeps the slot it was restored with', () => {
    const world = new World({ stored: [SPOTIFY, DISCORD] });
    const recents = world.started({ running: [DISCORD] });

    assertEqual(recents.visibleIds(), [DISCORD, SPOTIFY], 'drawn in place, with a dot');
    assertEqual(recents.openIds(), [], 'not duplicated into the open zone');
});

test('load() repairs duplicates and unstable ids left by an older version', () => {
    const world = new World({ stored: [SPOTIFY, 'window:12', SPOTIFY, DISCORD, 'window:3'] });
    const recents = world.started();

    assertEqual(recents.ids, [SPOTIFY, DISCORD], 'deduplicated and filtered');
    assertEqual(world.stored, [SPOTIFY, DISCORD], 'and written back');
});

test('load() clamps a suppressed count that outgrew its range', () => {
    const world = new World({ stored: [SPOTIFY], suppressed: 99 });
    const recents = world.started();

    assert(recents.suppressedSlots <= 6, 'clamped into range');
    assertEqual(recents.visibleIds(), [], 'and still means "show nothing"');
});

// -- migration ------------------------------------------------------------

print('migration');

test('a suppressed count from the old rule is dropped, not carried over', () => {
    // Exactly the state the refactor left on disk: three slots charged by
    // the old forget(), which is enough to blank a three-slot section even
    // though six apps are remembered.
    const world = new World({
        stored: [SPOTIFY, DISCORD, CALC, EDITOR, FILES], suppressed: 3, format: 0,
    });
    const recents = world.started();

    assertEqual(recents.suppressedSlots, 0, 'the inflated count is gone');
    assertEqual(recents.visibleIds(), [CALC, DISCORD, SPOTIFY],
        'and the section fills again');
    assertEqual(world.suppressed, 0, 'the reset reached storage');
    assertEqual(world.format, RECENTS_FORMAT, 'and was recorded as done');
});

test('the migration runs once, not on every startup', () => {
    const world = new World({ stored: [SPOTIFY, DISCORD], suppressed: 2, format: 0 });
    world.started();
    assertEqual(world.suppressed, 0, 'migrated on first load');

    // A gap the user makes *after* migrating has to survive a restart —
    // which is the entire reason the count is persisted.
    const second = world.started();
    second.forget(DISCORD);
    assertEqual(second.suppressedSlots, 1, 'a fresh removal charges a slot');

    const third = world.started();
    assertEqual(third.suppressedSlots, 1, 'and the gap is still there next time');
});

test('state already in the current format is left alone', () => {
    const world = new World({ stored: [SPOTIFY, DISCORD, CALC], suppressed: 1 });
    const recents = world.started();

    assertEqual(recents.suppressedSlots, 1, 'an honest count is untouched');
    // Three remembered, three slots, one held empty: the oldest stays off.
    assertEqual(recents.visibleIds(), [DISCORD, SPOTIFY], 'and its gap still holds');
});

// -- result ---------------------------------------------------------------

print('');
if (failures > 0) {
    print(`${failures} of ${run} tests FAILED`);
    imports.system.exit(1);
}
print(`all ${run} tests passed`);
