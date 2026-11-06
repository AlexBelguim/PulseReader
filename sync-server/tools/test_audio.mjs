// Audiobooks: what the scanner makes of a folder, that a rename keeps the
// listening position, that an empty (unmounted) folder deletes nothing, and
// that the most recent listen wins.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDB } from '../src/db.js';
import { createAudioLibrary, saveAudioProgress, cleanTitle } from '../src/audiobooks.js';

const results = [];
const check = (n, pass, detail = '') => results.push({ n, pass, detail });

/** A real, silent WAV file of `seconds`, so the tags reader has something to read. */
function wav(file, seconds) {
    const rate = 8000;
    const data = Buffer.alloc(rate * seconds * 2);
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
    h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
    h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
    h.write('data', 36); h.writeUInt32LE(data.length, 40);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.concat([h, data]));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-audio-'));
const audioDir = path.join(tmp, 'audio');
const series = path.join(audioDir, 'Saga');
wav(path.join(series, '01 - First Book.wav'), 3);
fs.writeFileSync(path.join(series, 'First Book.png'), 'png');
wav(path.join(series, '02 - Second Book', 'Part 1.wav'), 2);
wav(path.join(series, '02 - Second Book', 'Part 2.wav'), 4);
wav(path.join(audioDir, 'Standalone.wav'), 1);
fs.writeFileSync(path.join(series, '._01 - First Book.wav'), 'macOS junk');

const db = initDB(path.join(tmp, 'test.db'));
db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'reader', 'x', 'admin')").run();
const lib = createAudioLibrary(db, audioDir, path.join(tmp, 'covers'));

const all = () => db.prepare('SELECT * FROM audiobooks ORDER BY filename').all();
const byTitle = (t) => all().find((b) => b.title === t);

// 1. What the scan finds.
const count = await lib.scan();
check('three books, macOS "._" files ignored', count === 3 && all().length === 3, `${count} / ${all().length}`);
check('"01 - First Book" is titled "First Book"', !!byTitle('First Book'));
check('the cover named after the book is used, number or not', byTitle('First Book')?.cover_path === path.join('Saga', 'First Book.png'),
    byTitle('First Book')?.cover_path);
const second = byTitle('Second Book');
check('a folder of tracks is one book', second?.kind === 'folder' && JSON.parse(second.tracks).length === 2);
check('its duration is the tracks together', Math.abs((second?.duration ?? 0) - 6) < 0.05, `${second?.duration}`);
const chapters = JSON.parse(second?.chapters || '[]');
check('each track is a chapter, at its place in the book',
    chapters.length === 2 && chapters[0].start === 0 && Math.abs(chapters[1].start - 2) < 0.05, JSON.stringify(chapters));
check('a file in the root is Uncategorized', byTitle('Standalone')?.series === 'Uncategorized');
check('cleanTitle leaves "1984" alone', cleanTitle('1984') === '1984' && cleanTitle('03. Onyx Storm') === 'Onyx Storm');

// 2. Positions: the newer one wins, an older one is ignored.
const first = byTitle('First Book');
saveAudioProgress(db, 1, first.id, { position: 2.5, updated_at: '2026-05-02T10:00:00Z' });
saveAudioProgress(db, 1, first.id, { position: 0.5, updated_at: '2026-05-01T10:00:00Z' });
let p = db.prepare('SELECT * FROM audio_progress WHERE audiobook_id = ?').get(first.id);
check('an older position does not replace a newer one', p.position === 2.5, `${p.position}`);
saveAudioProgress(db, 1, first.id, { position: 1, updated_at: '2026-05-03T10:00:00Z' });
p = db.prepare('SELECT * FROM audio_progress WHERE audiobook_id = ?').get(first.id);
check('going back to an earlier chapter sticks', p.position === 1, `${p.position}`);
saveAudioProgress(db, 1, first.id, { position: 999, updated_at: '2026-05-04T10:00:00Z' });
p = db.prepare('SELECT * FROM audio_progress WHERE audiobook_id = ?').get(first.id);
check('a position past the end is clamped to the end', Math.abs(p.position - 3) < 0.05, `${p.position}`);

// 3. A rename (and a move to another series) keeps the id, so the position.
fs.mkdirSync(path.join(audioDir, 'Other'));
fs.renameSync(path.join(series, '01 - First Book.wav'), path.join(audioDir, 'Other', 'First Book (Unabridged).wav'));
await lib.scan();
const moved = byTitle('First Book (Unabridged)');
check('a renamed, moved book keeps its id', moved?.id === first.id, moved ? moved.id : 'not found');
check('...and its new series and track name', moved?.series === 'Other' && JSON.parse(moved.tracks)[0].file === 'First Book (Unabridged).wav');
check('...and its position', db.prepare('SELECT COUNT(*) n FROM audio_progress WHERE audiobook_id = ?').get(first.id).n === 1);

// 4. An empty folder is a missing mount, not an empty library.
const hidden = path.join(tmp, 'audio-away');
fs.renameSync(audioDir, hidden);
fs.mkdirSync(audioDir);
await lib.scan();
check('an empty audio folder removes nothing', all().length === 3, `${all().length} left`);
fs.rmSync(audioDir, { recursive: true });
fs.renameSync(hidden, audioDir);

// 5. A book that is really gone goes, with its position.
fs.rmSync(path.join(audioDir, 'Other'), { recursive: true });
await lib.scan();
check('a deleted book is removed', all().length === 2 && !byTitle('First Book (Unabridged)'));
check('...with its position', db.prepare('SELECT COUNT(*) n FROM audio_progress').get().n === 0);

db.close();
fs.rmSync(tmp, { recursive: true, force: true });

let failed = 0;
for (const r of results) {
    if (!r.pass) failed++;
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}${r.detail && !r.pass ? `  (${r.detail})` : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
