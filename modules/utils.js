/* utils.js
 *
 * Small, dependency-free helpers shared across the extension: math,
 * actor geometry and filesystem access. Nothing here touches Clutter
 * animation state directly, so it is safe to use from both the shell
 * process (extension.js) and, where applicable, from the prefs process.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

export function lerp(a, b, t) {
    return a + (b - a) * t;
}

/**
 * Returns the on-screen (stage) geometry of an actor, following any
 * transforms applied by its ancestors (scroll views, dash reveal
 * animations, etc). This is what "where is the icon right now" means.
 */
export function getActorGeometry(actor) {
    const [x, y] = actor.get_transformed_position();
    const [width, height] = actor.get_transformed_size();
    return {
        x, y, width, height,
        centerX: x + width / 2,
        centerY: y + height / 2,
    };
}

export function generateStackId() {
    return `stack-${GLib.uuid_string_random()}`;
}

/**
 * Lists the contents of a directory asynchronously and invokes
 * `callback(entries)` on completion. `entries` is always an array
 * (empty on error), newest first — see sortEntries().
 */
const ENUMERATE_ATTRIBUTES = [
    'standard::name',
    // Required, not optional: info.get_file_type() reads this attribute
    // and a GFileInfo queried without it fails an internal assertion
    // ("GFileInfo created without standard::type" / "should not be
    // reached") and returns garbage — so `isDirectory` was never actually
    // being answered from real data. Silent until the shell is run with
    // --debug-control, which is how it finally showed up.
    'standard::type',
    'standard::display-name',
    'standard::icon',
    'standard::content-type',
    'standard::size',
    // Populated only if a thumbnail was already generated and cached
    // (e.g. by Nautilus) under the freedesktop thumbnail spec — cheap
    // to query, no extra dependency, and covers the common case.
    'thumbnail::path',
    'thumbnail::is-valid',
    // Ordering. `time::created` is the closest thing GIO exposes to
    // Finder's "Date Added" — it is the inode change/birth time, so a
    // file copied into the folder today sorts as new even if its
    // modification time is years old. Not every filesystem records it,
    // hence the fallback to `time::modified` in sortEntries().
    'time::modified',
    'time::created',
].join(',');

const ENUMERATE_BATCH_SIZE = 50;

// Suffixes browsers and download managers give a file while it is still
// being written. Firefox writes `.part`, Chromium `.crdownload`, Edge
// `.download`, Opera `.opdownload`, aria2 `.aria2`, wget/curl-style
// tooling `.partial`. A file wearing one of these is not a real document
// yet — it must not become the face of the dock's preview pile, and it is
// what tells us a download is in flight (see dockFolderIcon.js).
const PARTIAL_DOWNLOAD_SUFFIXES = [
    '.part', '.crdownload', '.download', '.opdownload', '.partial', '.aria2',
];

export function isPartialDownload(name) {
    const lower = name.toLowerCase();
    return PARTIAL_DOWNLOAD_SUFFIXES.some(suffix => lower.endsWith(suffix));
}

/**
 * Strips the in-progress suffix so a download in flight is listed under
 * the name it will actually have when it lands.
 */
export function finalDownloadName(name) {
    const lower = name.toLowerCase();
    for (const suffix of PARTIAL_DOWNLOAD_SUFFIXES) {
        if (lower.endsWith(suffix))
            return name.slice(0, -suffix.length);
    }
    return name;
}

function toEntry(enumerator, info) {
    const child = enumerator.get_child(info);
    const name = info.get_display_name();
    const partial = isPartialDownload(name);
    // Seconds, not the GLib.DateTime object: this is only ever compared,
    // and get_attribute_uint64 avoids allocating a DateTime per file on a
    // path that runs for every entry of every folder on every refresh.
    const created = info.get_attribute_uint64('time::created');
    const modified = info.get_attribute_uint64('time::modified');
    return {
        name: partial ? finalDownloadName(name) : name,
        gicon: info.get_icon(),
        contentType: info.get_content_type(),
        uri: child.get_uri(),
        path: child.get_path(),
        size: info.get_size(),
        isDirectory: info.get_file_type() === Gio.FileType.DIRECTORY,
        thumbnailPath: info.get_attribute_byte_string('thumbnail::path'),
        thumbnailValid: info.get_attribute_boolean('thumbnail::is-valid'),
        partial,
        time: created || modified || 0,
    };
}

/**
 * Newest first, the way a macOS stack sorts by Date Added — so the front
 * of the dock icon's preview pile is always the file that just arrived,
 * and the opened stack lists it first. Name is only the tiebreaker for
 * files sharing a timestamp (a batch copy, or a filesystem with
 * second-granularity times).
 *
 * Downloads still in flight sort *after* everything else regardless of
 * their time: a half-written `.part` is the newest thing in the folder by
 * a wide margin, and letting it take the front of the pile would replace
 * the icon with a generic "unknown file" glyph for the whole download.
 */
export function sortEntries(entries) {
    return entries.sort((a, b) => {
        if (a.partial !== b.partial)
            return a.partial ? 1 : -1;
        if (a.time !== b.time)
            return b.time - a.time;
        return a.name.localeCompare(b.name);
    });
}

export function listDirectory(path, callback) {
    const file = Gio.File.new_for_path(path);
    file.enumerate_children_async(
        ENUMERATE_ATTRIBUTES,
        Gio.FileQueryInfoFlags.NONE,
        GLib.PRIORITY_DEFAULT,
        null,
        (source, result) => {
            let enumerator;
            try {
                enumerator = source.enumerate_children_finish(result);
            } catch (error) {
                logError(error, 'macOS Dock Stack: failed to enumerate directory');
                callback([]);
                return;
            }

            const entries = [];

            // next_files_async, not the synchronous next_file() in a loop:
            // this runs inside the compositor's process, so a blocking
            // call here would stall every window and animation on the
            // desktop, not just this extension, for large folders.
            const readNextBatch = () => {
                enumerator.next_files_async(ENUMERATE_BATCH_SIZE, GLib.PRIORITY_DEFAULT, null, (source2, result2) => {
                    let infos;
                    try {
                        infos = source2.next_files_finish(result2);
                    } catch (error) {
                        logError(error, 'macOS Dock Stack: failed to read directory entries');
                        infos = [];
                    }

                    if (infos.length === 0) {
                        enumerator.close_async(GLib.PRIORITY_DEFAULT, null, () => {});
                        callback(sortEntries(entries));
                        return;
                    }

                    for (const info of infos)
                        entries.push(toEntry(enumerator, info));
                    readNextBatch();
                });
            };
            readNextBatch();
        }
    );
}

/**
 * The best available icon for a directory entry: its cached thumbnail when
 * one exists (so photos and screenshots show themselves, the way a macOS
 * stack does), otherwise the generic content-type icon GIO hands back.
 * Shared by the opened stack's items and the dock icon's own preview pile
 * so the two can never disagree about what a file looks like.
 */
export function iconForEntry(entry) {
    if (!entry.isDirectory && entry.thumbnailValid && entry.thumbnailPath) {
        try {
            return new Gio.FileIcon({ file: Gio.File.new_for_path(entry.thumbnailPath) });
        } catch (error) {
            // Fall through to the generic content-type icon below.
        }
    }
    return entry.gicon;
}

export function launchUri(uri) {
    try {
        Gio.AppInfo.launch_default_for_uri(uri, null);
    } catch (error) {
        logError(error, 'macOS Dock Stack: failed to open item');
    }
}
