import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { resolveInside } from '../paths.js';
import { AUDIO_TYPES, IMAGE_TYPES, naturalCompare, saveAudioProgress, trackDir } from '../audiobooks.js';

// New books in the folder show up the next time the list is opened, at most
// this long after the last look.
const RESCAN_AFTER_MS = 5 * 60 * 1000;

const progressOf = (row) => (row ? {
    position: row.position ?? 0,
    finished: !!row.finished,
    updated_at: row.updated_at || null,
} : null);

/** The signed-in user's audiobooks: the catalog, streaming, and positions. */
export function audiobooksRouter(db, library) {
    const router = Router();
    const { audioDir, coversDir } = library;

    const find = (id) => db.prepare('SELECT * FROM audiobooks WHERE id = ?').get(id);
    const progress = (userId, id) => db.prepare(
        'SELECT * FROM audio_progress WHERE user_id = ? AND audiobook_id = ?'
    ).get(userId, id);

    /**
     * GET /api/audiobooks
     * Every audiobook with this user's position, without tracks or chapters.
     */
    router.get('/', async (req, res) => {
        try {
            await library.scanIfStale(RESCAN_AFTER_MS);
            const rows = db.prepare(`
                SELECT a.id, a.title, a.author, a.series, a.filename, a.duration, a.chapters, a.updated_at,
                       (a.cover_path IS NOT NULL OR a.embedded_cover IS NOT NULL) AS has_cover,
                       ap.position, ap.finished, ap.updated_at AS progress_updated_at
                FROM audiobooks a
                LEFT JOIN audio_progress ap ON ap.audiobook_id = a.id AND ap.user_id = ?
            `).all(req.user.id);

            const list = rows.map(({ chapters, position, finished, progress_updated_at, has_cover, ...book }) => ({
                ...book,
                has_cover: !!has_cover,
                chapter_count: JSON.parse(chapters || '[]').length,
                progress: progress_updated_at ? progressOf({ position, finished, updated_at: progress_updated_at }) : null,
            }));
            // "Book 2" before "Book 10", the way the folder shows them.
            list.sort((a, b) => naturalCompare(a.series, b.series) || naturalCompare(a.filename, b.filename));
            res.json(list);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /**
     * POST /api/audiobooks/rescan
     * Look at the audio folder again now.
     */
    router.post('/rescan', async (req, res) => {
        try {
            const count = await library.scan();
            res.json({ success: true, audiobook_count: count });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /**
     * GET /api/audiobooks/:id
     * One audiobook with its tracks, chapters and this user's position.
     */
    router.get('/:id', (req, res) => {
        try {
            const book = find(req.params.id);
            if (!book) return res.status(404).json({ error: 'Audiobook not found' });
            const tracks = JSON.parse(book.tracks || '[]');
            res.json({
                id: book.id,
                title: book.title,
                author: book.author,
                series: book.series,
                duration: book.duration,
                updated_at: book.updated_at,
                has_cover: !!(book.cover_path || book.embedded_cover),
                // No paths: the app asks for track n, the server knows where it is.
                tracks: tracks.map((t, index) => ({
                    index,
                    start: t.start,
                    duration: t.duration,
                    type: AUDIO_TYPES[path.extname(t.file).toLowerCase()],
                })),
                chapters: JSON.parse(book.chapters || '[]'),
                progress: progressOf(progress(req.user.id, book.id)),
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /**
     * GET /api/audiobooks/:id/cover
     */
    router.get('/:id/cover', (req, res) => {
        try {
            const book = find(req.params.id);
            if (!book) return res.status(404).json({ error: 'Audiobook not found' });

            const candidates = [];
            if (book.cover_path) candidates.push(resolveInside(audioDir, book.cover_path));
            if (book.embedded_cover) candidates.push(resolveInside(coversDir, path.basename(book.embedded_cover)));
            const file = candidates.find((f) => IMAGE_TYPES[path.extname(f).toLowerCase()] && fs.existsSync(f));
            if (!file) return res.status(404).json({ error: 'No cover image available' });

            res.setHeader('Content-Type', IMAGE_TYPES[path.extname(file).toLowerCase()]);
            res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
            // The app asks with ?v=<updated_at>, so a new cover is a new URL.
            res.setHeader('Cache-Control', 'private, max-age=604800');
            res.sendFile(file, { dotfiles: 'allow' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /**
     * GET /api/audiobooks/:id/tracks/:n
     * The audio itself, with Range support so the player can seek.
     */
    router.get('/:id/tracks/:n', (req, res) => {
        try {
            const book = find(req.params.id);
            if (!book) return res.status(404).json({ error: 'Audiobook not found' });
            const track = JSON.parse(book.tracks || '[]')[Number(req.params.n)];
            if (!track) return res.status(404).json({ error: 'Track not found' });

            const file = resolveInside(audioDir, trackDir(book), track.file);
            const type = AUDIO_TYPES[path.extname(file).toLowerCase()];
            if (!type || !fs.existsSync(file)) return res.status(404).json({ error: 'File not found on disk' });

            res.setHeader('Content-Type', type);
            res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
            res.setHeader('Cache-Control', 'private, no-cache');
            // Paths were checked above; dot segments in folder names are fine.
            res.sendFile(file, { dotfiles: 'allow' }, (err) => {
                // A player that seeks drops its old request: not an error.
                if (err && !res.headersSent && err.code !== 'ECONNABORTED') {
                    res.status(err.status || 500).json({ error: 'Could not send the file' });
                }
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /**
     * PUT /api/audiobooks/:id/progress
     * Body: { position (seconds), finished, updated_at (when, device time) }.
     * Older than what the server has: ignored. Answers with what is stored.
     */
    router.put('/:id/progress', (req, res) => {
        try {
            const row = saveAudioProgress(db, req.user.id, req.params.id, req.body || {});
            if (!row) return res.status(404).json({ error: 'Audiobook not found' });
            res.json(progressOf(row));
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    return router;
}
