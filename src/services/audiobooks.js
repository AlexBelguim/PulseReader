/**
 * Audiobooks stream from the PulseReader server: they are far too big to keep
 * in the browser like epubs. Listening positions are saved on the server per
 * account, and on the device too, so a save that didn't reach the server
 * (offline, server restarting) is sent the next time the list is loaded.
 */

// Relative to the page, like the sync service, so a sub-path proxy works.
const url = (endpoint) => new URL(endpoint.replace(/^\//, ''), document.baseURI).href;

async function api(endpoint, options = {}) {
    const response = await fetch(url(endpoint), {
        ...options,
        headers: { 'Content-Type': 'application/json', ...options.headers },
        credentials: 'same-origin',
    });
    if (!response.ok) {
        const error = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(error.error || `Server error: ${response.status}`);
    }
    return response.json();
}

export const trackUrl = (id, index) => url(`/api/audiobooks/${encodeURIComponent(id)}/tracks/${index}`);

// ?v= changes when the book is rescanned, so a new cover isn't hidden by the cache.
export const coverUrl = (book) => (book?.has_cover
    ? url(`/api/audiobooks/${encodeURIComponent(book.id)}/cover?v=${encodeURIComponent(book.updated_at || '')}`)
    : null);

// ---- positions kept on this device -----------------------------------------

const PROGRESS_KEY = 'pulsereader-audio-progress';
const SPEED_KEY = 'pulsereader-audio-speed';

function readAll() {
    try { return JSON.parse(localStorage.getItem(PROGRESS_KEY)) || {}; } catch { return {}; }
}

export function getLocalProgress(id) {
    return readAll()[id] || null;
}

export function setLocalProgress(id, progress) {
    try {
        const all = readAll();
        all[id] = progress;
        localStorage.setItem(PROGRESS_KEY, JSON.stringify(all));
    } catch { /* private mode or full: the server still has it */ }
}

/** Whichever of two positions was listened to last. */
export function newest(a, b) {
    if (!a?.updated_at) return b?.updated_at ? b : (a || b || null);
    if (!b?.updated_at) return a;
    return Date.parse(b.updated_at) > Date.parse(a.updated_at) ? b : a;
}

export function getSpeed() {
    try {
        const s = Number(localStorage.getItem(SPEED_KEY));
        return s >= 0.5 && s <= 3 ? s : 1;
    } catch {
        return 1;
    }
}

export function setSpeed(speed) {
    try { localStorage.setItem(SPEED_KEY, String(speed)); } catch { /* ignore */ }
}

// ---- server -----------------------------------------------------------------

/**
 * Every audiobook, each with the newest position from here or the server.
 * Positions this device has that the server doesn't are sent along.
 */
export async function listAudiobooks() {
    const books = await api('/api/audiobooks');
    return books.map((book) => {
        const local = getLocalProgress(book.id);
        const progress = newest(book.progress, local);
        // newest() returns the server's on a tie, so this is "only here, or newer here".
        if (local && progress === local) saveProgress(book.id, local).catch(() => {});
        return { ...book, progress };
    });
}

export const getAudiobook = (id) => api(`/api/audiobooks/${encodeURIComponent(id)}`);

/**
 * Save a position here and on the server. `keepalive` lets the request finish
 * while the page is being closed or put away.
 */
export function saveProgress(id, progress, { keepalive = false } = {}) {
    setLocalProgress(id, progress);
    return api(`/api/audiobooks/${encodeURIComponent(id)}/progress`, {
        method: 'PUT',
        body: JSON.stringify(progress),
        keepalive,
    });
}

// ---- formatting ---------------------------------------------------------------

/** 75 -> "1:15", 3725 -> "1:02:05". */
export function formatClock(seconds) {
    const s = Math.max(0, Math.floor(seconds || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** 66381 -> "18h 26m", 2400 -> "40m", 20 -> "1m". */
export function formatDuration(seconds) {
    const total = Math.max(0, Math.round((seconds || 0) / 60));
    const h = Math.floor(total / 60);
    const m = total % 60;
    if (!h) return `${Math.max(m, seconds > 0 ? 1 : 0)}m`;
    return m ? `${h}h ${m}m` : `${h}h`;
}

/** 0..1 through the book. */
export function fractionDone(book) {
    if (!book?.duration || !book.progress) return 0;
    return Math.min(1, Math.max(0, (book.progress.position || 0) / book.duration));
}
