import React, { useEffect, useState } from 'react';
import { UserPlus, Trash2, KeyRound, Shield, AlertCircle, Check } from 'lucide-react';
import { listUsers, createUser, updateUser, deleteUser } from '../services/syncService';

/**
 * Admin-only: the accounts on this server. No sign-up page exists; the admin
 * creates an account here and tells the person their password.
 */
const UserManagement = ({ currentUser }) => {
    const [users, setUsers] = useState([]);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);
    const [newUser, setNewUser] = useState({ username: '', password: '', role: 'user' });
    const [resetting, setResetting] = useState(null); // user id
    const [resetPassword, setResetPassword] = useState('');

    const run = async (fn, message) => {
        setError(null);
        setNotice(null);
        try {
            await fn();
            setUsers(await listUsers());
            if (message) setNotice(message);
            return true;
        } catch (err) {
            setError(err.message);
            return false;
        }
    };

    useEffect(() => {
        listUsers().then(setUsers).catch((err) => setError(err.message));
    }, []);

    const handleCreate = async (e) => {
        e.preventDefault();
        const ok = await run(
            () => createUser(newUser.username.trim(), newUser.password, newUser.role),
            `Created "${newUser.username.trim()}"`
        );
        if (ok) setNewUser({ username: '', password: '', role: 'user' });
    };

    const handleReset = async (e, user) => {
        e.preventDefault();
        const ok = await run(
            () => updateUser(user.id, { password: resetPassword }),
            `New password set for "${user.username}"; they're signed out everywhere`
        );
        if (ok) {
            setResetting(null);
            setResetPassword('');
        }
    };

    const handleDelete = (user) => {
        if (!window.confirm(`Delete "${user.username}" and their reading progress? Books are not affected.`)) return;
        run(() => deleteUser(user.id), `Deleted "${user.username}"`);
    };

    return (
        <div className="sync-section">
            <h3>Users</h3>

            <ul className="user-list">
                {users.map((user) => (
                    <li key={user.id} className="user-row">
                        <div className="user-row-main">
                            <span className="user-name">
                                {user.username}
                                {user.id === currentUser?.id && <span className="user-you"> (you)</span>}
                            </span>
                            <select
                                className="user-role"
                                value={user.role}
                                disabled={user.id === currentUser?.id}
                                onChange={(e) => run(() => updateUser(user.id, { role: e.target.value }))}
                                aria-label={`Role for ${user.username}`}
                            >
                                <option value="user">Reader</option>
                                <option value="admin">Admin</option>
                            </select>
                            {user.id !== currentUser?.id && (
                                <>
                                    <button
                                        className="btn-icon-sm"
                                        title="Set a new password"
                                        onClick={() => { setResetting(resetting === user.id ? null : user.id); setResetPassword(''); }}
                                    >
                                        <KeyRound size={16} />
                                    </button>
                                    <button
                                        className="btn-icon-sm"
                                        title="Delete user"
                                        onClick={() => handleDelete(user)}
                                    >
                                        <Trash2 size={16} />
                                    </button>
                                </>
                            )}
                        </div>
                        {resetting === user.id && (
                            <form className="user-reset" onSubmit={(e) => handleReset(e, user)}>
                                {/* Hidden username so a password manager files the new password under the right account */}
                                <input type="text" autoComplete="username" value={user.username} readOnly hidden />
                                <input
                                    type="password"
                                    autoComplete="new-password"
                                    placeholder="New password (8+ characters)"
                                    value={resetPassword}
                                    onChange={(e) => setResetPassword(e.target.value)}
                                    minLength={8}
                                    required
                                />
                                <button type="submit" className="btn btn-secondary">Set</button>
                            </form>
                        )}
                    </li>
                ))}
            </ul>

            <form className="user-create" onSubmit={handleCreate}>
                <div className="sync-field">
                    <label htmlFor="new-username">New user</label>
                    <input
                        id="new-username"
                        type="text"
                        autoComplete="off"
                        autoCapitalize="none"
                        spellCheck={false}
                        placeholder="Username"
                        value={newUser.username}
                        onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
                        required
                    />
                </div>
                <div className="sync-field">
                    <input
                        type="password"
                        autoComplete="new-password"
                        placeholder="Password (8+ characters)"
                        value={newUser.password}
                        onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                        minLength={8}
                        required
                    />
                </div>
                <div className="sync-actions-row">
                    <label className="user-admin-toggle">
                        <input
                            type="checkbox"
                            checked={newUser.role === 'admin'}
                            onChange={(e) => setNewUser({ ...newUser, role: e.target.checked ? 'admin' : 'user' })}
                        />
                        <Shield size={14} /> Admin
                    </label>
                    <button type="submit" className="btn btn-primary">
                        <UserPlus size={16} />
                        Add user
                    </button>
                </div>
            </form>

            <p className="sync-hint">
                Readers have their own reading progress and can add books. Admins can also
                rename, edit and delete books and manage users.
            </p>

            {error && (
                <div className="sync-result error">
                    <AlertCircle size={16} />
                    <span>{error}</span>
                </div>
            )}
            {notice && (
                <div className="sync-result success">
                    <Check size={16} />
                    <span>{notice}</span>
                </div>
            )}
        </div>
    );
};

export default UserManagement;
