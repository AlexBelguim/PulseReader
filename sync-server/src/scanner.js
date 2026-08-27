import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

const COVER_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];
const EPUB_EXTENSION = '.epub';

/**
 * Compute a hash of a file for change detection.
 * Uses first 64KB + file size for speed.
 */
function computeFileHash(filepath) {
    const stat = fs.statSync(filepath);
    const fd = fs.openSync(filepath, 'r');
    const buffer = Buffer.alloc(Math.min(65536, stat.size));
    fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);

    return crypto
        .createHash('sha256')
        .update(buffer)
        .update(stat.size.toString())
        .digest('hex');
}

/**
 * Find a cover image in a directory.
 * Looks for files named "cover.*" or any image file.
 */
function findCoverImage(dirPath) {
    try {
        const files = fs.readdirSync(dirPath);

        // First, look for files explicitly named "cover"
        for (const file of files) {
            const ext = path.extname(file).toLowerCase();
            const name = path.basename(file, ext).toLowerCase();
            if (name === 'cover' && COVER_EXTENSIONS.includes(ext)) {
                return path.join(dirPath, file);
            }
        }

        // Then look for any image file
        for (const file of files) {
            const ext = path.extname(file).toLowerCase();
            if (COVER_EXTENSIONS.includes(ext)) {
                return path.join(dirPath, file);
            }
        }
    } catch (err) {
        // Directory might not exist
    }
    return null;
}

/**
 * Scan the books folder structure:
 *   books/
 *     SeriesName/
 *       cover.jpg          (optional series cover)
 *       Book Title.epub
 *       Book Title.jpg     (optional per-book cover)
 *     Uncategorized/
 *       Standalone Book.epub
 *
 * Also supports flat structure:
 *   books/
 *     Book Title.epub
 */
export async function scanBooksFolder(db, booksDir) {
    if (!fs.existsSync(booksDir)) {
        fs.mkdirSync(booksDir, { recursive: true });
        return 0;
    }

    const existingBooks = db.prepare('SELECT id, filepath, file_hash FROM books').all();
    const existingByPath = new Map(existingBooks.map((b) => [b.filepath, b]));
    const seenPaths = new Set();
    let count = 0;

    const entries = fs.readdirSync(booksDir, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(booksDir, entry.name);

        if (entry.isDirectory()) {
            // This is a series folder
            const seriesName = entry.name;
            const seriesCover = findCoverImage(fullPath);
            const seriesFiles = fs.readdirSync(fullPath, { withFileTypes: true });

            for (const file of seriesFiles) {
                if (!file.isFile()) continue;
                const ext = path.extname(file.name).toLowerCase();
                if (ext !== EPUB_EXTENSION) continue;

                const epubPath = path.join(fullPath, file.name);
                const relativePath = path.relative(booksDir, epubPath);
                seenPaths.add(relativePath);

                const title = path.basename(file.name, ext);
                const fileHash = computeFileHash(epubPath);
                const fileSize = fs.statSync(epubPath).size;

                // Check for per-book cover (same name as epub but image extension)
                let bookCover = null;
                for (const coverExt of COVER_EXTENSIONS) {
                    const coverPath = path.join(fullPath, title + coverExt);
                    if (fs.existsSync(coverPath)) {
                        bookCover = path.relative(booksDir, coverPath);
                        break;
                    }
                }
                // Fall back to series cover
                if (!bookCover && seriesCover) {
                    bookCover = path.relative(booksDir, seriesCover);
                }

                const existing = existingByPath.get(relativePath);
                if (existing) {
                    // Update if file changed
                    if (existing.file_hash !== fileHash) {
                        db.prepare(`
                            UPDATE books SET file_hash = ?, file_size = ?, cover_path = ?, 
                            series = ?, updated_at = datetime('now') WHERE id = ?
                        `).run(fileHash, fileSize, bookCover, seriesName, existing.id);
                    }
                } else {
                    // Insert new book
                    db.prepare(`
                        INSERT INTO books (id, title, author, series, filename, filepath, cover_path, file_hash, file_size)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `).run(uuidv4(), title, 'Unknown Author', seriesName, file.name, relativePath, bookCover, fileHash, fileSize);
                }
                count++;
            }
        } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === EPUB_EXTENSION) {
            // Flat epub in root books folder
            const relativePath = entry.name;
            seenPaths.add(relativePath);

            const title = path.basename(entry.name, EPUB_EXTENSION);
            const fileHash = computeFileHash(fullPath);
            const fileSize = fs.statSync(fullPath).size;

            // Check for cover image with same name
            let bookCover = null;
            for (const coverExt of COVER_EXTENSIONS) {
                const coverPath = path.join(booksDir, title + coverExt);
                if (fs.existsSync(coverPath)) {
                    bookCover = title + coverExt;
                    break;
                }
            }

            const existing = existingByPath.get(relativePath);
            if (existing) {
                if (existing.file_hash !== fileHash) {
                    db.prepare(`
                        UPDATE books SET file_hash = ?, file_size = ?, cover_path = ?,
                        updated_at = datetime('now') WHERE id = ?
                    `).run(fileHash, fileSize, bookCover, existing.id);
                }
            } else {
                db.prepare(`
                    INSERT INTO books (id, title, author, series, filename, filepath, cover_path, file_hash, file_size)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(uuidv4(), title, 'Unknown Author', 'Uncategorized', entry.name, relativePath, bookCover, fileHash, fileSize);
            }
            count++;
        }
    }

    // Remove books that no longer exist on disk.
    //
    // Guarded, because "the scan saw nothing" is not the same as "the user
    // deleted their library". The early return above only fires when booksDir
    // does not exist, and an existing-but-empty directory is exactly what a
    // failed bind mount looks like -- so without this floor one boot scan
    // against an unmounted volume deletes every row, and reading_progress with
    // it. Books can be recovered by rescanning; reading positions cannot be
    // recovered from anything.
    if (seenPaths.size === 0 && existingByPath.size > 0) {
        console.warn(
            `[scanner] Found 0 books in ${booksDir} but the database holds ${existingByPath.size}. ` +
            'Refusing to reconcile -- this usually means the books volume is not mounted. ' +
            'No rows were deleted.'
        );
        return count;
    }

    for (const [filepath, book] of existingByPath) {
        if (!seenPaths.has(filepath)) {
            // Progress goes with the book, matching the ON DELETE CASCADE the
            // schema declares. (That cascade does not actually fire -- SQLite
            // leaves foreign_keys off unless asked -- so this delete is what
            // enforces it.) Keeping the row instead would not help: a file that
            // comes back is re-inserted under a fresh uuid, so the old progress
            // could never be re-linked to it. The floor above is what protects
            // the library; this branch is for a single genuinely deleted book.
            db.prepare('DELETE FROM books WHERE id = ?').run(book.id);
            db.prepare('DELETE FROM reading_progress WHERE book_id = ?').run(book.id);
        }
    }

    return count;
}
