import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';

export function booksRouter(db, booksDir) {
    const router = Router();

    // Configure multer for epub uploads
    const upload = multer({
        storage: multer.diskStorage({
            destination: (req, file, cb) => {
                const series = req.body.series || 'Uncategorized';
                const seriesDir = path.join(booksDir, series);
                fs.mkdirSync(seriesDir, { recursive: true });
                cb(null, seriesDir);
            },
            filename: (req, file, cb) => {
                cb(null, file.originalname);
            },
        }),
        limits: { fileSize: 200 * 1024 * 1024 }, // 200MB max
        fileFilter: (req, file, cb) => {
            if (file.fieldname === 'epub' && !file.originalname.toLowerCase().endsWith('.epub')) {
                cb(new Error('Only .epub files are allowed'));
                return;
            }
            cb(null, true);
        },
    });

    /**
     * GET /api/books
     * List all books with metadata (no file data)
     */
    router.get('/', (req, res) => {
        try {
            const books = db.prepare(`
                SELECT b.*, rp.location as last_read, rp.progress, rp.updated_at as progress_updated_at
                FROM books b
                LEFT JOIN reading_progress rp ON b.id = rp.book_id
                ORDER BY b.series, b.title
            `).all();

            res.json(books);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /**
     * GET /api/books/:id
     * Get a single book's metadata
     */
    router.get('/:id', (req, res) => {
        try {
            const book = db.prepare(`
                SELECT b.*, rp.location as last_read, rp.progress
                FROM books b
                LEFT JOIN reading_progress rp ON b.id = rp.book_id
                WHERE b.id = ?
            `).get(req.params.id);

            if (!book) {
                return res.status(404).json({ error: 'Book not found' });
            }
            res.json(book);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /**
     * GET /api/books/:id/download
     * Download the epub file
     */
    router.get('/:id/download', (req, res) => {
        try {
            const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
            if (!book) {
                return res.status(404).json({ error: 'Book not found' });
            }

            const filePath = path.join(booksDir, book.filepath);
            if (!fs.existsSync(filePath)) {
                return res.status(404).json({ error: 'File not found on disk' });
            }

            res.setHeader('Content-Type', 'application/epub+zip');
            res.setHeader('Content-Disposition', `attachment; filename="${book.filename}"`);
            res.sendFile(path.resolve(filePath));
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /**
     * GET /api/books/:id/cover
     * Get the cover image for a book.
     * Returns the custom cover if available, or 404.
     */
    router.get('/:id/cover', (req, res) => {
        try {
            const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
            if (!book) {
                return res.status(404).json({ error: 'Book not found' });
            }

            if (book.cover_path) {
                const coverPath = path.join(booksDir, book.cover_path);
                if (fs.existsSync(coverPath)) {
                    return res.sendFile(path.resolve(coverPath));
                }
            }

            // No custom cover available
            res.status(404).json({ error: 'No cover image available' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /**
     * POST /api/books
     * Upload a new book (epub + optional cover)
     */
    router.post('/', upload.fields([
        { name: 'epub', maxCount: 1 },
        { name: 'cover', maxCount: 1 },
    ]), (req, res) => {
        try {
            const epubFile = req.files?.epub?.[0];
            if (!epubFile) {
                return res.status(400).json({ error: 'No epub file provided' });
            }

            const title = req.body.title || path.basename(epubFile.originalname, '.epub');
            const author = req.body.author || 'Unknown Author';
            const series = req.body.series || 'Uncategorized';
            const id = uuidv4();

            const relativePath = path.relative(booksDir, epubFile.path);
            let coverPath = null;

            if (req.files?.cover?.[0]) {
                coverPath = path.relative(booksDir, req.files.cover[0].path);
            }

            db.prepare(`
                INSERT INTO books (id, title, author, series, filename, filepath, cover_path, file_size)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(id, title, author, series, epubFile.originalname, relativePath, coverPath, epubFile.size);

            const book = db.prepare('SELECT * FROM books WHERE id = ?').get(id);
            res.status(201).json(book);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /**
     * PUT /api/books/:id
     * Update book metadata
     */
    router.put('/:id', (req, res) => {
        try {
            const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
            if (!book) {
                return res.status(404).json({ error: 'Book not found' });
            }

            const { title, author, series } = req.body;
            db.prepare(`
                UPDATE books SET 
                    title = COALESCE(?, title),
                    author = COALESCE(?, author),
                    series = COALESCE(?, series),
                    updated_at = datetime('now')
                WHERE id = ?
            `).run(title, author, series, req.params.id);

            // If series changed, move the file
            if (series && series !== book.series) {
                const oldPath = path.join(booksDir, book.filepath);
                const newDir = path.join(booksDir, series);
                const newPath = path.join(newDir, book.filename);
                fs.mkdirSync(newDir, { recursive: true });

                if (fs.existsSync(oldPath)) {
                    fs.renameSync(oldPath, newPath);
                    const newRelativePath = path.relative(booksDir, newPath);
                    db.prepare('UPDATE books SET filepath = ? WHERE id = ?').run(newRelativePath, req.params.id);
                }
            }

            const updated = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
            res.json(updated);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /**
     * PUT /api/books/:id/cover
     * Upload or replace a cover image for an existing book
     */
    router.put('/:id/cover', upload.single('cover'), (req, res) => {
        try {
            const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
            if (!book) {
                return res.status(404).json({ error: 'Book not found' });
            }

            if (!req.file) {
                return res.status(400).json({ error: 'No cover file provided' });
            }

            // Determine the target cover path: <series>/<title>.<ext>
            const series = book.series || 'Uncategorized';
            const ext = path.extname(req.file.originalname) || '.jpg';
            const coverFilename = path.basename(book.filename, '.epub') + ext;
            const coverDir = path.join(booksDir, series);
            const coverFullPath = path.join(coverDir, coverFilename);

            fs.mkdirSync(coverDir, { recursive: true });

            // Move the uploaded file to the correct location
            const uploadedPath = req.file.path;
            if (uploadedPath !== coverFullPath) {
                fs.copyFileSync(uploadedPath, coverFullPath);
                try { fs.unlinkSync(uploadedPath); } catch { /* ignore */ }
            }

            const coverRelativePath = path.relative(booksDir, coverFullPath);
            db.prepare('UPDATE books SET cover_path = ?, updated_at = datetime(\'now\') WHERE id = ?')
                .run(coverRelativePath, req.params.id);

            const updated = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
            res.json(updated);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /**
     * DELETE /api/books/:id
     * Delete a book (removes from DB, optionally from disk)
     */
    router.delete('/:id', (req, res) => {
        try {
            const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
            if (!book) {
                return res.status(404).json({ error: 'Book not found' });
            }

            // Remove from database
            db.prepare('DELETE FROM books WHERE id = ?').run(req.params.id);
            db.prepare('DELETE FROM reading_progress WHERE book_id = ?').run(req.params.id);

            // Optionally remove file from disk
            if (req.query.deleteFile === 'true') {
                const filePath = path.join(booksDir, book.filepath);
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
            }

            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    return router;
}
