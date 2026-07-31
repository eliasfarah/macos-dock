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
 * The row this describes has one zone, not two:
 *
 *     [pinned] | [open and recent apps, in the order they arrived] | [trash]
 *
 * The rule the whole module exists to enforce: **an icon never moves.** A
 * slot is assigned once, when an unpinned app first turns up on the dock,
 * and it is the last slot in the row — the one nearest the trash. From then
 * on nothing changes it:
 *
 *   - launching an app appends it on the right. Everything already on the
 *     row keeps its place; a new app cannot push its neighbours sideways
 *     because it never lands among them;
 *   - quitting an app moves nothing at all. It loses its running dot and
 *     starts being remembered as a recent, in the slot it already had —
 *     which may well be to the *right* of an app that is still open, or to
 *     the left of one launched after it. The row is arrival order, not
 *     running-first;
 *   - reopening a recent moves nothing either: it gains its dot back in
 *     place. Quitting it again is a no-op for position too;
 *   - so the queue is honestly FIFO. Past the limit (default 3 remembered
 *     apps) the *oldest slot* is the one that drops out. What the limit
 *     counts is places the dock is holding, not apps that happen to be shut:
 *     an app stays in the sum while it is open, so reopening one cannot free
 *     a place and let an app that aged out long ago back onto the dock. A
 *     running app is still never dropped — one past the window, or never
 *     remembered at all, is drawn because it is open;
 *   - pinned apps are never in the row: they have their own dock section and
 *     letting them into this one would duplicate them. Pinning a recent app
 *     therefore deletes it from history outright (see dropPinned());
 *   - only ids that survive a reboot are remembered (see isPersistentAppId).
 *     An app with no stable id keeps its slot while it runs and gives it up
 *     when it quits, because there is nothing to store.
 *
 * Focus is deliberately not an input, and neither is close time. Switching
 * between two windows, or quitting and reopening all afternoon, must leave
 * the dock looking exactly as it did.
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
//
//   1 -> 2  The list was stored most-recently-quit first and reversed for
//           display, because close time decided position. Position is now
//           fixed at arrival and close time decides nothing, so the list is
//           stored in the order it is drawn, left to right. The two are
//           exact reverses of each other, so state written under the old
//           rule is migrated by reversing it — which keeps everyone's row
//           looking the same across the upgrade instead of flipping it.
export const RECENTS_FORMAT = 2;

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
 * filed as a brand-new recent that takes a slot the genuine entries need —
 * the recents section visibly reshuffling across a reboot even though
 * nothing about it should have changed.
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

/** First occurrence wins, so an app keeps the slot it arrived in. */
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
     * @param {Function} ports.limit      () => how many closed entries to show
     */
    constructor({ storage, isPinned, appExists, limit }) {
        this._storage = storage;
        this._isPinned = isPinned;
        this._appExists = appExists;
        this._limit = limit;

        // Every slot in the row, left to right — the running apps and the
        // remembered ones in one list, because they share one ordering.
        // Appended to at arrival and never resorted: this array *is* the
        // promise that icons do not move.
        this._order = [];
        // Which of those slots belong to an app that has been quit at least
        // once, and so is remembered after it stops running. A slot not in
        // here lasts only as long as its app does. Always a subset of
        // _order, and only ever holds persistent ids.
        this._remembered = new Set();
        // What was running at the previous sync, to turn a new set of
        // running apps into launches and quits. Not an ordering: the row's
        // order lives in _order alone.
        this._running = new Set();
        // How many visible slots "Remove from Dock" has emptied. Persisted,
        // so a gap the user made survives a reboot — see forget().
        this._suppressed = 0;
        // Last thing written, to keep redundant GSettings writes out of the
        // redisplay path.
        this._stored = [];
    }

    /** The remembered entries, in the order they are drawn. */
    get ids() {
        return [...this._order].filter(id => this._remembered.has(id));
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

        // One-time, and recorded as done before anything else can write: an
        // unconditional reset here would defeat the whole reason the count
        // is persisted, which is that a gap the user made survives a
        // restart. See RECENTS_FORMAT for what changed under each step.
        const format = this._storage.getFormat();
        const stored = this._storage.getIds();
        let migrated = stored;
        if (format < 1)
            this._setSuppressed(0);
        if (format < 2)
            migrated = [...migrated].reverse();
        if (format < RECENTS_FORMAT)
            this._storage.setFormat(RECENTS_FORMAT);

        const cleaned = dedupe(migrated.filter(id => isPersistentAppId(id)));
        this._order = cleaned.slice(-RECENT_APPS_MEMORY);
        this._remembered = new Set(this._order);
        this._stored = [...this._order];
        // Compared against what was on disk, not against the migrated form.
        // The migration only ever runs once, so a reversal that is not
        // written back leaves a newest-first list behind a format that
        // promises display order — and the next startup draws it backwards.
        if (!sameSequence(this._order, stored))
            this._storage.setIds(this._order);
    }

    /**
     * Baseline for launch/quit detection, with nothing counted as a quit.
     *
     * Apps already running when the extension is enabled must not read as
     * quits: without this the first redisplay after a disable would read the
     * entire session as having been closed at once and file every open app
     * as a recent, in whatever order the app system happened to return
     * them — reordering the very section this exists to keep reproducible.
     *
     * They do take slots, though, since they need icons: unpinned ones the
     * restored row does not already name are appended to it, after the
     * remembered entries. An app that is both running and already
     * remembered keeps the slot it was restored with — quit last session,
     * relaunched at login, it comes back exactly where it was, wearing a
     * running dot.
     */
    seedRunning(runningIds) {
        this._running = new Set(runningIds);
        this._adopt(runningIds);
    }

    /**
     * The row, left to right: every running unpinned app plus the
     * remembered ones that still fit in the window, interleaved in the one
     * order they all share.
     *
     * The limit counts *remembered* entries — apps the dock is holding a
     * place for — and takes them from the right, the newest slots. Whether
     * such an app happens to be running right now is not part of the sum,
     * and that is the point: the memory is deeper than the window
     * (RECENT_APPS_MEMORY), so anything that shrinks the set being counted
     * pulls an older app back into view. Counting only *closed* apps did
     * exactly that — reopening a recent freed its place in the count and an
     * unrelated app that had long since aged out reappeared beside it. So
     * the rule is: launching or quitting an app adds or removes that app's
     * own icon, and never anybody else's.
     *
     * A running app is still never dropped: one that has aged out of the
     * window, or was never remembered at all, is drawn because it is open.
     * Whatever else is true, a running app has an icon.
     */
    visibleIds() {
        const windowSize = Math.max(0, this._limit() - this._suppressed);

        // An app can be uninstalled between one login and the next, in which
        // case it is simply skipped — it drops out of the queue on the next
        // write. Pinned ids are skipped rather than merely absent, because
        // an app can be pinned while its id is still mid-flight here.
        const remembered = this._order.filter(id =>
            this._remembered.has(id) && !this._isPinned(id) && this._appExists(id));
        const kept = new Set(remembered.slice(Math.max(0, remembered.length - windowSize)));

        return this._order.filter(id => {
            if (this._isPinned(id))
                return false;
            return this._running.has(id) || kept.has(id);
        });
    }

    /**
     * Folds the current set of running apps in: apps that appeared since
     * the last call have launched and take the next slot on the right, apps
     * that vanished have been quit and keep the slot they already had.
     *
     * App-level, not window-level: closing one window of an app that still
     * has others open does not change this set, so an app becomes a recent
     * only once its last window is gone — which is what Quit means. By the
     * same token opening a second window cannot produce a second slot.
     *
     * @returns {boolean} whether the row's *contents* changed. A plain quit
     *   returns false — the app keeps its slot, and only its running dot
     *   goes out, which is DockManager's business and not the model's.
     */
    syncRunning(runningIds) {
        const visibleBefore = this.visibleIds();

        const next = dedupe(runningIds);
        const nowRunning = new Set(next);
        const quit = [...this._running].filter(id => !nowRunning.has(id));

        this._running = nowRunning;
        // Every running app that has no slot yet, not merely the ones that
        // launched since the last call: an app unpinned while it is running
        // arrives here the same way, and also needs one.
        this._adopt(next);
        for (const id of quit)
            this._retire(id);
        this._persist();

        return !sameSequence(visibleBefore, this.visibleIds());
    }

    /**
     * Drops an app from the recents for good. Removing it from the
     * *remembered* set rather than from the visible row is what makes it
     * stick: the row is rebuilt from that set on every redisplay, so hiding
     * the icon alone would bring it straight back.
     *
     * A running app keeps its slot — its icon cannot go away while it is
     * open, and taking the slot would only move it back to the end of the
     * row later. What it loses is the memory: quit it and it has to earn a
     * place again like any app the dock has never seen.
     *
     * Removing a closed app also claims one suppressed slot, so the vacated
     * spot stays empty rather than being immediately refilled by the
     * next-oldest app in the memory. Quitting an app the memory was not
     * already holding is what releases it again (see _retire).
     */
    forget(appId) {
        const visibleBefore = this.visibleIds();
        const emptiedASlot = visibleBefore.includes(appId) && !this._running.has(appId);

        this._remembered.delete(appId);
        if (!this._running.has(appId))
            this._order = this._order.filter(id => id !== appId);
        if (emptiedASlot)
            this._setSuppressed(this._suppressed + 1);
        this._persist();

        return !sameSequence(visibleBefore, this.visibleIds());
    }

    /**
     * Evicts every id that is now pinned.
     *
     * Filtering them at display time alone was not enough: the row kept an
     * invisible slot for a pinned app, which came back the moment the app
     * was unpinned — an app arriving in the recents section purely because
     * it stopped being pinned, without having been used. Pinning is
     * therefore a hard delete from history, and after unpinning an app has
     * to be opened again to earn a place back (at the end of the row, like
     * any new arrival).
     *
     * Unlike the other mutators this reports whether the *stored* list
     * changed, not the visible row: by the time it runs the app is already
     * pinned, so visibleIds() has been filtering it out since before the
     * call and could never show a difference. The caller repaints anyway —
     * pinning always moves an icon between sections.
     *
     * @returns {boolean} whether anything was evicted
     */
    dropPinned() {
        const before = this._order;
        this._order = this._order.filter(id => !this._isPinned(id));
        for (const id of before) {
            if (this._isPinned(id))
                this._remembered.delete(id);
        }
        this._persist();
        return !sameSequence(before, this._order);
    }

    /**
     * Wipes the history outright, and with it any suppressed slots. Running
     * apps keep their slots: "Clear Recent Apps" is not a request to take
     * the icon off an app you are looking at.
     */
    clear() {
        const visibleBefore = this.visibleIds();
        this._remembered.clear();
        this._order = this._order.filter(id => this._running.has(id));
        this._setSuppressed(0);
        this._persist();
        return !sameSequence(visibleBefore, this.visibleIds());
    }

    /**
     * Gives a slot to each unpinned app that has none, in the order given,
     * at the end of the row. This is the only place the row grows, and it
     * only ever grows on the right — the half of "icons do not move" that
     * arrivals are responsible for.
     */
    _adopt(ids) {
        const seated = new Set(this._order);
        for (const id of ids) {
            if (seated.has(id) || this._isPinned(id))
                continue;
            seated.add(id);
            this._order.push(id);
        }
    }

    /**
     * Hands a quit app over to the memory, in place. An app that cannot be
     * remembered gives its slot up instead — there is nothing to draw once
     * it is neither running nor stored.
     */
    _retire(appId) {
        if (!this._order.includes(appId))
            return; // pinned, or never had a slot

        const storable = isPersistentAppId(appId) && !this._isPinned(appId) &&
            this._appExists(appId);
        if (!storable) {
            this._remembered.delete(appId);
            this._order = this._order.filter(id => id !== appId);
            return;
        }

        // Already remembered: it keeps everything it had, whatever the
        // preference currently is. Turning the section off is a display
        // decision, so it must not quietly erase a history that turning it
        // back on would have shown.
        if (this._remembered.has(appId))
            return;

        if (this._limit() <= 0) {
            this._order = this._order.filter(id => id !== appId);
            return;
        }

        // Quitting an app the memory was not already holding is the one
        // thing allowed to reclaim a slot that "Remove from Dock"
        // suppressed — see forget().
        this._remembered.add(appId);
        this._setSuppressed(this._suppressed - 1);
        this._enforceMemoryCap();
    }

    /**
     * Keeps the memory to RECENT_APPS_MEMORY entries by dropping the oldest
     * slots — the same end of the row the visible window drops. A running
     * app only loses the memory, not the slot: its icon is on the dock
     * because it is open, and moving it would be the one unforgivable
     * thing.
     */
    _enforceMemoryCap() {
        if (this._remembered.size <= RECENT_APPS_MEMORY)
            return;

        for (const id of [...this._order]) {
            if (this._remembered.size <= RECENT_APPS_MEMORY)
                break;
            if (!this._remembered.has(id))
                continue;
            this._remembered.delete(id);
            if (!this._running.has(id))
                this._order = this._order.filter(other => other !== id);
        }
    }

    _persist() {
        const ids = this.ids;
        if (sameSequence(ids, this._stored))
            return;
        this._stored = ids;
        this._storage.setIds(ids);
    }

    _setSuppressed(count) {
        const next = clampInt(count, 0, RECENT_APPS_MAX_SUPPRESSED);
        if (next === this._suppressed)
            return;
        this._suppressed = next;
        this._storage.setSuppressed(next);
    }
}
