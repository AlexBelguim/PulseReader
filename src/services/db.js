import { openDB } from 'idb';

const DB_NAME = 'pulse-reader-db';
const DB_VERSION = 4;

export const initDB = async () => {
    return openDB(DB_NAME, DB_VERSION, {
        upgrade(db, oldVersion, newVersion, transaction) {
            const store = db.objectStoreNames.contains('books')
                ? transaction.objectStore('books')
                : db.createObjectStore('books', { keyPath: 'id', autoIncrement: true });

            if (!store.indexNames.contains('title')) store.createIndex('title', 'title');
            if (!store.indexNames.contains('addedAt')) store.createIndex('addedAt', 'addedAt');
            if (!store.indexNames.contains('series')) store.createIndex('series', 'series');
            if (!store.indexNames.contains('syncId')) store.createIndex('syncId', 'syncId', { unique: false });

            // v4: dedicated stores so per-page progress saves and cached
            // locations don't rewrite the multi-MB epub blob on the book record.
            if (!db.objectStoreNames.contains('progress')) {
                db.createObjectStore('progress', { keyPath: 'bookId' });
            }
            if (!db.objectStoreNames.contains('locations')) {
                db.createObjectStore('locations', { keyPath: 'bookId' });
            }
        },
    });
};

export const addBook = async (bookData) => {
    const db = await initDB();
    const { progress, lastRead, isRead, ...rest } = bookData;
    const id = await db.add('books', {
        ...rest,
        addedAt: new Date(),
    });
    // Seed the progress store if the incoming book carried any reading state
    // (e.g. downloaded from the sync server).
    if (progress || lastRead || isRead) {
        await saveProgress(id, {
            cfi: lastRead || null,
            percentage: progress || 0,
            isRead: isRead || false,
        });
    }
    return id;
};

export const getBooks = async () => {
    const db = await initDB();
    const [books, progressEntries] = await Promise.all([
        db.getAllFromIndex('books', 'addedAt'),
        db.getAll('progress'),
    ]);
    const pmap = new Map(progressEntries.map((p) => [p.bookId, p]));
    // Overlay the dedicated progress store onto each book for display + sync.
    // Books written before v4 keep their on-record fields as a fallback.
    return books.map((b) => {
        const p = pmap.get(b.id);
        if (!p) return b;
        return {
            ...b,
            progress: p.percentage ?? b.progress ?? 0,
            isRead: p.isRead ?? b.isRead ?? false,
            lastRead: p.cfi ?? b.lastRead ?? null,
        };
    });
};

export const getBook = async (id) => {
    const db = await initDB();
    return db.get('books', id);
};

export const updateBook = async (id, updates) => {
    const db = await initDB();

    // Route reading-state fields to the progress store so we never rewrite
    // the book blob just to flip a flag.
    const { isRead, progress, lastRead, ...bookUpdates } = updates;
    if (isRead !== undefined || progress !== undefined || lastRead !== undefined) {
        await saveProgress(id, {
            ...(isRead !== undefined ? { isRead } : {}),
            ...(progress !== undefined ? { percentage: progress } : {}),
            ...(lastRead !== undefined ? { cfi: lastRead } : {}),
        });
    }

    if (Object.keys(bookUpdates).length === 0) {
        return db.get('books', id);
    }

    const book = await db.get('books', id);
    if (book) {
        Object.assign(book, bookUpdates);
        await db.put('books', book);
    }
    return book;
};

// ---- Reading progress (separate store, keyed by local book id) ----

export const getProgress = async (bookId) => {
    const db = await initDB();
    const entry = await db.get('progress', bookId);
    if (entry) return entry;

    // Lazy fallback for books written before v4 (progress lived on the record).
    const book = await db.get('books', bookId);
    if (book && (book.lastRead || book.progress || book.isRead)) {
        return {
            bookId,
            cfi: book.lastRead || null,
            percentage: book.progress || 0,
            isRead: book.isRead || false,
            updatedAt: null,
        };
    }
    return null;
};

export const getAllProgress = async () => {
    const db = await initDB();
    const entries = await db.getAll('progress');
    const map = new Map();
    for (const e of entries) map.set(e.bookId, e);
    return map;
};

export const saveProgress = async (bookId, { cfi, percentage, isRead, updatedAt } = {}) => {
    const db = await initDB();
    // Base on getProgress rather than a raw store read, so the pre-v4 fallback
    // (position still on the book record) is part of the merge. Reading only
    // the progress store meant marking a legacy book read wrote cfi:null over a
    // position that was sitting right there on the record.
    const existing = (await getProgress(bookId)) || { bookId };
    const next = {
        bookId,
        // null is "no position to report", not "the user is at the start".
        // Callers pass it routinely -- a read-flag toggle, a sync pull of a row
        // whose location is NULL -- and storing it destroys a real CFI. There is
        // no caller that clears a position on purpose, so absence never wins
        // over a value we already have.
        cfi: cfi !== undefined && cfi !== null ? cfi : existing.cfi ?? null,
        percentage: percentage !== undefined ? percentage : existing.percentage ?? 0,
        isRead: isRead !== undefined ? isRead : existing.isRead ?? false,
        updatedAt: updatedAt || new Date().toISOString(),
    };
    await db.put('progress', next);
    return next;
};

export const updateBookProgress = async (id, location, progress) => {
    // Lightweight: writes only the small progress record, not the book blob.
    await saveProgress(id, { cfi: location, percentage: progress });
};

export const toggleBookRead = async (id) => {
    const current = await getProgress(id);
    const newState = !(current?.isRead);
    await saveProgress(id, { isRead: newState });
    return newState;
};

// ---- Cached epub.js locations (content-based, layout-independent) ----

export const getLocationsCache = async (bookId) => {
    const db = await initDB();
    return db.get('locations', bookId);
};

export const saveLocationsCache = async (bookId, { json, chars }) => {
    const db = await initDB();
    await db.put('locations', { bookId, json, chars, generatedAt: new Date().toISOString() });
};

export const deleteBook = async (id) => {
    const db = await initDB();
    await db.delete('books', id);
    // Best-effort cleanup of the auxiliary stores.
    try { await db.delete('progress', id); } catch { /* ignore */ }
    try { await db.delete('locations', id); } catch { /* ignore */ }
};
