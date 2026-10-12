// Accounts: upgrading a pre-accounts database hands every reading position to
// the first admin, passwords verify, and sessions resolve, renew and end.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initDB } from '../src/db.js';
import {
    bootstrapAdmin, hashPassword, verifyPassword,
    createSession, resolveSession, deleteSession,
} from '../src/users.js';

const results = [];
const check = (n, pass, detail = '') => results.push({ n, pass, detail });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-users-'));
const dbPath = path.join(tmp, 'test.db');

// A database as the single-password version left it.
const old = new Database(dbPath);
old.exec(`
    CREATE TABLE books (id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT, series TEXT,
        filename TEXT NOT NULL, filepath TEXT NOT NULL, cover_path TEXT, file_hash TEXT,
        file_size INTEGER DEFAULT 0, added_at TEXT, updated_at TEXT);
    CREATE TABLE reading_progress (book_id TEXT PRIMARY KEY, location TEXT, progress REAL DEFAULT 0,
        is_read INTEGER DEFAULT 0, updated_at TEXT);
    INSERT INTO books (id, title, filename, filepath) VALUES ('b1', 'Dune', 'Dune.epub', 'Dune.epub');
    INSERT INTO reading_progress VALUES ('b1', 'epubcfi(/6/14!/4/2/16)', 0.62, 1, '2026-01-01');
    INSERT INTO reading_progress VALUES ('gone', 'epubcfi(/6/2)', 0.5, 0, '2026-01-01');
`);
old.close();

const db = initDB(dbPath);
check('no users and no password: bootstrap refuses', bootstrapAdmin(db, {}) === false);
check('bootstrap creates the admin from API_KEY', bootstrapAdmin(db, { API_KEY: 'old-shared-pass' }) === true);

const admin = db.prepare('SELECT * FROM users').get();
check('the admin is called "admin" and has role admin', admin?.username === 'admin' && admin?.role === 'admin');
check('the old shared password signs in as the admin', verifyPassword('old-shared-pass', admin.password_hash));
check('a wrong password does not', !verifyPassword('old-shared-pas', admin.password_hash));

const rows = db.prepare('SELECT * FROM reading_progress').all();
check('the 62% position now belongs to the admin',
    rows.length === 1 && rows[0].user_id === admin.id && rows[0].progress === 0.62 && rows[0].is_read === 1,
    JSON.stringify(rows));
check('the legacy table is gone',
    !db.prepare("SELECT 1 FROM sqlite_master WHERE name='reading_progress_legacy'").get());
check('a second boot changes nothing', bootstrapAdmin(db, { API_KEY: 'other' }) === true
    && db.prepare('SELECT COUNT(*) n FROM users').get().n === 1
    && verifyPassword('old-shared-pass', db.prepare('SELECT password_hash h FROM users').get().h));

const hashA = hashPassword('same'), hashB = hashPassword('same');
check('the same password hashes differently each time (salted)', hashA !== hashB);

const token = createSession(db, admin.id, 'test');
check('a new session resolves to its user', resolveSession(db, token)?.user.id === admin.id);
check('a fresh session is not renewed yet', resolveSession(db, token)?.renewed === false);
check('the database stores no raw token',
    !db.prepare('SELECT 1 FROM sessions WHERE token_hash = ?').get(token));

db.prepare("UPDATE sessions SET last_seen = datetime('now', '-2 days')").run();
check('a session idle for a day is renewed on use', resolveSession(db, token)?.renewed === true);

db.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
check('an expired session is refused', resolveSession(db, token) === null);

const t2 = createSession(db, admin.id, 'test');
deleteSession(db, t2);
check('a signed-out session is refused', resolveSession(db, t2) === null);

db.close();
fs.rmSync(tmp, { recursive: true, force: true });

for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}${r.detail && !r.pass ? `  (${r.detail})` : ''}`);
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
