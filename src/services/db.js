import { openDB } from 'idb';

const DB_NAME = 'pulse-reader-db';
const DB_VERSION = 2;

export const initDB = async () => {
    return openDB(DB_NAME, DB_VERSION, {
        upgrade(db, oldVersion, newVersion, transaction) {
            const store = db.objectStoreNames.contains('books')
                ? transaction.objectStore('books')
                : db.createObjectStore('books', { keyPath: 'id', autoIncrement: true });

            if (!store.indexNames.contains('title')) store.createIndex('title', 'title');
            if (!store.indexNames.contains('addedAt')) store.createIndex('addedAt', 'addedAt');
            if (!store.indexNames.contains('series')) store.createIndex('series', 'series');
        },
    });
};

export const addBook = async (bookData) => {
    const db = await initDB();
    return db.add('books', {
        ...bookData,
        addedAt: new Date(),
    });
};

export const getBooks = async () => {
    const db = await initDB();
    return db.getAllFromIndex('books', 'addedAt');
};

export const getBook = async (id) => {
    const db = await initDB();
    return db.get('books', id);
};

export const updateBookProgress = async (id, location, progress) => {
    const db = await initDB();
    const book = await db.get('books', id);
    if (book) {
        book.lastRead = location;
        book.progress = progress;
        await db.put('books', book);
    }
};

export const deleteBook = async (id) => {
    const db = await initDB();
    return db.delete('books', id);
};
