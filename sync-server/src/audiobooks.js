// Audiobooks: scanning the audio folder and keeping listening positions.
//
//   audio/
//     The Empyrean/                    <- a series
//       cover.jpg                      <- optional series cover
//       01 - Fourth Wing.m4b           <- a book in one file (chapters are read from it)
//       Fourth Wing.jpg                <- optional cover, named after the book
//       Iron Flame/                    <- a book as a folder of tracks (mp3 parts, CDs)
//         01.mp3
//         02.mp3
//     Standalone.m4b                   <- books in the root are "Uncategorized"
//
// The files are only read, never written: the folder can be mounted read-only.
// Each book is probed once (tags, duration, chapters) and probed again only
// when its files change; a rename or a move between series keeps its id, so
// the listening position follows it, the same way epubs do.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { parseFile } from 'music-metadata';
import { computeFileHash } from './scanner.js';
import { isoTime } from './progressMerge.js';

export const AUDIO_TYPES = {
    '.m4b': 'audio/mp4',
    '.m4a': 'audio/mp4',
    '.mp4': 'audio/mp4',
    '.mp3': 'audio/mpeg',
    '.aac': 'audio/aac',
    '.ogg': 'audio/ogg',
    '.oga': 'audio/ogg',
    '.opus': 'audio/ogg',
    '.flac': 'audio/flac',
    '.wav': 'audio/wav',
    '.webm': 'audio/webm',
};

export const IMAGE_TYPES = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
};

const PICTURE_EXT = { 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const naturalCompare = (a, b) => collator.compare(a, b);

const ext = (name) => path.extname(name).toLowerCase();
// "._Book.m4b" (macOS metadata), ".hidden" and the like are never books.
const visible = (name) => !name.startsWith('.');
const isAudio = (name) => visible(name) && Object.hasOwn(AUDIO_TYPES, ext(name));
const isImage = (name) => visible(name) && Object.hasOwn(IMAGE_TYPES, ext(name));
const stem = (name) => path.basename(name, path.extname(name));

/**
 * "01 - Fourth Wing" -> "Fourth Wing". A leading number with a separator
 * orders the files but isn't part of the title. "1984" stays "1984".
 */
export function cleanTitle(name) {
    const stripped = String(name).replace(/^\s*\d{1,4}\s*[-–—._)]\s*/, '').trim();
    return stripped || String(name).trim();
}

function listDir(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true })
            .filter((e) => visible(e.name))
            .sort((a, b) => naturalCompare(a.name, b.name));
    } catch {
        return [];
    }
}

/** An image in `entries` named like the book, with or without its number. */
function namedImage(entries, names) {
    const wanted = new Set(names.map((n) => n.toLowerCase()));
    const hit = entries.find((e) => e.isFile() && isImage(e.name) && wanted.has(stem(e.name).toLowerCase()));
    return hit ? hit.name : null;
}

/** cover.* first, else the first image there is. */
function folderCover(entries) {
    const images = entries.filter((e) => e.isFile() && isImage(e.name));
    return (images.find((e) => stem(e.name).toLowerCase() === 'cover') || images[0])?.name || null;
}

/**
 * Tags, duration and chapters of one audio file. A file that can't be read
 * still makes a playable book: the browser works out the duration itself.
 */
async function probe(file) {
    try {
        const { common, format } = await parseFile(file, { includeChapters: true });
        const duration = Number.isFinite(format.duration) ? format.duration : 0;
        const chapters = (format.chapters || [])
            .map((c) => ({
                title: String(c.title || '').trim(),
                start: Number.isFinite(c.start)
                    ? c.start / (c.timeScale ?? 1)
                    : (c.sampleOffset && format.sampleRate ? c.sampleOffset / format.sampleRate : NaN),
            }))
            .filter((c) => Number.isFinite(c.start) && c.start >= 0 && (!duration || c.start < duration))
            .sort((a, b) => a.start - b.start);
        return {
            duration,
            chapters,
            title: common.title || null,
            author: common.albumartist || common.artist || null,
            picture: common.picture?.find((p) => PICTURE_EXT[p.format?.toLowerCase()]) || null,
        };
    } catch (err) {
        console.warn(`[audio] Could not read tags of ${path.basename(file)}: ${err.message}`);
        return { duration: 0, chapters: [], title: null, author: null, picture: null };
    }
}

/** Every book the folder holds right now, without reading any audio. */
function findBooks(audioDir) {
    const found = [];
    const add = (book) => found.push(book);

    const single = (dir, entries, file, series, seriesCover) => {
        const rel = path.relative(audioDir, path.join(dir, file.name));
        const title = cleanTitle(stem(file.name));
        const own = namedImage(entries, [stem(file.name), title]);
        add({
            kind: 'file', rel, series, title, filename: file.name,
            files: [file.name],
            base: dir,
            ownCover: own ? path.relative(audioDir, path.join(dir, own)) : null,
            seriesCover,
        });
    };

    const folder = (seriesDir, seriesEntries, sub, series, seriesCover) => {
        const dir = path.join(seriesDir, sub.name);
        const entries = listDir(dir);
        const files = entries.filter((e) => e.isFile() && isAudio(e.name)).map((e) => e.name);
        if (!files.length) return;
        const title = cleanTitle(sub.name);
        const inside = folderCover(entries);
        const beside = namedImage(seriesEntries, [sub.name, title]);
        add({
            kind: 'folder', rel: path.relative(audioDir, dir), series, title, filename: sub.name,
            files,
            base: dir,
            ownCover: inside ? path.relative(audioDir, path.join(dir, inside))
                : beside ? path.relative(audioDir, path.join(seriesDir, beside)) : null,
            seriesCover,
        });
    };

    const rootEntries = listDir(audioDir);
    for (const entry of rootEntries) {
        if (entry.isFile() && isAudio(entry.name)) {
            single(audioDir, rootEntries, entry, 'Uncategorized', null);
        } else if (entry.isDirectory()) {
            const seriesDir = path.join(audioDir, entry.name);
            const entries = listDir(seriesDir);
            const cover = folderCover(entries);
            const seriesCover = cover ? path.relative(audioDir, path.join(seriesDir, cover)) : null;
            for (const e of entries) {
                if (e.isFile() && isAudio(e.name)) single(seriesDir, entries, e, entry.name, seriesCover);
                else if (e.isDirectory()) folder(seriesDir, entries, e, entry.name, seriesCover);
            }
        }
    }
    return found;
}

/** Same idea as the epub hash: cheap, and the same after a rename. */
function bookHash(book) {
    if (book.kind === 'file') return computeFileHash(path.join(book.base, book.files[0]));
    const h = crypto.createHash('sha256');
    for (const f of book.files) h.update(`${f}\0${fs.statSync(path.join(book.base, f)).size}\n`);
    return h.digest('hex');
}

const bookSize = (book) => book.files.reduce((n, f) => n + fs.statSync(path.join(book.base, f)).size, 0);

/** Where a stored book's tracks are on disk. */
export function trackDir(row) {
    return row.kind === 'folder' ? row.filepath : path.dirname(row.filepath);
}

/**
 * The audiobook catalog: scans on start, on request, and when the list is
 * asked for and the last scan is older than `maxAgeMs`, so books dropped in
 * the folder show up without anyone pressing anything.
 */
export function createAudioLibrary(db, audioDir, coversDir) {
    let running = null;
    let lastScan = 0;

    const removeEmbedded = (name) => {
        if (!name) return;
        try { fs.unlinkSync(path.join(coversDir, path.basename(name))); } catch { /* gone already */ }
    };

    const saveEmbedded = (id, picture) => {
        if (!picture) return null;
        try {
            fs.mkdirSync(coversDir, { recursive: true });
            const name = id + PICTURE_EXT[picture.format.toLowerCase()];
            fs.writeFileSync(path.join(coversDir, name), picture.data);
            return name;
        } catch (err) {
            console.warn(`[audio] Could not save a cover: ${err.message}`);
            return null;
        }
    };

    /** Read every track: durations, chapters (in book time), tags. */
    const read = async (book) => {
        const tracks = [];
        const chapters = [];
        let start = 0;
        let first = null;
        for (const file of book.files) {
            const p = await probe(path.join(book.base, file));
            first ??= p;
            tracks.push({ file, start, duration: p.duration });
            if (p.chapters.length) {
                for (const c of p.chapters) {
                    chapters.push({ title: c.title || `Chapter ${chapters.length + 1}`, start: start + c.start });
                }
            } else if (book.files.length > 1) {
                chapters.push({ title: p.title || cleanTitle(stem(file)), start });
            }
            start += p.duration;
        }
        return { tracks, chapters, duration: start, author: first?.author || 'Unknown Author', picture: first?.picture };
    };

    const scanNow = async () => {
        if (!audioDir || !fs.existsSync(audioDir)) return 0;

        const existing = db.prepare('SELECT * FROM audiobooks').all();
        const byPath = new Map(existing.map((b) => [b.filepath, b]));
        const byHash = new Map();
        for (const b of existing) {
            if (!b.file_hash) continue;
            if (!byHash.has(b.file_hash)) byHash.set(b.file_hash, []);
            byHash.get(b.file_hash).push(b);
        }
        const seen = new Set();
        const found = findBooks(audioDir);
        for (const b of found) seen.add(b.rel);

        // A book that moved: same content, old path gone, nobody else took it.
        const claimMoved = (hash) => {
            const moved = (byHash.get(hash) || []).filter((c) => !seen.has(c.filepath) && byPath.has(c.filepath));
            if (moved.length !== 1) return null;
            byPath.delete(moved[0].filepath);
            return moved[0];
        };

        const update = db.prepare(`
            UPDATE audiobooks SET title = @title, author = @author, series = @series, kind = @kind,
                filename = @filename, filepath = @filepath, cover_path = @cover_path,
                embedded_cover = @embedded_cover, duration = @duration, tracks = @tracks,
                chapters = @chapters, file_hash = @file_hash, file_size = @file_size,
                updated_at = datetime('now')
            WHERE id = @id`);
        const insert = db.prepare(`
            INSERT INTO audiobooks (id, title, author, series, kind, filename, filepath, cover_path,
                embedded_cover, duration, tracks, chapters, file_hash, file_size)
            VALUES (@id, @title, @author, @series, @kind, @filename, @filepath, @cover_path,
                @embedded_cover, @duration, @tracks, @chapters, @file_hash, @file_size)`);

        let count = 0;
        for (const book of found) {
            try {
                const hash = bookHash(book);
                const stored = byPath.get(book.rel) || claimMoved(hash);
                const row = {
                    id: stored?.id || uuidv4(),
                    title: book.title,
                    series: book.series,
                    kind: book.kind,
                    filename: book.filename,
                    filepath: book.rel,
                    file_hash: hash,
                    file_size: bookSize(book),
                };

                if (stored && stored.file_hash === hash) {
                    // Unchanged audio: keep what was read, follow the name.
                    const tracks = JSON.parse(stored.tracks || '[]');
                    if (book.kind === 'file' && tracks[0]) tracks[0].file = book.files[0];
                    Object.assign(row, {
                        author: stored.author,
                        duration: stored.duration,
                        tracks: JSON.stringify(tracks),
                        chapters: stored.chapters,
                        embedded_cover: stored.embedded_cover,
                    });
                } else {
                    const info = await read(book);
                    removeEmbedded(stored?.embedded_cover);
                    Object.assign(row, {
                        author: info.author,
                        duration: info.duration,
                        tracks: JSON.stringify(info.tracks),
                        chapters: JSON.stringify(info.chapters),
                        embedded_cover: saveEmbedded(row.id, info.picture),
                    });
                }
                // Its own image, else the one inside the file, else the series'.
                row.cover_path = book.ownCover || (row.embedded_cover ? null : book.seriesCover);

                const changed = !stored || ['title', 'author', 'series', 'kind', 'filename', 'filepath',
                    'cover_path', 'embedded_cover', 'duration', 'tracks', 'chapters', 'file_hash', 'file_size']
                    .some((k) => stored[k] !== row[k]);
                if (!stored) insert.run(row);
                else if (changed) update.run(row);
                byPath.delete(book.rel);
                count++;
            } catch (err) {
                console.warn(`[audio] Skipped ${book.rel}: ${err.message}`);
                // Not "gone": a book that failed to read keeps its row and progress.
                byPath.delete(book.rel);
            }
        }

        // Same floor as the epub scanner: an empty folder is what a missing
        // mount looks like, and listening positions can't be rebuilt.
        if (found.length === 0 && byPath.size > 0) {
            console.warn(`[audio] Found no audiobooks in ${audioDir} but the database holds ${byPath.size}. ` +
                'Not removing them: the audio folder is probably not mounted.');
            return count;
        }
        for (const [, gone] of byPath) {
            db.prepare('DELETE FROM audiobooks WHERE id = ?').run(gone.id);
            db.prepare('DELETE FROM audio_progress WHERE audiobook_id = ?').run(gone.id);
            removeEmbedded(gone.embedded_cover);
        }
        return count;
    };

    const scan = () => {
        running ??= scanNow().finally(() => {
            running = null;
            lastScan = Date.now();
        });
        return running;
    };

    return {
        audioDir,
        coversDir,
        scan,
        scanIfStale: (maxAgeMs) => (running || Date.now() - lastScan > maxAgeMs ? scan() : Promise.resolve()),
    };
}

/**
 * Store a listening position. The most recent listen wins (device time), so
 * a phone that was offline on the train doesn't get overwritten by an older
 * position from the PC, and going back to an earlier chapter sticks.
 */
export function saveAudioProgress(db, userId, audiobookId, { position, finished, updated_at }) {
    const book = db.prepare('SELECT duration FROM audiobooks WHERE id = ?').get(audiobookId);
    if (!book) return null;
    let pos = Number(position);
    if (!Number.isFinite(pos) || pos < 0) pos = 0;
    if (book.duration > 0) pos = Math.min(pos, book.duration);

    db.prepare(`
        INSERT INTO audio_progress (user_id, audiobook_id, position, finished, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id, audiobook_id) DO UPDATE SET
            position = excluded.position,
            finished = excluded.finished,
            updated_at = excluded.updated_at
        WHERE excluded.updated_at > COALESCE(audio_progress.updated_at, '')
    `).run(userId, audiobookId, pos, finished ? 1 : 0, isoTime(updated_at) ?? new Date().toISOString());

    return db.prepare('SELECT * FROM audio_progress WHERE user_id = ? AND audiobook_id = ?').get(userId, audiobookId);
}
