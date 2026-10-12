// How reading progress from a device is combined with what the server has.
//
// Every row carries two times, both set on the device when the reader
// actually did something: updated_at for the reading position (a page turn,
// RSVP) and read_updated_at for the read/unread flag. Whichever side did it
// more recently wins, per book and per field. So progress made offline (on a
// plane) survives syncing afterwards, and going back to re-read an earlier
// chapter sticks, instead of the furthest position always winning.

/** ISO 8601 in UTC with milliseconds, or null. Same shape as SQL_NOW. */
export function isoTime(value) {
    if (!value) return null;
    const t = Date.parse(value);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// SQLite's equivalent of Date#toISOString(), so stored times compare as
// plain strings.
export const SQL_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/**
 * Rewrite any stored times in another shape (SQLite's datetime('now') gives
 * "YYYY-MM-DD HH:MM:SS", which sorts before every ISO string) to ISO.
 */
export function normalizeProgressTimes(db) {
    for (const col of ['updated_at', 'read_updated_at']) {
        db.prepare(`
            UPDATE reading_progress
            SET ${col} = strftime('%Y-%m-%dT%H:%M:%fZ', ${col})
            WHERE ${col} IS NOT NULL AND ${col} <> strftime('%Y-%m-%dT%H:%M:%fZ', ${col})
        `).run();
    }
}

/**
 * Apply a batch of progress updates for one user.
 *
 * Each update: { book_id, location, progress, is_read, updated_at,
 *                read_updated_at, read_state_only }
 *
 * - merge (default): per field, the more recent side wins. An update with no
 *   location never replaces a position.
 * - force (Push, "make the server match this device"): position and
 *   read-state are taken from the device, except that "no position" never
 *   erases one.
 * - read_state_only: only the read flag (and its time) changes.
 *
 * Updates for books the server doesn't have are skipped.
 */
export function applyProgressUpdates(db, userId, updates, { force = false } = {}) {
    const pos = 'excluded.location IS NOT NULL';
    const posNewer = `${pos} AND COALESCE(excluded.updated_at, '') > COALESCE(reading_progress.updated_at, '')`;
    const readNewer = "excluded.read_updated_at IS NOT NULL AND excluded.read_updated_at > COALESCE(reading_progress.read_updated_at, '')";

    const insert = `
        INSERT INTO reading_progress (user_id, book_id, location, progress, is_read, updated_at, read_updated_at)
        VALUES (@user_id, @book_id, @location, @progress, @is_read, @updated_at, @read_updated_at)
        ON CONFLICT(user_id, book_id) DO UPDATE SET`;

    const merge = db.prepare(`${insert}
        location        = CASE WHEN ${posNewer} THEN excluded.location   ELSE reading_progress.location   END,
        progress        = CASE WHEN ${posNewer} THEN excluded.progress   ELSE reading_progress.progress   END,
        updated_at      = CASE WHEN ${posNewer} THEN excluded.updated_at ELSE reading_progress.updated_at END,
        is_read         = CASE WHEN ${readNewer} THEN excluded.is_read         ELSE reading_progress.is_read         END,
        read_updated_at = CASE WHEN ${readNewer} THEN excluded.read_updated_at ELSE reading_progress.read_updated_at END
    `);

    const forced = db.prepare(`${insert}
        location        = CASE WHEN ${pos} THEN excluded.location ELSE reading_progress.location END,
        progress        = CASE WHEN ${pos} THEN excluded.progress ELSE reading_progress.progress END,
        updated_at      = CASE WHEN ${pos} THEN COALESCE(excluded.updated_at, ${SQL_NOW}) ELSE reading_progress.updated_at END,
        is_read         = CASE WHEN excluded.read_updated_at IS NOT NULL THEN excluded.is_read ELSE reading_progress.is_read END,
        read_updated_at = COALESCE(excluded.read_updated_at, reading_progress.read_updated_at)
    `);

    const readOnly = db.prepare(`${insert}
        is_read         = excluded.is_read,
        read_updated_at = excluded.read_updated_at
    `);

    const bookExists = db.prepare('SELECT 1 FROM books WHERE id = ?');
    const now = new Date().toISOString();

    db.transaction(() => {
        for (const u of updates) {
            if (!u?.book_id || !bookExists.get(u.book_id)) continue;
            const location = u.read_state_only ? null : (u.location ?? null);
            const row = {
                user_id: userId,
                book_id: u.book_id,
                location,
                progress: location ? Number(u.progress) || 0 : 0,
                is_read: u.is_read ? 1 : 0,
                // A new row with a position but no time gets "now"; an old
                // device's timeless position must not beat dated ones later,
                // but it is still better than no row at all.
                updated_at: location ? (isoTime(u.updated_at) ?? (force ? now : null)) : null,
                // Push only forces the read flag when the device has an opinion:
                // it changed the flag (a time) or has the book marked read. A
                // device that never touched it doesn't clear "read" set elsewhere.
                read_updated_at: isoTime(u.read_updated_at)
                    ?? (u.read_state_only || (force && u.is_read) ? now : null),
            };
            (u.read_state_only ? readOnly : force ? forced : merge).run(row);
        }
    })();
}
