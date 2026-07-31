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
 * so the last id in an array is the one nearest the trash. The rule almost
 * every test below is really checking is that an id's index, once assigned,
 * never changes again — launching or quitting an app that already has a
 * slot leaves every index exactly where it was.
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

    /** The whole trailing row, exactly as the dock draws it. */
    get row() {
        return this.recents.visibleIds();
    }

    /** Where an app sits in that row, or -1. */
    slotOf(id) {
        return this.row.indexOf(id);
    }
}

const SPOTIFY = 'com.spotify.Client.desktop';
const DISCORD = 'com.discordapp.Discord.desktop';
const CALC = 'org.gnome.Calculator.desktop';
const EDITOR = 'org.gnome.TextEditor.desktop';
const FILES = 'org.gnome.Nautilus.desktop';

// -- arrival --------------------------------------------------------------

print('arrival');

test('an open app takes the slot nearest the trash', () => {
    const world = new World();
    const session = new Session(world.started()).open(SPOTIFY);

    assertEqual(session.row, [SPOTIFY], 'shown because it is running');
    assertEqual(world.stored, [], 'and nothing persisted: it has not been quit');
});

test('open apps do not spend the limit of three', () => {
    const world = new World();
    const session = new Session(world.started());
    session.open(SPOTIFY, DISCORD, CALC, EDITOR, FILES);

    assertEqual(session.row, [SPOTIFY, DISCORD, CALC, EDITOR, FILES],
        'all five stay on the dock, in launch order');
    assertEqual(session.recents.ids, [], 'none of them is a recent yet');
});

test('a new app appears at the right end, whatever its neighbours are doing', () => {
    // The row it lands on is deliberately mixed: a closed recent, then an
    // app that is still open. Neither state pulls an icon towards an end.
    const world = new World();
    const session = new Session(world.started());
    session.open(SPOTIFY).quit(SPOTIFY);   // closed, slot 1
    session.open(DISCORD);                 // open, slot 2

    session.open(CALC);

    assertEqual(session.row, [SPOTIFY, DISCORD, CALC], 'the newest is by the trash');
});

test('launching moves nothing that is already on the row', () => {
    const world = new World();
    const session = new Session(world.started());
    session.open(SPOTIFY, DISCORD).quit(SPOTIFY);
    const before = session.row;

    session.open(CALC);

    assertEqual(session.row.slice(0, before.length), before, 'the old slots are untouched');
});

// -- quitting -------------------------------------------------------------

print('quitting');

test('quitting an app keeps its slot; it does not jump to the end', () => {
    const world = new World();
    const session = new Session(world.started()).open(SPOTIFY, DISCORD, CALC);
    assertEqual(session.slotOf(DISCORD), 1);

    session.recents.syncRunning([SPOTIFY, CALC]);

    assertEqual(session.row, [SPOTIFY, DISCORD, CALC], 'same slots as before, Discord just lost its dot');
    assertEqual(world.stored, [DISCORD], 'only Discord is remembered; Spotify and Calc are still running');
});

test('quitting in any order leaves the row in arrival order', () => {
    const world = new World();
    const session = new Session(world.started()).open(SPOTIFY, DISCORD, CALC);

    session.quit(CALC, SPOTIFY, DISCORD);

    assertEqual(session.row, [SPOTIFY, DISCORD, CALC], 'arrival order, not close order');
    assertEqual(world.stored, [SPOTIFY, DISCORD, CALC], 'stored the way it is drawn');
});

test('an app with more than one window is filed only when the last one goes', () => {
    // Two windows of one app are still one entry in get_running(), so the
    // model cannot see the first one close — and must not, because the app
    // has not been quit.
    const world = new World();
    const session = new Session(world.started()).open(SPOTIFY);

    assert(!session.recents.syncRunning([SPOTIFY]), 'first window closed: no change');
    assertEqual(session.recents.ids, []);

    session.quit(SPOTIFY);
    assertEqual(session.recents.ids, [SPOTIFY], 'last window closed: remembered');
});

test('a pinned app never takes a slot in this row', () => {
    const world = new World({ pinned: [SPOTIFY] });
    const session = new Session(world.started()).open(SPOTIFY).quit(SPOTIFY);

    assertEqual(session.row, [], 'it belongs to the pinned section');
    assertEqual(session.recents.ids, [], 'no invisible entry either');
    assertEqual(world.writes, 0, 'and nothing written to storage');
});

test('an id with no stable .desktop entry keeps its slot only while it runs', () => {
    const world = new World();
    const session = new Session(world.started()).open(SPOTIFY, 'window:12');
    assertEqual(session.row, [SPOTIFY, 'window:12'], 'drawn like anything else');

    session.quit('window:12');

    assertEqual(session.row, [SPOTIFY], 'nothing to remember it by');
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
});

test('closing a reopened app leaves it exactly where reopening left it', () => {
    const world = new World();
    const session = new Session(world.started()).open(SPOTIFY, DISCORD, CALC);
    session.quit(SPOTIFY, DISCORD, CALC);

    session.open(SPOTIFY);
    assertEqual(session.row, [SPOTIFY, DISCORD, CALC], 'reopening something already shown moves nothing');

    session.quit(SPOTIFY);

    assertEqual(session.row, [SPOTIFY, DISCORD, CALC], 'closing it again moves nothing either');
    assertEqual(world.stored, [SPOTIFY, DISCORD, CALC], 'stored the way it is drawn');
});

test('a reopened app is no longer removable as a recent', () => {
    // DockManager offers "Remove from Dock" on the row entries that are not
    // running; reopening one takes it out of that set.
    const world = new World();
    const session = new Session(world.started()).open(SPOTIFY).quit(SPOTIFY);
    session.open(SPOTIFY);

    const removable = session.row.filter(id => !session.running.includes(id));
    assertEqual(removable, [], 'nothing to remove while it is open');
});

test('reopening does not duplicate a slot', () => {
    const world = new World();
    const session = new Session(world.started()).open(SPOTIFY).quit(SPOTIFY);
    session.open(SPOTIFY).quit(SPOTIFY).open(SPOTIFY).quit(SPOTIFY);

    assertEqual(session.recents.ids, [SPOTIFY]);
    assertEqual(session.row, [SPOTIFY]);
});

test('a running app is never dropped, even if it shrinks the budget for others', () => {
    // Spotify's own slot is the oldest on the row, so the limit would drop
    // it if it were closed — but a running app is never counted out. It
    // still occupies one of the row's three slots, though, so Discord (the
    // oldest of the three closed apps that follow) gives way instead of
    // all four fitting at once.
    const world = new World();
    const session = new Session(world.started()).open(SPOTIFY).quit(SPOTIFY);
    session.open(SPOTIFY);                  // holds the oldest slot, running

    session.open(DISCORD, CALC, EDITOR).quit(DISCORD, CALC, EDITOR);

    assertEqual(session.row, [SPOTIFY, CALC, EDITOR],
        'Spotify keeps its icon; Discord, the oldest closed slot, steps aside for it');
});

// -- the limit ------------------------------------------------------------

print('limit');

test('opening a new app while the window is already full evicts right away, not only on its own close', () => {
    const world = new World();
    const session = new Session(world.started()).open(SPOTIFY, DISCORD, CALC);
    session.quit(SPOTIFY, DISCORD, CALC);
    assertEqual(session.row, [SPOTIFY, DISCORD, CALC], 'three closed, exactly at the limit');

    session.open(EDITOR);

    assertEqual(session.row, [DISCORD, CALC, EDITOR],
        'Editor is drawn immediately, still running; Spotify steps aside before Editor is ever closed');
});

test('a fourth close drops the oldest slot, whatever order they were closed in', () => {
    const world = new World();
    const session = new Session(world.started()).open(SPOTIFY, DISCORD, CALC, EDITOR);
    session.quit(SPOTIFY, DISCORD, CALC, EDITOR);

    assertEqual(session.row, [DISCORD, CALC, EDITOR], 'Spotify held the oldest slot');
});

test('the window remembers arrival order, not close order', () => {
    // Arrival was Discord, Spotify, Calc, and they were closed in a
    // different order — the row (and eviction, once a fourth app takes the
    // window past its limit) follows arrival order regardless.
    const world = new World();
    const session = new Session(world.started()).open(DISCORD, SPOTIFY, CALC);
    session.quit(SPOTIFY, DISCORD, CALC);
    assertEqual(session.row, [DISCORD, SPOTIFY, CALC], 'three closed, all fit, in arrival order');

    session.open(EDITOR).quit(EDITOR);

    assertEqual(session.row, [SPOTIFY, CALC, EDITOR], 'Discord held the oldest slot');
});

test('reopening a recent does not summon an app that had aged out', () => {
    // Five apps used and quit, so two of them have dropped off the left of
    // a three-wide window and only live in the deeper memory. Reopening one
    // of the three on show must not free a place in the count and let one
    // of those two back in beside it: launching an app puts *that* app's
    // icon on the dock and touches nothing else.
    const world = new World();
    const session = new Session(world.started())
        .open(SPOTIFY, DISCORD, CALC, EDITOR, FILES)
        .quit(SPOTIFY, DISCORD, CALC, EDITOR, FILES);
    assertEqual(session.row, [CALC, EDITOR, FILES], 'the two oldest slots aged out');

    session.open(FILES);

    assertEqual(session.row, [CALC, EDITOR, FILES], 'same row, Files now running');
});

test('reopening an aged-out app forgets its old slot and starts fresh at the end', () => {
    const world = new World();
    const session = new Session(world.started())
        .open(SPOTIFY, DISCORD, CALC, EDITOR, FILES)
        .quit(SPOTIFY, DISCORD, CALC, EDITOR, FILES);
    assertEqual(session.row, [CALC, EDITOR, FILES], 'the two oldest slots aged out');

    // Spotify is not currently shown at all — its old slot (the very
    // oldest on the row) is stale history, not a reserved seat. Reopening
    // it is a fresh arrival: it jumps to the end, nearest the trash, same
    // as a brand-new app would. It also still occupies one of the three
    // slots, so Calc — the oldest of the three currently shown — steps
    // aside; Discord was already aged out and stays that way.
    session.open(SPOTIFY);

    assertEqual(session.row, [EDITOR, FILES, SPOTIFY],
        'seated fresh at the end, not resurrected at its old slot; Calc gives way');

    // It is already at the end, and closing it never relocates anything,
    // so nothing further changes.
    session.quit(SPOTIFY);

    assertEqual(session.row, [EDITOR, FILES, SPOTIFY], 'already the most recent; nothing left to do');
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

    assertEqual(session.row, [SPOTIFY, DISCORD, CALC, EDITOR]);
});

test('a limit of zero shows no recents and records none', () => {
    const world = new World({ limit: 0 });
    const session = new Session(world.started()).open(SPOTIFY);

    assert(session.recents.syncRunning([]), 'the icon went away');
    assertEqual(session.row, []);
    assertEqual(session.recents.ids, [], 'history not written while the section is off');
});

test('a limit of zero still leaves open apps on the dock', () => {
    const world = new World({ limit: 0 });
    const session = new Session(world.started()).open(SPOTIFY);

    assertEqual(session.row, [SPOTIFY]);
});

test('turning the section off does not erase the history it was showing', () => {
    const world = new World();
    const session = new Session(world.started()).open(SPOTIFY, DISCORD);
    session.quit(SPOTIFY);

    world.limit = 0;
    session.quit(DISCORD);
    world.limit = 3;

    assertEqual(session.recents.ids, [SPOTIFY], 'what was remembered still is');
    assertEqual(session.row, [SPOTIFY], 'Discord never earned a slot');
});

// -- removal --------------------------------------------------------------

print('removal');

test('forgetting an app drops it and leaves the slot empty', () => {
    const world = new World();
    const session = new Session(world.started()).open(SPOTIFY, DISCORD, CALC, EDITOR);
    session.quit(SPOTIFY, DISCORD, CALC, EDITOR);
    // visible: DISCORD, CALC, EDITOR — with SPOTIFY still in memory.

    session.recents.forget(CALC);

    assertEqual(session.row, [DISCORD, EDITOR], 'gone, and no backfill');
    assertEqual(session.recents.suppressedSlots, 1, 'one slot stays empty');
});

test('closing another app reclaims a suppressed slot', () => {
    const world = new World();
    const session = new Session(world.started()).open(SPOTIFY, DISCORD, CALC);
    session.quit(SPOTIFY, DISCORD, CALC);
    session.recents.forget(DISCORD);
    assertEqual(session.row.length, 2, 'suppressed down to two');

    session.open(EDITOR).quit(EDITOR);

    assertEqual(session.row, [SPOTIFY, CALC, EDITOR], 'back to three');
    assertEqual(session.recents.suppressedSlots, 0);
});

test('forgetting something that is not shown costs no slot', () => {
    const world = new World();
    const session = new Session(world.started()).open(SPOTIFY).quit(SPOTIFY);

    session.recents.forget(DISCORD);

    assertEqual(session.recents.suppressedSlots, 0, 'no unrelated recent blanked');
    assertEqual(session.row, [SPOTIFY]);
});

test('forgetting a running app takes the memory, not the icon or the slot', () => {
    const world = new World();
    const session = new Session(world.started()).open(SPOTIFY, DISCORD);
    session.quit(SPOTIFY, DISCORD);
    session.open(SPOTIFY);

    session.recents.forget(SPOTIFY);

    assertEqual(session.recents.suppressedSlots, 0, 'no slot claimed: nothing was emptied');
    assertEqual(session.row, [SPOTIFY, DISCORD], 'still on the dock, still in place');
    assertEqual(session.recents.ids, [DISCORD], 'but no longer remembered');
});

test('clearing wipes the history and the suppressed slots with it', () => {
    const world = new World();
    const session = new Session(world.started()).open(SPOTIFY, DISCORD, CALC);
    session.quit(SPOTIFY, DISCORD, CALC);
    session.recents.forget(CALC);

    session.recents.clear();

    assertEqual(session.recents.ids, []);
    assertEqual(session.row, []);
    assertEqual(session.recents.suppressedSlots, 0, 'a cleared list is not also a suppressed one');
});

test('clearing leaves the apps that are still open alone', () => {
    const world = new World();
    const session = new Session(world.started()).open(SPOTIFY, DISCORD);
    session.quit(SPOTIFY);

    session.recents.clear();

    assertEqual(session.row, [DISCORD], 'an open app is not history');
});

test('an uninstalled app is skipped rather than shown', () => {
    const world = new World();
    const session = new Session(world.started()).open(SPOTIFY, DISCORD);
    session.quit(SPOTIFY, DISCORD);
    world.uninstalled.add(DISCORD);

    assertEqual(session.row, [SPOTIFY]);
});

// -- pinning and unpinning ------------------------------------------------

print('pinning');

test('pinning a recent app removes it from the history immediately', () => {
    const world = new World();
    const session = new Session(world.started()).open(SPOTIFY, DISCORD);
    session.quit(SPOTIFY, DISCORD);

    world.pinned.add(SPOTIFY);
    assert(session.recents.dropPinned(), 'the row changed');

    assertEqual(session.row, [DISCORD], 'not shown');
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

    assertEqual(session.row, [DISCORD], 'Spotify stays off until it is used');
});

test('an unpinned app earns a fresh slot at the end by being opened', () => {
    const world = new World({ pinned: [SPOTIFY] });
    const session = new Session(world.started()).open(SPOTIFY, DISCORD);
    session.quit(SPOTIFY, DISCORD);
    session.recents.dropPinned();
    world.pinned.delete(SPOTIFY);

    session.open(SPOTIFY).quit(SPOTIFY);

    assertEqual(session.row, [DISCORD, SPOTIFY]);
});

test('an app unpinned while it is running is adopted rather than left iconless', () => {
    const world = new World({ pinned: [SPOTIFY] });
    const session = new Session(world.started()).open(DISCORD, SPOTIFY);
    assertEqual(session.row, [DISCORD], 'pinned apps are drawn elsewhere');

    world.pinned.delete(SPOTIFY);
    session.recents.syncRunning([...session.running]);

    assertEqual(session.row, [DISCORD, SPOTIFY], 'it takes the next slot');
});

test('a pinned app is filtered even if an old queue still names it', () => {
    const world = new World({ stored: [SPOTIFY, DISCORD], pinned: [SPOTIFY] });
    const recents = world.started();

    assertEqual(recents.visibleIds(), [DISCORD]);
});

// -- restart --------------------------------------------------------------

print('restart');

test('disable/enable preserves the remembered order; a never-closed app re-earns a slot', () => {
    // Calc is still running and has never been closed, so it was never
    // written to disk — there is nothing to restore its old position from.
    // Spotify and Discord, both remembered, come back exactly as closed.
    const world = new World();
    const first = new Session(world.started()).open(SPOTIFY, DISCORD, CALC);
    first.quit(SPOTIFY, DISCORD);

    // A fresh manager over the same GSettings, with Calculator still up.
    const second = world.started({ running: [CALC] });

    assertEqual(second.visibleIds(), [SPOTIFY, DISCORD, CALC],
        'remembered order preserved, Calc takes a fresh slot');
});

test('apps already running at enable time are not read as launches or quits', () => {
    const world = new World({ stored: [SPOTIFY, DISCORD] });
    const recents = world.started({ running: [CALC, EDITOR] });

    assert(!recents.syncRunning([CALC, EDITOR]), 'nothing filed');
    assertEqual(recents.ids, [SPOTIFY, DISCORD], 'restored order untouched');
    // Two running apps already spend two of the three slots, so only the
    // newer of the two restored closed apps still fits — Spotify's slot
    // aged out the moment there was no room left for it, same as it would
    // at any other point in the session.
    assertEqual(recents.visibleIds(), [DISCORD, CALC, EDITOR],
        'closed apps yield to running ones when the row is over budget');
});

test('an app running at enable time keeps the slot it was restored with', () => {
    const world = new World({ stored: [SPOTIFY, DISCORD] });
    const recents = world.started({ running: [SPOTIFY] });

    assertEqual(recents.visibleIds(), [SPOTIFY, DISCORD], 'drawn in place, with a dot');
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
    // Format 0 state: five apps remembered newest-first, three slots
    // charged by the old forget() — enough to blank a three-slot section.
    const world = new World({
        stored: [SPOTIFY, DISCORD, CALC, EDITOR, FILES], suppressed: 3, format: 0,
    });
    const recents = world.started();

    assertEqual(recents.suppressedSlots, 0, 'the inflated count is gone');
    assertEqual(recents.visibleIds(), [CALC, DISCORD, SPOTIFY],
        'and the section fills again, looking as it did');
    assertEqual(world.suppressed, 0, 'the reset reached storage');
    assertEqual(world.format, RECENTS_FORMAT, 'and was recorded as done');
});

test('a newest-first list is reversed, so the row survives the upgrade', () => {
    // Under format 1 the list was stored newest-first and reversed for
    // display: [SPOTIFY, DISCORD, CALC] was drawn CALC, DISCORD, SPOTIFY.
    const world = new World({ stored: [SPOTIFY, DISCORD, CALC], format: 1 });
    const recents = world.started();

    assertEqual(recents.visibleIds(), [CALC, DISCORD, SPOTIFY], 'the same row as before');
    assertEqual(world.stored, [CALC, DISCORD, SPOTIFY], 'now stored the way it is drawn');
    assertEqual(world.format, RECENTS_FORMAT);
});

test('the migration runs once, not on every startup', () => {
    const world = new World({ stored: [SPOTIFY, DISCORD], suppressed: 2, format: 0 });
    world.started();
    assertEqual(world.suppressed, 0, 'migrated on first load');

    // A gap the user makes *after* migrating has to survive a restart —
    // which is the entire reason the count is persisted.
    const second = world.started();
    second.forget(SPOTIFY);
    assertEqual(second.suppressedSlots, 1, 'a fresh removal charges a slot');

    const third = world.started();
    assertEqual(third.suppressedSlots, 1, 'and the gap is still there next time');
});

test('state already in the current format is left alone', () => {
    const world = new World({ stored: [SPOTIFY, DISCORD, CALC], suppressed: 1 });
    const recents = world.started();

    assertEqual(recents.suppressedSlots, 1, 'an honest count is untouched');
    // Three remembered, three slots, one held empty: the oldest stays off.
    assertEqual(recents.visibleIds(), [DISCORD, CALC], 'and its gap still holds');
});

// -- result ---------------------------------------------------------------

print('');
if (failures > 0) {
    print(`${failures} of ${run} tests FAILED`);
    imports.system.exit(1);
}
print(`all ${run} tests passed`);
