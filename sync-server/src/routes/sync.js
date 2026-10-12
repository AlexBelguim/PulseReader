import { Router } from 'express';
import { scanBooksFolder } from '../scanner.js';
import { applyProgressUpdates } from '../progressMerge.js';

export function syncRouter(db, booksDir) {
    const router = Router();

    /**
     * GET /api/sync/status
     * Get sync status - returns all books with their hashes and progress
     * for the client to compare against its local state.
     */
    router.get('/status', (req, res) => {
        try {
            const books = db.prepare(`
                SELECT b.id, b.title, b.author, b.series, b.filename, b.filepath,
                       b.file_hash, b.file_size, b.cover_path, b.added_at, b.updated_at,
                       rp.location as last_read, rp.progress, rp.is_read, rp.updated_at as progress_updated_at,
                       rp.read_updated_at
                FROM books b
                LEFT JOIN reading_progress rp ON b.id = rp.book_id AND rp.user_id = ?
                ORDER BY b.series, b.title
            `).all(req.user.id);

            res.json({
                books,
                server_time: new Date().toISOString(),
                book_count: books.length,
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /**
     * POST /api/sync/rescan
     * Trigger a rescan of the books folder
     */
    router.post('/rescan', async (req, res) => {
        try {
            const count = await scanBooksFolder(db, booksDir);
            res.json({ success: true, book_count: count });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /**
     * POST /api/sync/progress
     * Batch update reading progress from a device.
     * Body: { progress: [{ book_id, location, progress, is_read, updated_at,
     *                      read_updated_at, read_state_only }], force }
     *
     * The more recent side wins, per book, for the position and the read flag
     * separately (see progressMerge.js); force is Push: take the device's.
     */
    router.post('/progress', (req, res) => {
        try {
            const { progress: progressUpdates, force } = req.body;
            if (!Array.isArray(progressUpdates)) {
                return res.status(400).json({ error: 'Expected progress array' });
            }

            applyProgressUpdates(db, req.user.id, progressUpdates, { force: !!force });

            // Return current state
            const currentProgress = db.prepare(`
                SELECT * FROM reading_progress WHERE user_id = ? ORDER BY updated_at DESC
            `).all(req.user.id);

            res.json({ success: true, progress: currentProgress });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    return router;
}
