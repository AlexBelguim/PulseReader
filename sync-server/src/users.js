import crypto from 'crypto';

// ---- Passwords --------------------------------------------------------------
// scrypt from Node itself: no native module to build, and the parameters are
// stored with each hash so they can be raised later without breaking logins.

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
    return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
    if (typeof password !== 'string' || typeof stored !== 'string') return false;
    const [scheme, N, r, p, salt, hash] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(hash, 'base64');
    const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, {
        N: Number(N), r: Number(r), p: Number(p),
    });
    return crypto.timingSafeEqual(actual, expected);
}

export const MIN_PASSWORD_LENGTH = 8;

export function validateUsername(name) {
    const username = String(name ?? '').trim();
    if (!/^[\p{L}\p{N}._-]{1,32}$/u.test(username)) {
        return { error: 'Username: 1-32 letters, numbers, dots, dashes or underscores' };
    }
    return { username };
}

export function validatePassword(password) {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
        return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
    }
    if (password.length > 256) return 'Password is too long';
    return null;
}

export function publicUser(u) {
    return u && { id: u.id, username: u.username, role: u.role, created_at: u.created_at };
}

// ---- Sessions ---------------------------------------------------------------
// Opaque random tokens; the database keeps only their SHA-256. A session lasts
// a year from the last time it was used, so anyone who opens the app at least
// once a year never sees the sign-in screen again, while signing out or
// deleting a user ends their sessions immediately.

export const SESSION_DAYS = 365;
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const expiryFromNow = () => new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();

export function createSession(db, userId, userAgent) {
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare(`
        INSERT INTO sessions (token_hash, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)
    `).run(sha256(token), userId, expiryFromNow(), String(userAgent || '').slice(0, 200));
    return token;
}

/**
 * Look up a session token. Returns { user, renewed } or null. `renewed` is
 * true when the expiry was pushed forward, so the caller re-sends the cookie
 * with a fresh Max-Age.
 */
export function resolveSession(db, token) {
    if (!token) return null;
    const row = db.prepare(`
        SELECT s.token_hash, s.last_seen, s.expires_at, u.*
        FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?
    `).get(sha256(token));
    if (!row) return null;
    if (new Date(row.expires_at) < new Date()) {
        db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
        return null;
    }
    let renewed = false;
    // SQLite's datetime('now') is UTC without a zone marker.
    if (Date.now() - new Date(row.last_seen.replace(' ', 'T') + 'Z').getTime() > RENEW_AFTER_MS) {
        db.prepare(`UPDATE sessions SET last_seen = datetime('now'), expires_at = ? WHERE token_hash = ?`)
            .run(expiryFromNow(), row.token_hash);
        renewed = true;
    }
    return { user: row, renewed };
}

export function deleteSession(db, token) {
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

// ---- First run --------------------------------------------------------------

/**
 * Make sure there is an admin to sign in with. On a fresh install (or an
 * upgrade from the single-password version) the first admin is created from
 * ADMIN_USERNAME / ADMIN_PASSWORD, falling back to API_KEY as the password so
 * existing setups keep working with the same password. Returns false when
 * there are no users and nothing to create one from.
 */
export function bootstrapAdmin(db, env) {
    const count = db.prepare('SELECT COUNT(*) n FROM users').get().n;
    if (count === 0) {
        const password = env.ADMIN_PASSWORD || env.API_KEY;
        if (!password) return false;
        const { username, error } = validateUsername(env.ADMIN_USERNAME || 'admin');
        if (error) throw new Error(`ADMIN_USERNAME: ${error}`);
        db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')")
            .run(username, hashPassword(password));
        console.log(`Created admin user "${username}"`);
    }
    adoptLegacyProgress(db);
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(new Date().toISOString());
    return true;
}

function adoptLegacyProgress(db) {
    const legacy = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='reading_progress_legacy'").get();
    if (!legacy) return;
    const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
    db.transaction(() => {
        db.prepare(`
            INSERT OR IGNORE INTO reading_progress (user_id, book_id, location, progress, is_read, updated_at)
            SELECT ?, l.book_id, l.location, l.progress, COALESCE(l.is_read, 0), l.updated_at
            FROM reading_progress_legacy l JOIN books b ON b.id = l.book_id
        `).run(admin.id);
        db.exec('DROP TABLE reading_progress_legacy');
    })();
}
