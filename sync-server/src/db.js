import Database from 'better-sqlite3';
import { normalizeProgressTimes } from './progressMerge.js';

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

        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE COLLATE NOCASE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
            created_at TEXT DEFAULT (datetime('now'))
        );

        -- Only a hash of the session token is stored, so a copy of the
        -- database can't be used to sign in.
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            last_seen TEXT DEFAULT (datetime('now')),
            expires_at TEXT NOT NULL,
            user_agent TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_books_series ON books(series);
        CREATE INDEX IF NOT EXISTS idx_books_title ON books(title);
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    `);
    db.pragma('foreign_keys = ON');

    // Reading progress is per user. Before accounts existed it was one row per
    // book; that table is set aside here and handed to the first admin by
    // adoptLegacyProgress() once that admin exists.
    const progressCols = db.prepare('PRAGMA table_info(reading_progress)').all();
    if (progressCols.length && !progressCols.some((c) => c.name === 'user_id')) {
        if (!progressCols.some((c) => c.name === 'is_read')) {
            db.exec('ALTER TABLE reading_progress ADD COLUMN is_read INTEGER DEFAULT 0');
        }
        db.exec('ALTER TABLE reading_progress RENAME TO reading_progress_legacy');
        console.log('Migration: reading progress is now per user; existing progress goes to the admin');
    }
    db.exec(`
        CREATE TABLE IF NOT EXISTS reading_progress (
            user_id INTEGER NOT NULL,
            book_id TEXT NOT NULL,
            location TEXT,
            progress REAL DEFAULT 0,
            is_read INTEGER DEFAULT 0,
            updated_at TEXT,          -- when the position was read (device time)
            read_updated_at TEXT,     -- when is_read was last changed
            PRIMARY KEY (user_id, book_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
        );
    `);

    // Read-state got its own time when sync moved to "most recent wins".
    if (!db.prepare('PRAGMA table_info(reading_progress)').all().some((c) => c.name === 'read_updated_at')) {
        db.exec('ALTER TABLE reading_progress ADD COLUMN read_updated_at TEXT');
    }
    normalizeProgressTimes(db);

    return db;
}
