// Regression test: a scan that sees nothing must not be read as "the user
// deleted their library". An existing-but-empty books dir is what a failed
// bind mount looks like, and the delete loop takes reading_progress with it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initDB } from '../src/db.js';
import { scanBooksFolder } from '../src/scanner.js';

const results = [];
const check = (n, pass, detail = '') => results.push({ n, pass, detail });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-scan-'));
const booksDir = path.join(tmp, 'books');
fs.mkdirSync(booksDir, { recursive: true });

const db = initDB(path.join(tmp, 'test.db'));
db.prepare(`INSERT INTO books (id,title,author,series,filename,filepath,file_hash,file_size)
            VALUES ('b1','Dune','Herbert','SciFi','Dune.epub',?,'h1',10)`).run(path.join('SciFi', 'Dune.epub'));
db.prepare(`INSERT INTO books (id,title,author,series,filename,filepath,file_hash,file_size)
            VALUES ('b2','Neuromancer','Gibson','SciFi','Neuro.epub',?,'h2',10)`).run(path.join('SciFi', 'Neuro.epub'));
db.prepare(`INSERT INTO reading_progress (book_id,location,progress,is_read,updated_at)
            VALUES ('b1','epubcfi(/6/14!/4/2/16)',0.62,0,'2026-01-01T00:00:00Z')`).run();
db.prepare(`INSERT INTO reading_progress (book_id,location,progress,is_read,updated_at)
            VALUES ('b2','epubcfi(/6/4!/4/2/2)',0.10,0,'2026-01-01T00:00:00Z')`).run();

const books = () => db.prepare('SELECT COUNT(*) n FROM books').get().n;
const prog  = () => db.prepare('SELECT COUNT(*) n FROM reading_progress').get().n;

// 1. Empty dir + populated DB: the unmounted-volume case.
await scanBooksFolder(db, booksDir);
check('empty books dir does not delete book rows', books() === 2, `${books()} books left`);
check('empty books dir does not delete reading progress', prog() === 2, `${prog()} progress rows left`);
const dune = db.prepare("SELECT location, progress FROM reading_progress WHERE book_id='b1'").get();
check('the 62% position survives', dune && dune.progress === 0.62 && !!dune.location,
    dune ? `progress=${dune.progress}` : 'ROW GONE');

// 2. A genuinely deleted single book still reconciles.
const seriesDir = path.join(booksDir, 'SciFi');
fs.mkdirSync(seriesDir, { recursive: true });
fs.writeFileSync(path.join(seriesDir, 'Dune.epub'), 'not-a-real-epub');
await scanBooksFolder(db, booksDir);
const b2 = db.prepare("SELECT COUNT(*) n FROM books WHERE id='b2'").get().n;
check('a single missing book is still removed', b2 === 0, `${b2} rows for the removed book`);
const b1 = db.prepare("SELECT COUNT(*) n FROM books WHERE id='b1'").get().n;
check('the book still on disk is kept', b1 === 1, `${b1} rows for the surviving book`);

// 3. First run against a genuinely empty library must not warn or throw.
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-scan2-'));
const empty2 = path.join(tmp2, 'books');
fs.mkdirSync(empty2, { recursive: true });
const db2 = initDB(path.join(tmp2, 'test2.db'));
let threw = null;
try { await scanBooksFolder(db2, empty2); } catch (e) { threw = e.message; }
check('empty DB + empty dir is a no-op, not an error', threw === null, threw || 'ok');

let failed = 0;
console.log('\n--- scanner floor ---');
for (const r of results) { if (!r.pass) failed++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}${r.detail ? `  (${r.detail})` : ''}`); }
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
