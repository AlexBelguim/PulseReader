import { Router } from 'express';
import { scanBooksFolder } from '../scanner.js';

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
                       rp.location as last_read, rp.progress, rp.updated_at as progress_updated_at
                FROM books b
                LEFT JOIN reading_progress rp ON b.id = rp.book_id
                ORDER BY b.series, b.title
            `).all();

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
     * Batch update reading progress from client.
     * Body: { progress: [{ book_id, location, progress, updated_at }] }
     * 
     * Uses last-write-wins conflict resolution based on updated_at timestamps.
     */
    router.post('/progress', (req, res) => {
        try {
            const { progress: progressUpdates } = req.body;
            if (!Array.isArray(progressUpdates)) {
                return res.status(400).json({ error: 'Expected progress array' });
            }

            const upsert = db.prepare(`
                INSERT INTO reading_progress (book_id, location, progress, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(book_id) DO UPDATE SET
                    location = CASE 
                        WHEN excluded.updated_at > reading_progress.updated_at THEN excluded.location
                        ELSE reading_progress.location
                    END,
                    progress = CASE
                        WHEN excluded.updated_at > reading_progress.updated_at THEN excluded.progress
                        ELSE reading_progress.progress
                    END,
                    updated_at = CASE
                        WHEN excluded.updated_at > reading_progress.updated_at THEN excluded.updated_at
                        ELSE reading_progress.updated_at
                    END
            `);

            const transaction = db.transaction((updates) => {
                for (const update of updates) {
                    upsert.run(
                        update.book_id,
                        update.location,
                        update.progress,
                        update.updated_at || new Date().toISOString()
                    );
                }
            });

            transaction(progressUpdates);

            // Return current state
            const currentProgress = db.prepare(`
                SELECT * FROM reading_progress ORDER BY updated_at DESC
            `).all();

            res.json({ success: true, progress: currentProgress });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    return router;
}
