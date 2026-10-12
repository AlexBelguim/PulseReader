// Regression test: a scan that sees nothing must not be read as "the user
// deleted their library". An existing-but-empty books dir is what a failed
// bind mount looks like, and the delete loop takes reading_progress with it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDB } from '../src/db.js';
import { scanBooksFolder } from '../src/scanner.js';

const results = [];
const check = (n, pass, detail = '') => results.push({ n, pass, detail });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-scan-'));
const booksDir = path.join(tmp, 'books');
fs.mkdirSync(booksDir, { recursive: true });

const db = initDB(path.join(tmp, 'test.db'));
db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'reader', 'x', 'admin')").run();
db.prepare(`INSERT INTO books (id,title,author,series,filename,filepath,file_hash,file_size)
            VALUES ('b1','Dune','Herbert','SciFi','Dune.epub',?,'h1',10)`).run(path.join('SciFi', 'Dune.epub'));
db.prepare(`INSERT INTO books (id,title,author,series,filename,filepath,file_hash,file_size)
            VALUES ('b2','Neuromancer','Gibson','SciFi','Neuro.epub',?,'h2',10)`).run(path.join('SciFi', 'Neuro.epub'));
db.prepare(`INSERT INTO reading_progress (user_id,book_id,location,progress,is_read,updated_at)
            VALUES (1,'b1','epubcfi(/6/14!/4/2/16)',0.62,0,'2026-01-01T00:00:00Z')`).run();
db.prepare(`INSERT INTO reading_progress (user_id,book_id,location,progress,is_read,updated_at)
            VALUES (1,'b2','epubcfi(/6/4!/4/2/2)',0.10,0,'2026-01-01T00:00:00Z')`).run();

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

// 4. A renamed book is the same book. Identity used to be the file path, so
//    renaming deleted the row and inserted a fresh uuid, taking progress along.
fs.renameSync(path.join(seriesDir, 'Dune.epub'), path.join(seriesDir, 'Dune (1965).epub'));
await scanBooksFolder(db, booksDir);
const renamed = db.prepare("SELECT filepath, title FROM books WHERE id='b1'").get();
check('a renamed book keeps its row', !!renamed, renamed ? `filepath=${renamed.filepath}` : 'ROW GONE');
check('the renamed row points at the new path',
    renamed?.filepath === path.join('SciFi', 'Dune (1965).epub'), renamed?.filepath || 'n/a');
const keptProg = db.prepare("SELECT progress FROM reading_progress WHERE book_id='b1'").get();
check('reading progress survives a rename', keptProg?.progress === 0.62,
    keptProg ? `progress=${keptProg.progress}` : 'ROW GONE');
check('a rename does not leave a duplicate row', books() === 1, `${books()} books`);

// 5. Moving between series folders is the same book too.
const otherDir = path.join(booksDir, 'Classics');
fs.mkdirSync(otherDir, { recursive: true });
fs.renameSync(path.join(seriesDir, 'Dune (1965).epub'), path.join(otherDir, 'Dune (1965).epub'));
await scanBooksFolder(db, booksDir);
const moved = db.prepare("SELECT series FROM books WHERE id='b1'").get();
check('a book moved between series keeps its row', moved?.series === 'Classics',
    moved ? `series=${moved.series}` : 'ROW GONE');
check('progress survives the move',
    db.prepare("SELECT progress FROM reading_progress WHERE book_id='b1'").get()?.progress === 0.62);

// 6. An identical COPY is a new book, not a rename: the original is still on
//    disk, so its progress must not be handed to the duplicate.
fs.copyFileSync(path.join(otherDir, 'Dune (1965).epub'), path.join(seriesDir, 'Dune copy.epub'));
await scanBooksFolder(db, booksDir);
check('an identical copy inserts a new row', books() === 2, `${books()} books`);
const origStill = db.prepare("SELECT series FROM books WHERE id='b1'").get();
check('the copy does not steal the original row', origStill?.series === 'Classics',
    origStill ? `series=${origStill.series}` : 'ROW GONE');
check('the original keeps its progress after a copy appears',
    db.prepare("SELECT progress FROM reading_progress WHERE book_id='b1'").get()?.progress === 0.62);

let failed = 0;
console.log('\n--- scanner floor ---');
for (const r of results) { if (!r.pass) failed++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}${r.detail ? `  (${r.detail})` : ''}`); }
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
