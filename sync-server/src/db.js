import Database from 'better-sqlite3';

export function initDB(dbPath) {
    const db = new Database(dbPath);

    // Enable WAL mode for better concurrent access
    db.pragma('journal_mode = WAL');

    // Create tables
    db.exec(`
        CREATE TABLE IF NOT EXISTS books (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            author TEXT DEFAULT 'Unknown Author',
            series TEXT DEFAULT 'Uncategorized',
            filename TEXT NOT NULL,
            filepath TEXT NOT NULL,
            cover_path TEXT,
            file_hash TEXT,
            file_size INTEGER DEFAULT 0,
            added_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS reading_progress (
            book_id TEXT PRIMARY KEY,
            location TEXT,
            progress REAL DEFAULT 0,
            updated_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_books_series ON books(series);
        CREATE INDEX IF NOT EXISTS idx_books_title ON books(title);
    `);

    return db;
}
