import express from 'express';
import cors from 'cors';
import { initDB } from './db.js';
import { booksRouter } from './routes/books.js';
import { progressRouter } from './routes/progress.js';
import { syncRouter } from './routes/sync.js';
import { authMiddleware, authRouter, requireAdmin } from './middleware/auth.js';
import { usersRouter } from './routes/users.js';
import { bootstrapAdmin } from './users.js';
import { scanBooksFolder } from './scanner.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const VERSION = '1.0.0';
const app = express();
const PORT = process.env.PORT || 3000;
const BOOKS_DIR = process.env.BOOKS_DIR || './data/books';
const API_KEY = process.env.API_KEY || '';
// The built web app. In the Docker image it sits next to src/; in a checkout
// it is the repo's dist/ after `npm run build`.
const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = process.env.WEB_DIR
    || [path.join(here, '..', 'web'), path.join(here, '..', '..', 'dist')].find((d) => fs.existsSync(path.join(d, 'index.html')));

// Ensure data directories exist
const dataDir = process.env.DATA_DIR || './data';
fs.mkdirSync(BOOKS_DIR, { recursive: true });
fs.mkdirSync(path.join(dataDir, 'db'), { recursive: true });

// Initialize database
const db = initDB(path.join(dataDir, 'db', 'pulsereader.db'));

// Every book and reading position is behind a sign-in. The first admin comes
// from ADMIN_USERNAME / ADMIN_PASSWORD (or API_KEY, for setups from before
// there were accounts); after that, accounts live in the database.
try {
    if (!bootstrapAdmin(db, process.env)) {
        console.error('No users yet. Set ADMIN_PASSWORD (and optionally ADMIN_USERNAME, default "admin")');
        console.error('to create the first admin account, then restart.');
        process.exit(1);
    }
} catch (err) {
    console.error(`Could not create the first admin: ${err.message}`);
    process.exit(1);
}

// Behind a reverse proxy (Caddy, Traefik, Cloudflare Tunnel) on the LAN or in
// Docker: trust private hops only, so req.ip is the real client for the login
// throttle and req.secure is true over HTTPS for the Secure cookie flag.
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback, uniquelocal');

// The web app is served from this same origin, so CORS is only needed when a
// separately hosted copy talks to this server. Opt in with CORS_ORIGIN.
if (process.env.CORS_ORIGIN) {
    app.use(cors({
        origin: process.env.CORS_ORIGIN.split(',').map((o) => o.trim()),
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
    }));
}
app.use(express.json({ limit: '5mb' }));

// Baseline headers on everything: no MIME sniffing, no framing (clickjacking
// the admin panel), and no full URLs leaking to other sites.
app.disable('x-powered-by');
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
});

// Health check (unauthenticated; the web app uses it to find its server)
app.get('/health', (req, res) => {
    res.json({ status: 'ok', app: 'pulsereader', version: VERSION });
});

// Routes
app.use('/api/auth', authRouter(db, API_KEY));
app.use('/api', authMiddleware(db, API_KEY));
app.use('/api/users', requireAdmin, usersRouter(db));
app.use('/api/books', booksRouter(db, BOOKS_DIR));
app.use('/api/progress', progressRouter(db));
app.use('/api/sync', syncRouter(db, BOOKS_DIR));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Errors thrown before a route's own try/catch (a rejected upload, a body
// too large, malformed JSON) as JSON, without stack traces or file paths.
// eslint-disable-next-line no-unused-vars
app.use('/api', (err, req, res, next) => {
    const status = err.status || err.statusCode || (err.name === 'MulterError' || /allowed|must be|Unexpected file/.test(err.message) ? 400 : 500);
    if (status >= 500) console.error('API error:', err);
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
});

// The web app. Hashed assets never change under the same name, so cache them
// for a year; index.html, the service worker and the manifest must always be
// revalidated or a new build would never reach installed PWAs.
if (WEB_DIR) {
    app.use(express.static(WEB_DIR, {
        setHeaders: (res, filePath) => {
            const rel = path.relative(WEB_DIR, filePath).replace(/\\/g, '/');
            if (rel.startsWith('assets/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            else if (rel === 'sw.js' || rel.endsWith('.html') || rel.endsWith('.webmanifest')) res.setHeader('Cache-Control', 'no-cache');
            else res.setHeader('Cache-Control', 'public, max-age=86400');
        },
    }));
} else {
    app.get('/', (req, res) => {
        res.type('text/plain').send('PulseReader server is up, but the web app is not built.\nRun `npm run build` in the repo root, or use the Docker image.\n');
    });
}

// Scan books folder on startup
console.log(`Scanning books folder: ${BOOKS_DIR}`);
scanBooksFolder(db, BOOKS_DIR).then((count) => {
    console.log(`Found ${count} books in library`);
}).catch((err) => {
    console.error('Initial scan failed:', err.message);
});

app.listen(PORT, '0.0.0.0', (err) => {
    // Express 5 hands bind errors (port in use, no permission) to this
    // callback instead of throwing.
    if (err) {
        console.error(`Could not listen on port ${PORT}: ${err.message}`);
        process.exit(1);
    }
    console.log(`PulseReader v${VERSION} running on http://localhost:${PORT}`);
    console.log(`Books directory: ${path.resolve(BOOKS_DIR)}`);
    console.log(WEB_DIR ? `Serving web app from ${WEB_DIR}` : 'Web app not found - API only');
    console.log(`Users: ${db.prepare('SELECT COUNT(*) n FROM users').get().n}`);
});
