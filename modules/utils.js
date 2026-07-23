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
 * (empty on error), sorted by display name.
 */
const ENUMERATE_ATTRIBUTES = [
    'standard::name',
    'standard::display-name',
    'standard::icon',
    'standard::content-type',
    // Populated only if a thumbnail was already generated and cached
    // (e.g. by Nautilus) under the freedesktop thumbnail spec — cheap
    // to query, no extra dependency, and covers the common case.
    'thumbnail::path',
    'thumbnail::is-valid',
].join(',');

const ENUMERATE_BATCH_SIZE = 50;

function toEntry(enumerator, info) {
    const child = enumerator.get_child(info);
    return {
        name: info.get_display_name(),
        gicon: info.get_icon(),
        contentType: info.get_content_type(),
        uri: child.get_uri(),
        isDirectory: info.get_file_type() === Gio.FileType.DIRECTORY,
        thumbnailPath: info.get_attribute_byte_string('thumbnail::path'),
        thumbnailValid: info.get_attribute_boolean('thumbnail::is-valid'),
    };
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
                        entries.sort((a, b) => a.name.localeCompare(b.name));
                        callback(entries);
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

export function launchUri(uri) {
    try {
        Gio.AppInfo.launch_default_for_uri(uri, null);
    } catch (error) {
        logError(error, 'macOS Dock Stack: failed to open item');
    }
}
