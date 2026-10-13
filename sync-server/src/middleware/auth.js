import crypto from 'crypto';
import { Router } from 'express';
import {
    createSession, resolveSession, deleteSession, verifyPassword,
    validatePassword, hashPassword, publicUser, SESSION_DAYS,
} from '../users.js';

const COOKIE = 'pulsereader_session';

function readCookie(req, name) {
    const header = req.headers.cookie || '';
    for (const part of header.split(';')) {
        const i = part.indexOf('=');
        if (i > 0 && part.slice(0, i).trim() === name) {
            return decodeURIComponent(part.slice(i + 1).trim());
        }
    }
    return null;
}

function setSessionCookie(req, res, token) {
    const secure = req.secure ? '; Secure' : '';
    res.append('Set-Cookie',
        `${COOKIE}=${token}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; SameSite=Lax${secure}`);
}

function clearSessionCookie(res) {
    res.append('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
}

function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/**
 * Who is making this request? The session cookie for the app; X-API-Key /
 * Authorization: Bearer <API_KEY> for scripts, which act as the first admin.
 * Sets req.user, and quietly renews the cookie for sessions in daily use.
 */
function identify(db, apiKey, req, res) {
    const session = resolveSession(db, readCookie(req, COOKIE));
    if (session) {
        if (session.renewed) setSessionCookie(req, res, readCookie(req, COOKIE));
        return session.user;
    }
    if (apiKey) {
        const auth = req.headers['authorization'];
        const key = req.headers['x-api-key'] || (auth?.startsWith('Bearer ') ? auth.slice(7) : null);
        if (safeEqual(key, apiKey)) {
            return db.prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
        }
    }
    return null;
}

export function authMiddleware(db, apiKey) {
    return (req, res, next) => {
        const user = identify(db, apiKey, req, res);
        if (!user) return res.status(401).json({ error: 'Not signed in' });
        req.user = user;
        next();
    };
}

export function requireAdmin(req, res, next) {
    if (req.user?.role === 'admin') return next();
    res.status(403).json({ error: 'Only an admin can do that' });
}

/**
 * /api/auth: sign in, check who you are, change your password, sign out.
 * Failed sign-ins are throttled per IP so passwords can't be brute-forced.
 */
export function authRouter(db, apiKey) {
    const router = Router();
    const failures = new Map(); // ip -> { count, until }
    const MAX_FAILURES = 10;
    const LOCKOUT_MS = 5 * 60 * 1000;

    router.get('/me', (req, res) => {
        const user = identify(db, apiKey, req, res);
        res.json({ authenticated: !!user, user: publicUser(user) });
    });

    router.post('/login', (req, res) => {
        // Bounded, so a flood of logins from many addresses can't grow it
        // without limit: drop entries that are neither counting nor locked.
        if (failures.size > 10000) {
            for (const [key, value] of failures) {
                if (value.until < Date.now()) failures.delete(key);
            }
        }
        const ip = req.ip || 'unknown';
        const entry = failures.get(ip);
        if (entry && entry.until > Date.now()) {
            return res.status(429).json({ error: 'Too many attempts - wait five minutes' });
        }

        const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(req.body?.username ?? '').trim());
        // Hash even for an unknown name, so the response time doesn't reveal
        // which usernames exist.
        const ok = user
            ? verifyPassword(req.body?.password, user.password_hash)
            : (verifyPassword('x', hashPassword('y')), false);

        if (!ok) {
            const count = (entry?.count || 0) + 1;
            failures.set(ip, {
                count: count >= MAX_FAILURES ? 0 : count,
                until: count >= MAX_FAILURES ? Date.now() + LOCKOUT_MS : 0,
            });
            return res.status(401).json({ error: 'Wrong username or password' });
        }

        failures.delete(ip);
        setSessionCookie(req, res, createSession(db, user.id, req.headers['user-agent']));
        res.json({ ok: true, user: publicUser(user) });
    });

    router.post('/logout', (req, res) => {
        deleteSession(db, readCookie(req, COOKIE));
        clearSessionCookie(res);
        res.json({ ok: true });
    });

    router.put('/password', authMiddleware(db, apiKey), (req, res) => {
        const { currentPassword, newPassword } = req.body || {};
        if (!verifyPassword(currentPassword, req.user.password_hash)) {
            return res.status(400).json({ error: 'Current password is wrong' });
        }
        const problem = validatePassword(newPassword);
        if (problem) return res.status(400).json({ error: problem });

        // Sign out every other device, keep this one.
        const current = readCookie(req, COOKIE);
        db.transaction(() => {
            db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), req.user.id);
            db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.user.id);
        })();
        if (current) setSessionCookie(req, res, createSession(db, req.user.id, req.headers['user-agent']));
        res.json({ ok: true });
    });

    return router;
}
