import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    Server,
    RefreshCw,
    Check,
    X,
    AlertCircle,
    Download,
    Upload,
    Eye,
    EyeOff,
    LogIn,
    LogOut,
    KeyRound,
} from 'lucide-react';
import {
    login,
    logout,
    claimDevice,
    changePassword,
    performFullSync,
    pushProgress,
    pullProgress,
    triggerRescan,
} from '../services/syncService';
import { addBook, updateBookProgress, updateBook, deleteBook, resetAllProgress } from '../services/db';
import UserManagement from './UserManagement';

const SyncSettings = ({ books, serverStatus, onStatusChange, onSyncComplete, onClose }) => {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [signingIn, setSigningIn] = useState(false);
    const [authError, setAuthError] = useState(null);
    const [syncing, setSyncing] = useState(false);
    const [syncResult, setSyncResult] = useState(null);
    const [changingPassword, setChangingPassword] = useState(false);
    const [passwords, setPasswords] = useState({ current: '', next: '' });
    const [passwordNotice, setPasswordNotice] = useState(null);
    const connected = serverStatus.authenticated;
    const user = serverStatus.user;

    const pullIntoDevice = () => pullProgress(
        books,
        (id, location, progress, at) => updateBookProgress(id, location, progress, at),
        (id, updates) => updateBook(id, updates),
    );

    const handleLogin = async (e) => {
        e.preventDefault();
        setSigningIn(true);
        setAuthError(null);
        try {
            const { status, previousUser, user: signedIn } = await login(username.trim(), password);
            setPassword('');

            // This device's progress belongs to whoever synced here last. If
            // that was someone else, swap it for this account's progress,
            // otherwise a Push or Full Sync would copy their place in every
            // book into this account.
            const switching = previousUser && previousUser.toLowerCase() !== signedIn.username.toLowerCase();
            if (switching && books.length > 0) {
                const replace = window.confirm(
                    `This device has ${previousUser}'s reading progress. Replace it with ${signedIn.username}'s?\n\n` +
                    `Choose Cancel to keep the progress on this device and add it to ${signedIn.username}'s account.`
                );
                if (replace) {
                    await resetAllProgress();
                    await pullIntoDevice();
                    onSyncComplete?.({ synced: true });
                }
            }
            claimDevice(signedIn.username);
            onStatusChange(status);
        } catch (err) {
            setAuthError(err.message);
        }
        setSigningIn(false);
    };

    const handleLogout = async () => {
        setAuthError(null);
        try {
            // Save where this device is up to before the account goes, so the
            // next person to sign in here can't lose it.
            await pushProgress(books, (id, updates) => updateBook(id, updates));
            onStatusChange(await logout());
        } catch (err) {
            setAuthError(err.message);
        }
    };

    const handleChangePassword = async (e) => {
        e.preventDefault();
        setAuthError(null);
        setPasswordNotice(null);
        try {
            await changePassword(passwords.current, passwords.next);
            setPasswords({ current: '', next: '' });
            setChangingPassword(false);
            setPasswordNotice('Password changed. Other devices have been signed out.');
        } catch (err) {
            setAuthError(err.message);
        }
    };

    const handleSync = async () => {
        setSyncing(true);
        setSyncResult(null);

        try {
            const result = await performFullSync(
                books,
                async (bookData) => {
                    const id = await addBook(bookData);
                    return id;
                },
                async (id, location, progress, at) => {
                    await updateBookProgress(id, location, progress, at);
                },
                async (id, updates) => {
                    await updateBook(id, updates);
                },
                async (id) => {
                    await deleteBook(id);
                }
            );

            setSyncResult(result);
            if (result.synced && onSyncComplete) {
                onSyncComplete(result);
            }
        } catch (err) {
            setSyncResult({ synced: false, reason: err.message });
        }

        setSyncing(false);
    };

    const handlePush = async () => {
        setSyncing(true);
        setSyncResult(null);
        try {
            const result = await pushProgress(books, async (id, updates) => {
                await updateBook(id, updates);
            });
            setSyncResult(
                result.synced
                    ? { synced: true, message: `Pushed progress for ${result.pushed} book(s)`, errors: result.errors }
                    : result
            );
            if (result.synced && onSyncComplete) onSyncComplete(result);
        } catch (err) {
            setSyncResult({ synced: false, reason: err.message });
        }
        setSyncing(false);
    };

    const handlePull = async () => {
        setSyncing(true);
        setSyncResult(null);
        try {
            const result = await pullProgress(
                books,
                async (id, location, progress, at) => {
                    await updateBookProgress(id, location, progress, at);
                },
                async (id, updates) => {
                    await updateBook(id, updates);
                }
            );
            setSyncResult(
                result.synced
                    ? {
                        synced: true,
                        message: `Pulled progress for ${result.pulled} book(s)` +
                            (result.keptLocal ? `; kept this device's newer progress for ${result.keptLocal}` : ''),
                        errors: result.errors,
                    }
                    : result
            );
            if (result.synced && onSyncComplete) onSyncComplete(result);
        } catch (err) {
            setSyncResult({ synced: false, reason: err.message });
        }
        setSyncing(false);
    };

    const handleRescan = async () => {
        setSyncing(true);
        try {
            const result = await triggerRescan();
            setSyncResult({
                synced: true,
                downloaded: 0,
                uploaded: 0,
                progressSynced: 0,
                errors: [],
                message: `Server rescanned: ${result.book_count} books found`,
            });
        } catch (err) {
            setSyncResult({ synced: false, reason: err.message });
        }
        setSyncing(false);
    };

    return (
        <motion.div
            className="sync-settings-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
        >
            <motion.div
                className="sync-settings-panel"
                initial={{ x: '100%' }}
                animate={{ x: 0 }}
                exit={{ x: '100%' }}
                transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            >
                <div className="sync-settings-header">
                    <h2>
                        <Server size={20} />
                        Sync Server
                    </h2>
                    <button className="btn-icon" onClick={onClose}>
                        <X size={20} />
                    </button>
                </div>

                <div className="sync-settings-content">
                    {/* Account: the server is this app's own host, so all
                        there is to set up is signing in once per device. */}
                    <div className="sync-section">
                        <h3>Account</h3>

                        {/* Browsers only allow a service worker (the offline
                            copy of the app) and "install app" on HTTPS or
                            localhost. Say so, rather than letting the app
                            quietly fail to open on the next flight. */}
                        {!window.isSecureContext && (
                            <div className="sync-result error">
                                <AlertCircle size={16} />
                                <span>
                                    This page uses plain HTTP, so the app can't open without a connection and
                                    can't be installed. Your downloaded books are kept either way. Serve it over
                                    HTTPS (Tailscale or a Cloudflare Tunnel, see the README) for offline reading.
                                </span>
                            </div>
                        )}

                        {connected ? (
                            <>
                                <div className="sync-actions-row">
                                    <div className="sync-result success">
                                        <Check size={16} />
                                        <span>
                                            Signed in as <b>{user?.username}</b>
                                            {user?.role === 'admin' ? ' (admin)' : ''}
                                        </span>
                                    </div>
                                    <button className="btn btn-secondary" onClick={handleLogout}>
                                        <LogOut size={16} />
                                        Sign out
                                    </button>
                                </div>

                                {changingPassword ? (
                                    <form className="sync-password-form" onSubmit={handleChangePassword}>
                                        <input type="text" autoComplete="username" value={user?.username || ''} readOnly hidden />
                                        <div className="sync-field">
                                            <input
                                                type="password"
                                                autoComplete="current-password"
                                                placeholder="Current password"
                                                value={passwords.current}
                                                onChange={(e) => setPasswords({ ...passwords, current: e.target.value })}
                                                required
                                            />
                                        </div>
                                        <div className="sync-field">
                                            <input
                                                type="password"
                                                autoComplete="new-password"
                                                placeholder="New password (8+ characters)"
                                                value={passwords.next}
                                                onChange={(e) => setPasswords({ ...passwords, next: e.target.value })}
                                                minLength={8}
                                                required
                                            />
                                        </div>
                                        <div className="sync-actions-row">
                                            <button type="button" className="btn btn-secondary" onClick={() => setChangingPassword(false)}>
                                                Cancel
                                            </button>
                                            <button type="submit" className="btn btn-primary">
                                                <KeyRound size={16} />
                                                Change password
                                            </button>
                                        </div>
                                    </form>
                                ) : (
                                    <button className="btn btn-secondary btn-full" onClick={() => setChangingPassword(true)}>
                                        <KeyRound size={16} />
                                        Change password
                                    </button>
                                )}

                                {passwordNotice && (
                                    <div className="sync-result success">
                                        <Check size={16} />
                                        <span>{passwordNotice}</span>
                                    </div>
                                )}
                            </>
                        ) : (
                            // A real <form> with name + autocomplete attributes, so
                            // password managers offer to save and fill it.
                            <form onSubmit={handleLogin} action="#" method="post">
                                <div className="sync-field">
                                    <label htmlFor="sync-username">Username</label>
                                    <input
                                        id="sync-username"
                                        name="username"
                                        type="text"
                                        autoComplete="username"
                                        autoCapitalize="none"
                                        spellCheck={false}
                                        value={username}
                                        onChange={(e) => setUsername(e.target.value)}
                                        required
                                    />
                                </div>
                                <div className="sync-field">
                                    <label htmlFor="sync-password">Password</label>
                                    <div className="sync-field-with-toggle">
                                        <input
                                            id="sync-password"
                                            name="password"
                                            type={showPassword ? 'text' : 'password'}
                                            autoComplete="current-password"
                                            value={password}
                                            onChange={(e) => setPassword(e.target.value)}
                                            required
                                        />
                                        <button
                                            type="button"
                                            className="btn-icon-sm"
                                            onClick={() => setShowPassword(!showPassword)}
                                            aria-label={showPassword ? 'Hide password' : 'Show password'}
                                        >
                                            {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                                        </button>
                                    </div>
                                </div>
                                <button
                                    type="submit"
                                    className="btn btn-primary btn-full"
                                    disabled={signingIn || !username.trim() || !password}
                                >
                                    {signingIn ? <RefreshCw size={16} className="spinning" /> : <LogIn size={16} />}
                                    {signingIn ? 'Signing in...' : 'Sign in'}
                                </button>
                                <p className="sync-hint">You stay signed in on this device until you sign out.</p>
                            </form>
                        )}

                        {authError && (
                            <div className="sync-result error">
                                <AlertCircle size={16} />
                                <span>{authError}</span>
                            </div>
                        )}
                    </div>


                    {connected && (<>
                    {/* Progress: explicit Push / Pull (no automatic sync on open) */}
                    <div className="sync-section">
                        <h3>Reading Progress</h3>
                        <p className="sync-hint">
                            Nothing syncs automatically. Pull and Full Sync keep whichever was read
                            most recently, per book, so reading done offline is never lost. Push makes
                            the server match this device.
                        </p>

                        <div className="sync-actions-row">
                            <button
                                className="btn btn-primary btn-full"
                                onClick={handlePush}
                                disabled={syncing}
                                title="Make the server match this device's reading positions and read-state"
                            >
                                <Upload size={16} />
                                Push progress
                            </button>

                            <button
                                className="btn btn-secondary btn-full"
                                onClick={handlePull}
                                disabled={syncing}
                                title="Load positions and read-state from the server where they are newer than this device's"
                            >
                                <Download size={16} />
                                Pull progress
                            </button>
                        </div>
                    </div>

                    {/* Library: book files + metadata (explicit only) */}
                    <div className="sync-section">
                        <h3>Library (books)</h3>

                        <div className="sync-actions-col">
                            <button
                                className="btn btn-secondary btn-full"
                                onClick={handleSync}
                                disabled={syncing}
                                title="Download new server books, upload new local books, and reconcile metadata"
                            >
                                {syncing ? (
                                    <RefreshCw size={16} className="spinning" />
                                ) : (
                                    <RefreshCw size={16} />
                                )}
                                {syncing ? 'Syncing...' : 'Full Sync (books + metadata)'}
                            </button>

                            <button
                                className="btn btn-secondary btn-full"
                                onClick={handleRescan}
                                disabled={syncing}
                            >
                                <RefreshCw size={16} />
                                Rescan Server Books Folder
                            </button>
                        </div>

                        {/* Sync Result */}
                        <AnimatePresence>
                            {syncResult && (
                                <motion.div
                                    className={`sync-result ${syncResult.synced ? 'success' : 'error'}`}
                                    initial={{ opacity: 0, y: -10 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0 }}
                                >
                                    {syncResult.synced ? (
                                        <div className="sync-result-details">
                                            <Check size={16} />
                                            <div>
                                                <p>Sync complete!</p>
                                                {syncResult.message && <p>{syncResult.message}</p>}
                                                {syncResult.downloaded > 0 && (
                                                    <p>
                                                        <Download size={12} /> {syncResult.downloaded} books downloaded
                                                    </p>
                                                )}
                                                {syncResult.uploaded > 0 && (
                                                    <p>
                                                        <Upload size={12} /> {syncResult.uploaded} books uploaded
                                                    </p>
                                                )}
                                                {syncResult.updated > 0 && (
                                                    <p>{syncResult.updated} books updated from server</p>
                                                )}
                                                {syncResult.deleted > 0 && (
                                                    <p>{syncResult.deleted} books removed (deleted from server)</p>
                                                )}
                                                {syncResult.coversUploaded > 0 && (
                                                    <p>{syncResult.coversUploaded} covers uploaded to server</p>
                                                )}
                                                {syncResult.progressSynced > 0 && (
                                                    <p>{syncResult.progressSynced} progress updates synced</p>
                                                )}
                                                {syncResult.errors?.length > 0 && (
                                                    <div className="sync-errors">
                                                        {syncResult.errors.map((err, i) => (
                                                            <p key={i} className="sync-error-item">⚠ {err}</p>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    ) : (
                                        <>
                                            <AlertCircle size={16} />
                                            <span>{syncResult.reason}</span>
                                        </>
                                    )}
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>
                    </>)}

                    {connected && user?.role === 'admin' && <UserManagement currentUser={user} />}

                    {/* Info */}
                    <div className="sync-section sync-info">
                        <h3>Adding books on the server</h3>
                        <p>
                            Drop epub files into the server's books folder, one folder per series,
                            then use Full Sync:
                        </p>
                        <pre className="sync-folder-structure">
{`books/
  Series Name/
    cover.jpg        (optional)
    Volume 1.epub
    Volume 2.epub
  Another Series/
    Book.epub
    Book.jpg         (optional cover)`}
                        </pre>
                    </div>
                </div>
            </motion.div>
        </motion.div>
    );
};

export default SyncSettings;
