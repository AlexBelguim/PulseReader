import { openDB } from 'idb';

const DB_NAME = 'pulse-reader-db';
const DB_VERSION = 4;

// One connection for the page's lifetime. Opening a fresh one per call made
// every page-turn save pay for two IndexedDB opens.
let dbPromise = null;

export const initDB = () => {
    if (dbPromise) return dbPromise;
    const opening = openDB(DB_NAME, DB_VERSION, {
        // Another tab wants to upgrade the schema: step aside so it can, and
        // reopen on next use.
        blocking() {
            opening.then((db) => db.close());
            dbPromise = null;
        },
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
    dbPromise = opening.catch((err) => {
        dbPromise = null;
        throw err;
    });
    return dbPromise;
};

// Progress writes are read-modify-write (merge onto what's stored), so two
// running at once could each read the old row and the later one would undo
// the earlier. They run one after another instead, and readers can wait for
// the queue so Back never shows the page before the last one.
let progressQueue = Promise.resolve();

const queueProgressWrite = (fn) => {
    const run = progressQueue.then(fn);
    progressQueue = run.catch(() => { /* keep the queue going */ });
    return run;
};

/** Resolves once every progress write queued so far has landed. */
export const whenProgressSaved = () => progressQueue;

/**
 * Ask the browser to keep this app's storage. Without it, storage is
 * "best effort": the browser may clear it when the device runs low on space
 * (and Safari clears sites unused for 7 days unless installed), which takes
 * the downloaded books with it. Chrome grants this quietly for installed or
 * often-used apps; Firefox asks once. Asked once per page load, and only
 * once there are books worth keeping.
 */
let persistRequested = false;
export const requestPersistentStorage = async () => {
    if (persistRequested) return;
    persistRequested = true;
    try {
        if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
            await navigator.storage.persist();
        }
    } catch { /* not supported */ }
};

export const addBook = async (bookData) => {
    requestPersistentStorage();
    const db = await initDB();
    const { progress, lastRead, isRead, progressAt, readAt, ...rest } = bookData;
    const id = await db.add('books', {
        ...rest,
        addedAt: new Date(),
    });
    // Seed the progress store if the incoming book carried any reading state
    // (e.g. downloaded from the sync server).
    if (progress || lastRead || isRead) {
        // The server's times come along (null when unknown), so a freshly
        // downloaded book never claims to have been read on this device.
        await saveProgress(id, {
            cfi: lastRead || null,
            percentage: progress || 0,
            isRead: isRead || false,
            updatedAt: progressAt ?? null,
            readAt: readAt ?? null,
        });
    }
    return id;
};

export const getBooks = async () => {
    await whenProgressSaved();
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
            // When the position / read flag last changed on this device;
            // sync compares these to keep the more recent side.
            progressAt: p.updatedAt ?? null,
            readAt: p.readAt ?? null,
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
    const { isRead, progress, lastRead, progressAt, readAt, ...bookUpdates } = updates;
    if (isRead !== undefined || progress !== undefined || lastRead !== undefined) {
        await saveProgress(id, {
            ...(isRead !== undefined ? { isRead } : {}),
            ...(progress !== undefined ? { percentage: progress } : {}),
            ...(lastRead !== undefined ? { cfi: lastRead } : {}),
            ...(progressAt !== undefined ? { updatedAt: progressAt } : {}),
            ...(readAt !== undefined ? { readAt } : {}),
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

export const saveProgress = (bookId, fields = {}) =>
    queueProgressWrite(() => writeProgress(bookId, fields));

const writeProgress = async (bookId, { cfi, percentage, isRead, updatedAt, readAt }) => {
    const db = await initDB();
    // Base on getProgress rather than a raw store read, so the pre-v4 fallback
    // (position still on the book record) is part of the merge. Reading only
    // the progress store meant marking a legacy book read wrote cfi:null over a
    // position that was sitting right there on the record.
    const existing = (await getProgress(bookId)) || { bookId };
    const now = new Date().toISOString();
    // The times sync compares (most recent wins). They move only when the
    // reader actually did something: the position changed, or the read flag
    // flipped. Backfilling a percentage once the page map is built, or
    // opening the book, must not make an old position look new. Callers that
    // copy state from the server pass the server's times explicitly.
    const movedPosition = cfi != null && cfi !== existing.cfi;
    const flippedRead = isRead !== undefined && isRead !== (existing.isRead ?? false);
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
        updatedAt: updatedAt !== undefined ? updatedAt : movedPosition ? now : existing.updatedAt ?? null,
        readAt: readAt !== undefined ? readAt : flippedRead ? now : existing.readAt ?? null,
    };
    await db.put('progress', next);
    return next;
};

export const updateBookProgress = async (id, location, progress, updatedAt) => {
    // Lightweight: writes only the small progress record, not the book blob.
    // updatedAt only when copying from the server; reading leaves it out.
    await saveProgress(id, {
        cfi: location,
        percentage: progress,
        ...(updatedAt !== undefined ? { updatedAt } : {}),
    });
};

export const toggleBookRead = async (id) => {
    await whenProgressSaved();
    const current = await getProgress(id);
    const newState = !(current?.isRead);
    await saveProgress(id, { isRead: newState });
    return newState;
};

/**
 * Forget every reading position on this device: used when a different
 * account signs in, so one person's progress never gets pushed into
 * another's. Writes explicit "unread, at the start" rows (rather than
 * clearing the store) so pre-v4 positions on the book records can't come
 * back through the getProgress fallback.
 */
export const resetAllProgress = () => queueProgressWrite(async () => {
    const db = await initDB();
    const ids = await db.getAllKeys('books');
    const tx = db.transaction('progress', 'readwrite');
    await Promise.all([
        ...ids.map((bookId) => tx.store.put({ bookId, cfi: null, percentage: 0, isRead: false, updatedAt: null, readAt: null })),
        tx.done,
    ]);
});

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
    // A queued progress write landing after the delete would recreate the row.
    await whenProgressSaved();
    const db = await initDB();
    await db.delete('books', id);
    // Best-effort cleanup of the auxiliary stores.
    try { await db.delete('progress', id); } catch { /* ignore */ }
    try { await db.delete('locations', id); } catch { /* ignore */ }
};
