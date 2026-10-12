import { Router } from 'express';

/** The signed-in user's reading progress. */
export function progressRouter(db) {
    const router = Router();

    /**
     * GET /api/progress
     * Get reading progress for all books
     */
    router.get('/', (req, res) => {
        try {
            const progress = db.prepare(`
                SELECT rp.*, b.title
                FROM reading_progress rp
                JOIN books b ON rp.book_id = b.id
                WHERE rp.user_id = ?
                ORDER BY rp.updated_at DESC
            `).all(req.user.id);

            res.json(progress);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /**
     * GET /api/progress/:bookId
     * Get reading progress for a specific book
     */
    router.get('/:bookId', (req, res) => {
        try {
            const progress = db.prepare(
                'SELECT * FROM reading_progress WHERE user_id = ? AND book_id = ?'
            ).get(req.user.id, req.params.bookId);

            if (!progress) {
                return res.status(404).json({ error: 'No progress found for this book' });
            }
            res.json(progress);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /**
     * PUT /api/progress/:bookId
     * Update reading progress for a book
     */
    router.put('/:bookId', (req, res) => {
        try {
            const { location, progress } = req.body;
            const bookId = req.params.bookId;

            // Verify book exists
            const book = db.prepare('SELECT id FROM books WHERE id = ?').get(bookId);
            if (!book) {
                return res.status(404).json({ error: 'Book not found' });
            }

            db.prepare(`
                INSERT INTO reading_progress (user_id, book_id, location, progress, updated_at)
                VALUES (?, ?, ?, ?, datetime('now'))
                ON CONFLICT(user_id, book_id) DO UPDATE SET
                    location = excluded.location,
                    progress = excluded.progress,
                    updated_at = datetime('now')
            `).run(req.user.id, bookId, location, progress);

            const updated = db.prepare(
                'SELECT * FROM reading_progress WHERE user_id = ? AND book_id = ?'
            ).get(req.user.id, bookId);

            res.json(updated);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    return router;
}
