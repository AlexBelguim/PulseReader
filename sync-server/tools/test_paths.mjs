// Regression test: series names and upload filenames come straight from
// request bodies and are joined onto the books directory. None of them may
// name a folder outside it, or a hidden / Windows-mangled one inside it.
import path from 'node:path';
import { safeSegment, resolveInside } from '../src/paths.js';

const results = [];
const check = (n, pass, detail = '') => results.push({ n, pass, detail });

const cases = [
    ['../../escaped', 'escaped'],
    ['..', 'Uncategorized'],
    ['  . ', 'Uncategorized'],
    ['', 'Uncategorized'],
    [null, 'Uncategorized'],
    ['a/b\\c', 'a b c'],
    ['Re:Zero?', 'Re Zero'],
    ['Vol. 1.', 'Vol. 1'],
    ['Mushoku Tensei', 'Mushoku Tensei'],
];
for (const [input, want] of cases) {
    const got = safeSegment(input);
    check(`safeSegment(${JSON.stringify(input)}) is ${JSON.stringify(want)}`, got === want, got);
}

const root = path.resolve('books');
let blocked = false;
try { resolveInside(root, '../outside.epub'); } catch { blocked = true; }
check('resolveInside refuses a path that climbs out of the root', blocked);

blocked = false;
try { resolveInside(root, path.resolve('/etc/passwd')); } catch { blocked = true; }
check('resolveInside refuses an absolute path elsewhere', blocked);

check('resolveInside allows a path inside the root',
    resolveInside(root, 'Series', 'Vol 1.epub') === path.join(root, 'Series', 'Vol 1.epub'));

for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}${r.detail ? `  (${r.detail})` : ''}`);
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
