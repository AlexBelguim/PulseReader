import { Router } from 'express';
import { hashPassword, validatePassword, validateUsername, publicUser } from '../users.js';

/**
 * /api/users: admin-only account management. There is no self sign-up; the
 * admin creates an account and hands the password over.
 */
export function usersRouter(db) {
    const router = Router();
    const adminCount = () => db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin'").get().n;

    router.get('/', (req, res) => {
        res.json(db.prepare('SELECT * FROM users ORDER BY username').all().map(publicUser));
    });

    router.post('/', (req, res) => {
        const { username, error } = validateUsername(req.body?.username);
        if (error) return res.status(400).json({ error });
        const problem = validatePassword(req.body?.password);
        if (problem) return res.status(400).json({ error: problem });
        const role = req.body?.role === 'admin' ? 'admin' : 'user';

        if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
            return res.status(409).json({ error: `"${username}" already exists` });
        }
        const { lastInsertRowid } = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
            .run(username, hashPassword(req.body.password), role);
        res.status(201).json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid)));
    });

    /** Change role and/or set a new password (which signs that user out everywhere). */
    router.put('/:id', (req, res) => {
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const { role, password } = req.body || {};
        if (role !== undefined && !['admin', 'user'].includes(role)) {
            return res.status(400).json({ error: 'Role must be admin or user' });
        }
        if (role === 'user' && user.role === 'admin' && adminCount() === 1) {
            return res.status(400).json({ error: 'There must be at least one admin' });
        }
        if (password !== undefined) {
            const problem = validatePassword(password);
            if (problem) return res.status(400).json({ error: problem });
        }

        db.transaction(() => {
            if (role !== undefined) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, user.id);
            if (password !== undefined) {
                db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), user.id);
                db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
            }
        })();
        res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)));
    });

    /** Deletes the account, its sessions and its reading progress. Books stay. */
    router.delete('/:id', (req, res) => {
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.id === req.user.id) return res.status(400).json({ error: "You can't delete your own account" });
        if (user.role === 'admin' && adminCount() === 1) {
            return res.status(400).json({ error: 'There must be at least one admin' });
        }
        db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
        res.json({ success: true });
    });

    return router;
}
