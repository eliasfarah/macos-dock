/* launcherEntry.js
 *
 * Real 0-100 progress on dock icons, published by the applications
 * themselves over `com.canonical.Unity.LauncherEntry`.
 *
 * -- why this and not the disk -----------------------------------------
 *
 * The folder-stack bar in dockFolderIcon.js infers a download's progress
 * from the partial file on disk, and it can only show a true fraction when
 * the downloader preallocates the final size (aria2, `curl -C`, torrent
 * clients, GNOME Files' own copy). For Chrome it cannot, and that was
 * measured rather than assumed — twice. A 60,000,000-byte download served
 * with an explicit Content-Length was sampled every two seconds through a
 * full transfer:
 *
 *     size= 5800000  alloc= 5804032
 *     size= 9800000  alloc= 9801728
 *     ...
 *     size=49800000  alloc=49803264
 *
 * `size` and `alloc` track each other exactly all the way up: nothing is
 * preallocated, so the file never reveals how big it will end up. The
 * `.crdownload` also carries no extended attributes at all (`getfattr -d`
 * returns nothing during the transfer), so the origin URL isn't there to
 * ask the server about either. The number simply is not on disk.
 *
 * This is the channel that does carry it. It is the standard way an app
 * tells a dock about its own progress on this desktop — the direct
 * analogue of what Safari does for the macOS Dock — and it is what Unity's
 * launcher, Plank, Dash to Dock and the KDE task manager all consume.
 * Files, Transmission, qBittorrent, Steam and several others publish it.
 * Chrome and Chromium publish neither this nor a usable on-disk total,
 * which is a limitation of those browsers, not something a dock can work
 * around without reading the user's browsing history.
 *
 * -- the protocol -------------------------------------------------------
 *
 * An application broadcasts a signal:
 *
 *     com.canonical.Unity.LauncherEntry.Update(
 *         's'  application://<desktop-file-id>,
 *         'a{sv}'  { progress: d, progress-visible: b, count: x,
 *                    count-visible: b, urgent: b })
 *
 * Most implementations only start emitting once *something* on the bus
 * owns the well-known name `com.canonical.Unity`, which is how they detect
 * that a launcher is listening — so owning that name is part of
 * implementing the consumer side, not an optional extra.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const UNITY_BUS_NAME = 'com.canonical.Unity';
const LAUNCHER_INTERFACE = 'com.canonical.Unity.LauncherEntry';
const APPLICATION_URI_PREFIX = 'application://';

export class LauncherEntryWatcher {
    /**
     * @param {function(string, object)} onUpdate - called with the app's
     *   desktop-file id (e.g. "org.gnome.Nautilus.desktop") and
     *   `{ progress, count, urgent }`, where `progress` is 0..1 or -1 when
     *   the app is not reporting any, and `count` is -1 likewise.
     */
    constructor(onUpdate) {
        this._onUpdate = onUpdate;
        this._entries = new Map(); // desktop id -> { progress, count, urgent }
        this._signalId = 0;
        this._nameOwnerId = 0;
        this._connection = null;
    }

    enable() {
        try {
            this._connection = Gio.DBus.session;
        } catch (error) {
            // No session bus (this can happen in a bare headless test
            // harness). Nothing to watch; the dock simply shows no
            // app-published progress.
            return;
        }

        this._signalId = this._connection.signal_subscribe(
            null, // any sender: this is a broadcast, not a call
            LAUNCHER_INTERFACE,
            'Update',
            null, // any object path — publishers pick their own
            null,
            Gio.DBusSignalFlags.NONE,
            (conn, sender, path, iface, signal, params) => this._onSignal(params));

        // Owning the name is what makes most publishers start emitting.
        // NONE (not REPLACE): if something else on this session already
        // provides a launcher — Dash to Dock, a KDE panel — it keeps the
        // name and we simply listen, since the signal is a broadcast every
        // subscriber receives regardless of who owns the name.
        this._nameOwnerId = Gio.bus_own_name(
            Gio.BusType.SESSION, UNITY_BUS_NAME, Gio.BusNameOwnerFlags.NONE,
            null, null, null);
    }

    disable() {
        if (this._signalId && this._connection) {
            this._connection.signal_unsubscribe(this._signalId);
            this._signalId = 0;
        }
        if (this._nameOwnerId) {
            Gio.bus_unown_name(this._nameOwnerId);
            this._nameOwnerId = 0;
        }
        this._connection = null;
        this._entries.clear();
    }

    /** Everything currently being reported, for a dock rebuild. */
    get entries() {
        return this._entries;
    }

    _onSignal(params) {
        // (s, a{sv}) — deep_unpack on the properties dictionary leaves the
        // values as GVariants, so each is unpacked individually below
        // rather than trusting a recursive unpack to guess the types.
        let appUri, properties;
        try {
            [appUri, properties] = params.deep_unpack();
        } catch (error) {
            return; // malformed signal from some publisher; ignore it
        }

        if (typeof appUri !== 'string' || !appUri.startsWith(APPLICATION_URI_PREFIX))
            return;
        const desktopId = appUri.slice(APPLICATION_URI_PREFIX.length);
        if (!desktopId)
            return;

        const read = (key, fallback) => {
            const value = properties?.[key];
            return value instanceof GLib.Variant ? value.unpack() : fallback;
        };

        // `progress-visible` is the authoritative switch: publishers leave a
        // stale `progress` in the dictionary after a transfer finishes and
        // rely on the flag to say it no longer means anything. Reading
        // `progress` alone leaves a full bar stuck on the icon forever.
        const entry = {
            progress: read('progress-visible', false) ? read('progress', 0) : -1,
            count: read('count-visible', false) ? read('count', 0) : -1,
            urgent: !!read('urgent', false),
        };

        if (entry.progress < 0 && entry.count < 0 && !entry.urgent)
            this._entries.delete(desktopId);
        else
            this._entries.set(desktopId, entry);

        this._onUpdate?.(desktopId, entry);
    }
}
