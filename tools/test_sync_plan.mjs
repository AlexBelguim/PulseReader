// Client side of "most recent reading wins": what Pull / Full Sync take from
// the server for one book. The plane case is the reason this exists.
import { isNewer, planFromServer } from '../src/services/syncService.js';

const results = [];
const check = (n, pass, detail = '') => results.push({ n, pass, detail });
const at = (h) => new Date(Date.UTC(2026, 9, 13, h)).toISOString();

// Times
check('a later time is newer', isNewer(at(12), at(10)));
check('an earlier time is not', !isNewer(at(10), at(12)));
check('anything known beats unknown', isNewer(at(1), null));
check('unknown never wins', !isNewer(null, at(1)) && !isNewer(undefined, null));
check('old server format is read as UTC', isNewer('2026-10-13 12:00:01', at(12)) && !isNewer('2026-10-13 11:59:59', at(12)));

// The plane: the server has the tablet's 40% from 10:00; the phone read
// offline to 55% at 12:00 and presses Pull first after landing.
const phone = { lastRead: 'cfi-55', progress: 0.55, progressAt: at(12), isRead: false, readAt: null };
const server = { location: 'cfi-40', progress: 0.4, updatedAt: at(10), isRead: false, readAt: null };
let plan = planFromServer(phone, server);
check('Pull after a flight keeps the reading done offline', plan.position === null && plan.read === null, JSON.stringify(plan));

// The other way round: the tablet read later than the phone.
plan = planFromServer(phone, { ...server, location: 'cfi-70', progress: 0.7, updatedAt: at(13) });
check('a newer position from another device is taken', plan.position?.cfi === 'cfi-70' && plan.position.at === at(13));

// Re-reading: the server has 60% from 09:00, the phone went back to 30% at 11:00.
plan = planFromServer({ lastRead: 'cfi-30', progress: 0.3, progressAt: at(11) }, { location: 'cfi-60', progress: 0.6, updatedAt: at(9) });
check('going back to re-read is not undone', plan.position === null);

// A book this device never opened takes the server's position.
plan = planFromServer({ lastRead: null, progressAt: null }, server);
check('a never-opened book takes the server position', plan.position?.cfi === 'cfi-40');

// A read-state-only row (no position) never touches the position.
plan = planFromServer(phone, { location: null, progress: 0, updatedAt: null, isRead: true, readAt: at(14) });
check('read-state rows leave the position alone', plan.position === null && plan.read?.isRead === true);

// Read flag: unread offline at 15:00 beats "read" from 14:00 on the server.
plan = planFromServer({ isRead: false, readAt: at(15) }, { isRead: true, readAt: at(14) });
check('marking unread offline survives Pull', plan.read === null);
plan = planFromServer({ isRead: false, readAt: at(13) }, { isRead: true, readAt: at(14) });
check('a newer "read" from another device is taken', plan.read?.isRead === true);

// Servers from before read-state had a time: "read" stays sticky.
plan = planFromServer({ isRead: false, readAt: null }, { isRead: true, readAt: null });
check('legacy server "read" still applies to an untouched book', plan.read?.isRead === true);
plan = planFromServer({ isRead: false, readAt: at(1) }, { isRead: true, readAt: null });
check('but not over a flag changed on this device', plan.read === null);

for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}${r.pass ? '' : `  (${r.detail})`}`);
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
