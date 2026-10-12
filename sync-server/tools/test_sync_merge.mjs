// Sync merge: the more recently READ side wins, per book, for the position
// and the read flag separately. Covers offline reading (the plane), going
// back to re-read, two devices, and read-state changes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDB } from '../src/db.js';
import { applyProgressUpdates, normalizeProgressTimes } from '../src/progressMerge.js';

const results = [];
const check = (n, pass, detail = '') => results.push({ n, pass, detail });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-merge-'));
const db = initDB(path.join(tmp, 'test.db'));
db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'reader', 'x', 'admin')").run();
db.prepare("INSERT INTO books (id, title, filename, filepath) VALUES ('b1', 'Book', 'b.epub', 'b.epub')").run();
db.prepare("INSERT INTO books (id, title, filename, filepath) VALUES ('b2', 'Other', 'o.epub', 'o.epub')").run();

const row = (id = 'b1') => db.prepare('SELECT * FROM reading_progress WHERE user_id = 1 AND book_id = ?').get(id);
const at = (h) => new Date(Date.UTC(2026, 9, 13, h)).toISOString();
const sync = (u, force = false) => applyProgressUpdates(db, 1, [{ book_id: 'b1', ...u }], { force });

// The tablet reads to 40% at 10:00 and syncs.
sync({ location: 'cfi-40', progress: 0.4, updated_at: at(10) });
check('first sync stores the position', row()?.location === 'cfi-40');

// The phone was offline (a plane) and read to 55% at 12:00. Landing, it syncs.
sync({ location: 'cfi-55', progress: 0.55, updated_at: at(12) });
check('progress made offline wins when it is newer', row().location === 'cfi-55');

// A device that last read at 11:00 syncs afterwards: older, so it loses.
sync({ location: 'cfi-45', progress: 0.45, updated_at: at(11) });
check('an older position does not replace a newer one', row().location === 'cfi-55');

// Going back to re-read chapter 3 (20%) at 13:00: newer, so it sticks even
// though it is lower. Highest-progress-wins used to bounce you forward.
sync({ location: 'cfi-20', progress: 0.2, updated_at: at(13) });
check('re-reading an earlier part sticks', row().location === 'cfi-20' && row().progress === 0.2);

// A device with no position (never opened the book) changes nothing.
sync({ location: null, progress: 0, is_read: false, updated_at: at(14) });
check('"no position" never erases one (merge)', row().location === 'cfi-20');
sync({ location: null, progress: 0, is_read: false }, true);
check('"no position" never erases one (Push)', row().location === 'cfi-20');

// Push forces this device's position even if older.
sync({ location: 'cfi-30', progress: 0.3, updated_at: at(9) }, true);
check('Push takes the device position even if older', row().location === 'cfi-30');

// Read-state has its own time. Marked read at 15:00, then a device that
// last changed it at 14:00 says unread: the newer "read" wins.
sync({ is_read: true, read_updated_at: at(15), read_state_only: true });
check('marking read is stored', row().is_read === 1);
sync({ location: null, is_read: false, read_updated_at: at(14) });
check('an older read-state does not override a newer one', row().is_read === 1);
// Marked unread offline at 16:00, synced later: unread wins.
sync({ location: null, is_read: false, read_updated_at: at(16) });
check('marking unread offline survives syncing', row().is_read === 0);
check('read-state changes leave the position alone', row().location === 'cfi-30');

// Push from a device that never touched the read flag leaves it alone.
sync({ is_read: true, read_updated_at: at(17), read_state_only: true });
sync({ location: 'cfi-31', progress: 0.31, updated_at: at(18), is_read: false }, true);
check('Push without a read-state opinion keeps "read"', row().is_read === 1 && row().location === 'cfi-31');
sync({ location: 'cfi-31', progress: 0.31, updated_at: at(18), is_read: false, read_updated_at: at(19) }, true);
check('Push with a newer "unread" clears it', row().is_read === 0);

// A timeless position (old client) creates a row but never beats a dated one.
applyProgressUpdates(db, 1, [{ book_id: 'b2', location: 'old', progress: 0.1 }]);
check('a timeless position still creates a row', row('b2')?.location === 'old');
applyProgressUpdates(db, 1, [{ book_id: 'b2', location: 'dated', progress: 0.05, updated_at: at(1) }]);
check('any dated position beats a timeless one', row('b2').location === 'dated');
applyProgressUpdates(db, 1, [{ book_id: 'b2', location: 'old-again', progress: 0.9 }]);
check('a timeless position never beats a dated one', row('b2').location === 'dated');

// Books the server doesn't know are skipped, not an error.
applyProgressUpdates(db, 1, [{ book_id: 'gone', location: 'x', updated_at: at(1) }]);
check('unknown books are skipped', !row('gone'));

// Times written by SQLite's datetime('now') are rewritten to ISO so they
// compare correctly against device times.
db.prepare("UPDATE reading_progress SET updated_at = '2026-10-13 18:00:00' WHERE book_id = 'b1'").run();
normalizeProgressTimes(db);
check('old-format times are normalised to ISO', row().updated_at === '2026-10-13T18:00:00.000Z', row().updated_at);
const before = row().location;
sync({ location: 'cfi-x', progress: 0.5, updated_at: at(17) });
check('and then compare correctly (17:00 < 18:00 loses)', row().location === before);

db.close();
fs.rmSync(tmp, { recursive: true, force: true });

for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}${r.pass ? '' : `  (${r.detail})`}`);
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
