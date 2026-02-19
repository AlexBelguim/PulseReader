import express from 'express';
import cors from 'cors';
import { initDB } from './db.js';
import { booksRouter } from './routes/books.js';
import { progressRouter } from './routes/progress.js';
import { syncRouter } from './routes/sync.js';
import { authMiddleware } from './middleware/auth.js';
import { scanBooksFolder } from './scanner.js';
import fs from 'fs';
import path from 'path';

const app = express();
const PORT = process.env.PORT || 3000;
const BOOKS_DIR = process.env.BOOKS_DIR || './data/books';
const API_KEY = process.env.API_KEY || '';

// Ensure data directories exist
const dataDir = process.env.DATA_DIR || './data';
fs.mkdirSync(path.join(dataDir, 'books'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'db'), { recursive: true });

// Initialize database
const db = initDB(path.join(dataDir, 'db', 'pulsereader.db'));

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
}));
app.use(express.json({ limit: '100mb' }));

// Auth middleware (skip for health check)
if (API_KEY) {
    app.use('/api', authMiddleware(API_KEY));
}

// Routes
app.use('/api/books', booksRouter(db, BOOKS_DIR));
app.use('/api/progress', progressRouter(db));
app.use('/api/sync', syncRouter(db, BOOKS_DIR));

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', version: '1.0.0' });
});

// Scan books folder on startup
console.log(`Scanning books folder: ${BOOKS_DIR}`);
scanBooksFolder(db, BOOKS_DIR).then((count) => {
    console.log(`Found ${count} books in library`);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`PulseReader Sync Server running on port ${PORT}`);
    console.log(`Books directory: ${path.resolve(BOOKS_DIR)}`);
    if (API_KEY) {
        console.log('API key authentication enabled');
    } else {
        console.log('WARNING: No API_KEY set - server is unprotected!');
    }
});
