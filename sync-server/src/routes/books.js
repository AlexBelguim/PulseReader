import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { computeFileHash } from '../scanner.js';
import { safeSegment, resolveInside } from '../paths.js';
import { requireAdmin } from '../middleware/auth.js';

// Covers are served from this origin, so only real image types are accepted
// and each is served as exactly that type. An uploaded "cover.html" or
// "cover.svg" used to be stored and served as HTML/SVG, which runs script in
// the app's origin: a reader account could plant one and use an admin's
// session when the admin opened it. (Same list as the scanner's covers.)
const COVER_TYPES = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
};

// Files from the library are data, never pages: no MIME sniffing, and if one
// is ever opened directly it renders in a sandbox with nothing allowed.
const serveAsData = (res, contentType) => {
    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; sandbox");
};

export function booksRouter(db, booksDir) {
    const router = Router();

    // Configure multer for epub uploads
    const upload = multer({
        storage: multer.diskStorage({
            destination: (req, file, cb) => {
                const seriesDir = resolveInside(booksDir, safeSegment(req.body.series));
                fs.mkdirSync(seriesDir, { recursive: true });
                cb(null, seriesDir);
            },
            filename: (req, file, cb) => {
                const ext = path.extname(file.originalname).toLowerCase();
                cb(null, safeSegment(path.basename(file.originalname, ext), 'book') + ext);
            },
        }),
        limits: { fileSize: 200 * 1024 * 1024 }, // 200MB max
        fileFilter: (req, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase();
            if (file.fieldname === 'epub' && ext !== '.epub') {
                cb(new Error('Only .epub files are allowed'));
                return;
            }
            if (file.fieldname === 'cover' && !COVER_TYPES[ext]) {
                cb(new Error('Cover must be .jpg, .png or .webp'));
                return;
            }
            if (file.fieldname !== 'epub' && file.fieldname !== 'cover') {
                cb(new Error(`Unexpected file field "${file.fieldname}"`));
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
                LEFT JOIN reading_progress rp ON b.id = rp.book_id AND rp.user_id = ?
                ORDER BY b.series, b.title
            `).all(req.user.id);

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
                LEFT JOIN reading_progress rp ON b.id = rp.book_id AND rp.user_id = ?
                WHERE b.id = ?
            `).get(req.user.id, req.params.id);

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

            const filePath = resolveInside(booksDir, book.filepath);
            if (!fs.existsSync(filePath)) {
                return res.status(404).json({ error: 'File not found on disk' });
            }

            serveAsData(res, 'application/epub+zip');
            res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(book.filename)}`);
            res.sendFile(filePath);
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

            const type = book.cover_path && COVER_TYPES[path.extname(book.cover_path).toLowerCase()];
            if (type) {
                const coverPath = resolveInside(booksDir, book.cover_path);
                if (fs.existsSync(coverPath)) {
                    serveAsData(res, type);
                    return res.sendFile(coverPath);
                }
            }

            // No custom cover available
            res.status(404).json({ error: 'No cover image available' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /**
     * PUT /api/books/series/rename
     * Rename a series — updates all books in the series and moves files on disk
     */
    router.put('/series/rename', requireAdmin, (req, res) => {
        try {
            const { oldName } = req.body;
            if (!oldName || !req.body.newName) {
                return res.status(400).json({ error: 'Both oldName and newName are required' });
            }
            // The folder name is the series name (the scanner reads it back
            // from disk), so store exactly what the folder will be called.
            const newName = safeSegment(req.body.newName);

            const booksInSeries = db.prepare('SELECT * FROM books WHERE series = ?').all(oldName);
            if (booksInSeries.length === 0) {
                return res.status(404).json({ error: `No books found in series "${oldName}"` });
            }

            const newDir = resolveInside(booksDir, newName);
            // Books in the root of the books folder are "Uncategorized" but
            // have no folder of their own, so they're moved one by one.
            const oldDir = path.dirname(resolveInside(booksDir, booksInSeries[0].filepath));
            const isSeriesFolder = oldDir !== path.resolve(booksDir)
                && booksInSeries.every((b) => path.dirname(resolveInside(booksDir, b.filepath)) === oldDir);

            const relocate = db.prepare(`
                UPDATE books SET series = ?, filepath = ?, cover_path = ?, updated_at = datetime('now') WHERE id = ?
            `);
            const moveInDb = (book, fromDir) => {
                const rebase = (rel) => {
                    if (!rel) return rel;
                    const abs = resolveInside(booksDir, rel);
                    return path.dirname(abs) === fromDir
                        ? path.relative(booksDir, path.join(newDir, path.basename(abs)))
                        : rel;
                };
                relocate.run(newName, rebase(book.filepath), rebase(book.cover_path), book.id);
            };

            if (isSeriesFolder && fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
                // Rename the whole folder: keeps cover.jpg and anything else in
                // it together, and is a single atomic move on the same disk.
                fs.renameSync(oldDir, newDir);
                db.transaction(() => booksInSeries.forEach((b) => moveInDb(b, oldDir)))();
            } else {
                // Merging into an existing series (or out of the root): move
                // each book and its own cover.
                fs.mkdirSync(newDir, { recursive: true });
                for (const book of booksInSeries) {
                    const from = resolveInside(booksDir, book.filepath);
                    const fromDir = path.dirname(from);
                    const to = path.join(newDir, path.basename(from));
                    if (fs.existsSync(to) && to !== from) {
                        throw new Error(`"${path.basename(from)}" already exists in "${newName}"`);
                    }
                    if (fs.existsSync(from)) fs.renameSync(from, to);
                    if (book.cover_path) {
                        const cover = resolveInside(booksDir, book.cover_path);
                        const coverTo = path.join(newDir, path.basename(cover));
                        if (path.dirname(cover) === fromDir && fs.existsSync(cover) && !fs.existsSync(coverTo)) {
                            fs.renameSync(cover, coverTo);
                        }
                    }
                    moveInDb(book, fromDir);
                }
                try {
                    if (isSeriesFolder && fs.readdirSync(oldDir).length === 0) fs.rmdirSync(oldDir);
                } catch { /* ignore */ }
            }

            res.json({ success: true, updated: booksInSeries.length, series: newName });
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
            // Same name as the folder multer wrote into, so a rescan agrees with it.
            const series = safeSegment(req.body.series);
            const id = uuidv4();

            const relativePath = path.relative(booksDir, epubFile.path);
            let coverPath = null;

            if (req.files?.cover?.[0]) {
                coverPath = path.relative(booksDir, req.files.cover[0].path);
            }

            // Hash at upload time so the row can be recognised again if the
            // file is later renamed on disk. Rows inserted without one are
            // invisible to the scanner's rename matching until a scan
            // backfills the hash, and a rename inside that window still costs
            // the reader their progress.
            let fileHash = null;
            try {
                fileHash = computeFileHash(epubFile.path);
            } catch {
                // Not worth failing an otherwise good upload over; the next
                // scan fills it in.
            }

            db.prepare(`
                INSERT INTO books (id, title, author, series, filename, filepath, cover_path, file_size, file_hash)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(id, title, author, series, epubFile.filename, relativePath, coverPath, epubFile.size, fileHash);

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
    router.put('/:id', requireAdmin, (req, res) => {
        try {
            const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
            if (!book) {
                return res.status(404).json({ error: 'Book not found' });
            }

            const { title, author } = req.body;
            const series = req.body.series ? safeSegment(req.body.series) : null;
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
                const oldPath = resolveInside(booksDir, book.filepath);
                const newDir = resolveInside(booksDir, series);
                const newPath = path.join(newDir, path.basename(oldPath));
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
            // Next to the epub, named after it, so the scanner picks it up as
            // that book's own cover.
            const ext = (path.extname(req.file.originalname) || '.jpg').toLowerCase();
            if (!COVER_TYPES[ext]) {
                try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
                return res.status(400).json({ error: 'Cover must be .jpg, .png or .webp' });
            }
            const epubPath = resolveInside(booksDir, book.filepath);
            const coverDir = path.dirname(epubPath);
            const coverFullPath = path.join(coverDir, path.basename(epubPath, path.extname(epubPath)) + ext);

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
    router.delete('/:id', requireAdmin, (req, res) => {
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
                const filePath = resolveInside(booksDir, book.filepath);
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
