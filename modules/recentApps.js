/* recentApps.js
 *
 * The "recently opened" section macOS keeps between the pinned apps and the
 * folders/trash: an app you launched but never pinned stays on the Dock after
 * you quit it, and only the most recent few are kept.
 *
 * This module is the *state* half of that feature — the queue, its ordering
 * rules and its persistence — with no Clutter, St or Shell dependency at all.
 * Everything it needs to know about the outside world arrives through four
 * injected ports (see the constructor), which is what lets
 * tests/recentApps.test.js drive it under bare gjs with no compositor.
 * DockManager owns the other half: creating, reordering and destroying the
 * actual icons.
 *
 * The row this describes has two zones, drawn in this order:
 *
 *     [pinned] | [open apps] [recents] | [folders] [trash]
 *
 * Ordering rules, in one place:
 *
 *   - the queue is filled by *quitting*, not by launching. An unpinned app
 *     you open appears in the open zone with its running dot and costs the
 *     queue nothing, so opening a dozen apps never pushes a single recent
 *     off the end;
 *   - quitting an unpinned app files it at the recent end of the queue, and
 *     that end is drawn last — nearest the trash. Each further quit pushes
 *     the older entries one place left (see visibleIds());
 *   - past the limit the queue is FIFO: closing a fourth app drops the
 *     oldest out of the window;
 *   - reopening a recent app does not move it. It keeps the slot it already
 *     holds and merely gains a running dot, because an icon jumping across
 *     the dock the instant you click it is exactly what a dock must not do.
 *     It stops being a recent — nothing evicts it while it is open — but it
 *     is not refiled until it is quit again, which puts it back at the
 *     recent end where its close time says it belongs;
 *   - an open app whose slot has been pushed out of the window by later
 *     quits falls back to the open zone rather than vanishing: whatever else
 *     is true, a running app has an icon;
 *   - pinned apps are never in the queue: they have their own dock section
 *     and letting them into this one would duplicate them. Pinning a recent
 *     app therefore deletes it from history outright (see dropPinned());
 *   - only ids that survive a reboot are stored (see isPersistentAppId).
 *
 * Focus is deliberately not an input. The order here is chronological by
 * close time, so switching between two open windows must not disturb it.
 */

// How many app ids the queue remembers on disk, independently of how many
// the preference currently displays. Deeper than the visible window so
// that lowering the preference and raising it again does not permanently
// forget apps the higher setting would have shown.
export const RECENT_APPS_MEMORY = 12;

// Ceiling for the suppressed-slot counter, matching the `dock-recent-apps`
// schema range: suppressing more slots than the section can ever show
// would only mean "the section stays empty forever".
export const RECENT_APPS_MAX_SUPPRESSED = 6;

// Current layout of the persisted recents state. Bumped when a stored
// value changes meaning rather than merely changing; load() then migrates
// once and records that it has, so the migration cannot run again and undo
// what the user has done since.
//
//   0 -> 1  The suppressed counter was charged by the version of forget()
//           that lived in dockManager, which incremented it on every
//           removal — including apps that were running, and so kept their
//           icon regardless, and apps that were not on show at all. Neither
//           empties a slot, so the stored count drifted above the number of
//           real gaps, and a count that reaches the preference blanks the
//           section outright. Counts written under that rule cannot be
//           told apart from honest ones, so they are dropped.
export const RECENTS_FORMAT = 1;

function clampInt(value, min, max) {
    return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Whether an app id is worth writing to disk.
 *
 * A window the shell cannot match to a desktop entry still gets a
 * ShellApp, but with a synthetic id of the form `window:<n>` built from the
 * window's stable sequence number — a per-session counter. Storing one is
 * worse than useless: after the next boot that id resolves to nothing, the
 * same program comes back under a *different* synthetic id, and it is
 * filed as a brand-new recent that pushes the genuine entries one place
 * further down the queue until they fall off the end of it — the recents
 * section visibly reshuffling across a reboot even though nothing about it
 * should have changed.
 *
 * Flatpak and snap apps are unaffected: they have real .desktop ids
 * (`com.spotify.Client.desktop`) like everything else. The apps this does
 * exclude are the ones with no stable identity to store in the first
 * place — a bare X11 window, or an Electron build whose WM_CLASS matches
 * no installed entry. They still get an icon for as long as they are
 * running; they just cannot outlive the session.
 */
export function isPersistentAppId(id) {
    return typeof id === 'string' && id.endsWith('.desktop');
}

/** First occurrence wins, so the front of the queue is the recent end. */
function dedupe(ids) {
    return [...new Set(ids)];
}

function sameSequence(a, b) {
    return a.length === b.length && a.every((id, i) => id === b[i]);
}

export class RecentApps {
    /**
     * @param {object} ports
     * @param {object} ports.storage   getIds/setIds/getSuppressed/setSuppressed
     * @param {Function} ports.isPinned   (appId) => boolean
     * @param {Function} ports.appExists  (appId) => boolean — still installed
     * @param {Function} ports.limit      () => how many entries to show
     */
    constructor({ storage, isPinned, appExists, limit }) {
        this._storage = storage;
        this._isPinned = isPinned;
        this._appExists = appExists;
        this._limit = limit;

        // The queue, most recently quit first. Stored in that direction —
        // it is the end the queue grows at — and reversed for display.
        // Holding an entry here is what reserves a slot in the row, which
        // is why a reopened app stays in the list instead of being taken
        // out of it: leaving would mean losing its place.
        this._ids = [];
        // How many visible slots "Remove from Dock" has emptied. Persisted,
        // so a gap the user made survives a reboot — see forget().
        this._suppressed = 0;
        // Running app ids in launch order. Doubles as the previous-state
        // baseline that turns a new set of running apps into launches and
        // quits, and as the open zone's left-to-right order.
        this._running = [];
    }

    /** The stored queue, most recently quit first. */
    get ids() {
        return [...this._ids];
    }

    get suppressedSlots() {
        return this._suppressed;
    }

    /**
     * Session-start state. Repairs the stored queue in place rather than
     * letting bad entries age out, so ids that cannot survive a reboot stop
     * occupying slots in the memory immediately.
     */
    load() {
        this._suppressed = clampInt(
            this._storage.getSuppressed(), 0, RECENT_APPS_MAX_SUPPRESSED);

        // One-time, and recorded as done before anything else can write:
        // an unconditional reset here would defeat the whole reason the
        // count is persisted, which is that a gap the user made survives a
        // restart. See RECENTS_FORMAT for what changed under it.
        if (this._storage.getFormat() < RECENTS_FORMAT) {
            this._setSuppressed(0);
            this._storage.setFormat(RECENTS_FORMAT);
        }

        const stored = this._storage.getIds();
        const cleaned = dedupe(stored.filter(id => isPersistentAppId(id)));
        this._ids = cleaned.slice(0, RECENT_APPS_MEMORY);
        if (!sameSequence(this._ids, stored))
            this._storage.setIds(this._ids);
    }

    /**
     * Baseline for launch/quit detection, with nothing counted as either.
     *
     * Apps already running when the extension is enabled must not read as
     * launches or as quits: without this the first redisplay after a
     * disable would read the entire session as having been closed at once
     * and file every open app as a recent, in whatever order the app system
     * happened to return them — reordering the very section this exists to
     * keep reproducible.
     *
     * An app that is both running and already in the queue keeps its slot:
     * quit last session, relaunched at login, it comes back exactly where
     * it was, wearing a running dot.
     */
    seedRunning(runningIds) {
        this._running = dedupe(runningIds);
    }

    /**
     * The queue entries the dock draws, in the order it draws them — left
     * to right, oldest first, the most recently quit app last so that it
     * lands nearest the trash.
     *
     * Derived from the persisted queue alone, deliberately NOT from what
     * happens to be running. That is what makes the section reproducible:
     * it comes back after a reboot showing exactly what it showed before,
     * in the same order — and it is what holds a reopened app's slot still
     * underneath it.
     *
     * Pinned apps are skipped rather than merely absent, because an app can
     * be pinned while its id is still mid-flight in the queue.
     */
    visibleIds() {
        const limit = this._limit() - this._suppressed;
        if (limit <= 0)
            return [];

        const ids = [];
        for (const id of this._ids) {
            if (ids.length >= limit)
                break;
            if (this._isPinned(id))
                continue;
            // An app can be uninstalled between one login and the next, in
            // which case it is simply skipped — it drops out of the queue
            // on the next write.
            if (this._appExists(id))
                ids.push(id);
        }
        return ids.reverse();
    }

    /**
     * The open zone: running unpinned apps that hold no slot in the window
     * above, left to right in the order they were launched.
     *
     * Launch order, not focus order and not the app system's own order —
     * both of those move an icon sideways every time you click a window.
     *
     * Apps drop in here from two directions: freshly launched ones that
     * have never been quit, and ones whose slot later quits pushed out of
     * the window. Either way the alternative would be a running app with no
     * icon at all.
     */
    openIds() {
        const seated = new Set(this.visibleIds());
        return this._running.filter(id => !this._isPinned(id) && !seated.has(id));
    }

    /**
     * Folds the current set of running apps in: apps that appeared since
     * the last call have launched, apps that vanished have been quit, and
     * it is the quits that enter the queue.
     *
     * App-level, not window-level: closing one window of an app that still
     * has others open does not change this set, so an app is filed as a
     * recent only once its last window is gone — which is what Quit means.
     * By the same token opening a second window cannot produce a second
     * entry.
     *
     * Launching touches the queue not at all. An app already in it keeps
     * its slot (that is what stops a reopened icon from jumping), and one
     * that is not in it has no business being there until it is quit.
     *
     * @returns {boolean} whether the *visible* section changed
     */
    syncRunning(runningIds) {
        const visibleBefore = this.visibleIds();

        const next = dedupe(runningIds);
        const nowRunning = new Set(next);
        const wasRunning = new Set(this._running);
        const launched = next.filter(id => !wasRunning.has(id));
        const quit = this._running.filter(id => !nowRunning.has(id));

        // Survivors keep the order they already had and new arrivals go on
        // the end, so an app's place in the open zone is fixed at launch.
        this._running = [...this._running.filter(id => nowRunning.has(id)), ...launched];

        if (quit.length > 0 && this._limit() > 0)
            this._recordClosed(quit);

        return !sameSequence(visibleBefore, this.visibleIds());
    }

    /**
     * Drops an app from the queue for good. Removing it from the *stored*
     * list rather than from the visible row is what makes it stick: the row
     * is rebuilt from this list on every redisplay, so hiding the icon
     * alone would bring it straight back.
     *
     * Also claims one suppressed slot, so the vacated spot stays empty
     * rather than being immediately refilled by the next-oldest app in the
     * queue. Quitting another unpinned app is what releases it again (see
     * _recordClosed).
     *
     * A slot is only claimed when the removal actually empties one: an app
     * that was not being shown, or one that is running and therefore keeps
     * its icon regardless, leaves no gap to hold open, and charging for it
     * would silently blank an unrelated recent instead.
     */
    forget(appId) {
        const visibleBefore = this.visibleIds();
        const emptiedASlot =
            visibleBefore.includes(appId) && !this._running.includes(appId);
        this._setIds(this._ids.filter(id => id !== appId));
        if (emptiedASlot)
            this._setSuppressed(this._suppressed + 1);
        return !sameSequence(visibleBefore, this.visibleIds());
    }

    /**
     * Evicts every id that is now pinned.
     *
     * Filtering them at display time alone was not enough: the queue kept
     * an invisible entry for a pinned app, which came back the moment the
     * app was unpinned — an app arriving in the recents section purely
     * because it stopped being pinned, without having been used. Pinning is
     * therefore a hard delete from history, and after unpinning an app has
     * to be opened and quit again to earn a place back.
     *
     * Unlike the other mutators this reports whether the *stored queue*
     * changed, not the visible section: by the time it runs the app is
     * already pinned, so visibleIds() has been filtering it out since
     * before the call and could never show a difference. The caller
     * repaints anyway — pinning always moves an icon between sections.
     *
     * @returns {boolean} whether anything was evicted
     */
    dropPinned() {
        const before = this._ids;
        this._setIds(this._ids.filter(id => !this._isPinned(id)));
        return !sameSequence(before, this._ids);
    }

    /** Wipes the history outright, and with it any suppressed slots. */
    clear() {
        const visibleBefore = this.visibleIds();
        this._setIds([]);
        this._setSuppressed(0);
        return !sameSequence(visibleBefore, this.visibleIds());
    }

    /**
     * Files quit apps at the recent end of the queue, without ever
     * duplicating one. Everything past RECENT_APPS_MEMORY falls off the far
     * end; everything past the preference stops being drawn well before
     * that (see visibleIds()).
     *
     * This is the one thing that moves an app that already had a slot, and
     * it has to: an app you just quit is by definition the most recently
     * closed one, which rule 3 puts nearest the trash.
     *
     * More than one id at a time means several apps disappeared between two
     * redisplays — a session shutting down, or a batch quit. There is no
     * timestamp to order them by, so the order the app system reported them
     * in stands, first treated as most recent.
     */
    _recordClosed(ids) {
        const accepted = dedupe(ids.filter(id =>
            isPersistentAppId(id) && !this._isPinned(id) && this._appExists(id)));
        if (accepted.length === 0)
            return;

        // Quitting an app the queue was not already holding is the only
        // thing allowed to reclaim a slot that "Remove from Dock"
        // suppressed — see forget().
        const known = new Set(this._ids);
        const fresh = accepted.filter(id => !known.has(id));
        if (fresh.length > 0)
            this._setSuppressed(this._suppressed - fresh.length);

        const closed = new Set(accepted);
        this._setIds([...accepted, ...this._ids.filter(id => !closed.has(id))]);
    }

    _setIds(ids) {
        const next = dedupe(ids).slice(0, RECENT_APPS_MEMORY);
        if (sameSequence(next, this._ids))
            return;
        this._ids = next;
        this._storage.setIds(next);
    }

    _setSuppressed(count) {
        const next = clampInt(count, 0, RECENT_APPS_MAX_SUPPRESSED);
        if (next === this._suppressed)
            return;
        this._suppressed = next;
        this._storage.setSuppressed(next);
    }
}
