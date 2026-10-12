/**
 * PulseReader Sync Service
 * Talks to the PulseReader server that serves this web app. There is nothing
 * to configure: the server is always this page's own origin, and signing in
 * sets an HttpOnly session cookie that every request carries.
 */

// Relative to the page, so the app also works behind a reverse proxy that
// mounts it under a sub-path (https://example.com/reader/).
const serverUrl = (endpoint) => new URL(endpoint.replace(/^\//, ''), document.baseURI).href;

/**
 * Make an authenticated request to the server
 */
async function syncFetch(endpoint, options = {}) {
    const headers = { ...options.headers };

    // Don't set Content-Type for FormData (browser sets it with boundary)
    if (!(options.body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(serverUrl(endpoint), {
        ...options,
        headers,
        credentials: 'same-origin',
    });

    if (!response.ok) {
        const error = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(error.error || `Server error: ${response.status}`);
    }

    return response;
}

let lastStatus = { available: false, authenticated: false };

/**
 * Is this page being served by a PulseReader server, and are we signed in?
 * Resolves { available, authenticated, version }. "available: false" means a
 * static copy (vite preview, offline from the PWA cache): the library still
 * works locally, there is just nothing to sync with.
 */
export async function getServerStatus() {
    try {
        const health = await fetch(serverUrl('/health'), { signal: AbortSignal.timeout(5000) })
            .then((r) => (r.ok ? r.json() : null));
        if (health?.app !== 'pulsereader') {
            lastStatus = { available: false, authenticated: false };
            return lastStatus;
        }
        const me = await fetch(serverUrl('/api/auth/me'), { credentials: 'same-origin' }).then((r) => r.json());
        lastStatus = {
            available: true,
            authenticated: !!me.authenticated,
            user: me.user || null,
            version: health.version,
        };
    } catch {
        // Offline or the server is restarting. Nothing is cleared: the session
        // cookie is untouched and the next check simply finds it again.
        lastStatus = { available: false, authenticated: false };
    }
    return lastStatus;
}

/**
 * The last known server status, without a round trip. Library uses it to
 * decide whether an edit should also be written to the server.
 */
export function isServerConnected() {
    return lastStatus.available && lastStatus.authenticated;
}

export function isAdmin() {
    return isServerConnected() && lastStatus.user?.role === 'admin';
}

// The account this device last synced as. Reading progress in IndexedDB is
// per device, so when someone else signs in here it has to be swapped out
// rather than merged into their account.
const LAST_USER_KEY = 'pulsereader-last-user';

export function getLastUser() {
    try { return localStorage.getItem(LAST_USER_KEY); } catch { return null; }
}

function setLastUser(username) {
    try { localStorage.setItem(LAST_USER_KEY, username); } catch { /* private mode */ }
}

export async function login(username, password) {
    const { user } = await syncFetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
    }).then((r) => r.json());

    // Offer the login to the browser's password manager. Browsers that watch
    // form submits already prompt; this covers the ones (Chrome on Android,
    // installed PWAs) that miss a fetch-based sign-in.
    try {
        if (window.PasswordCredential && navigator.credentials?.store) {
            await navigator.credentials.store(new window.PasswordCredential({ id: username, password, name: username }));
        }
    } catch { /* not supported or the user declined */ }

    const status = await getServerStatus();
    return { status, previousUser: getLastUser(), user };
}

/** Call once the device's local progress belongs to `username`. */
export function claimDevice(username) {
    setLastUser(username);
}

export async function logout() {
    await syncFetch('/api/auth/logout', { method: 'POST' });
    return getServerStatus();
}

export async function changePassword(currentPassword, newPassword) {
    await syncFetch('/api/auth/password', {
        method: 'PUT',
        body: JSON.stringify({ currentPassword, newPassword }),
    });
}

// ---- Admin: accounts ----

export const listUsers = () => syncFetch('/api/users').then((r) => r.json());

export const createUser = (username, password, role = 'user') =>
    syncFetch('/api/users', { method: 'POST', body: JSON.stringify({ username, password, role }) }).then((r) => r.json());

export const updateUser = (id, changes) =>
    syncFetch(`/api/users/${id}`, { method: 'PUT', body: JSON.stringify(changes) }).then((r) => r.json());

export const deleteUser = (id) =>
    syncFetch(`/api/users/${id}`, { method: 'DELETE' }).then((r) => r.json());

/**
 * Get sync status from server (all books + progress)
 */
export async function getSyncStatus() {
    const response = await syncFetch('/api/sync/status');
    return response.json();
}

/**
 * Get all books from the server
 */
export async function getServerBooks() {
    const response = await syncFetch('/api/books');
    return response.json();
}

/**
 * Download an epub file from the server
 */
export async function downloadBook(bookId) {
    const response = await syncFetch(`/api/books/${bookId}/download`);
    return response.arrayBuffer();
}

/**
 * Download a cover image from the server
 */
export async function downloadCover(bookId) {
    try {
        const response = await syncFetch(`/api/books/${bookId}/cover`);
        return response.blob();
    } catch {
        return null; // No cover available
    }
}

/**
 * Upload a book to the server
 */
export async function uploadBook(epubData, metadata) {
    const formData = new FormData();
    // Text fields MUST be appended before the file. Multer streams the parts in
    // order and its destination callback reads req.body.series to choose the
    // series folder -- with the epub first, req.body is still empty at that
    // point and every upload landed in books/Uncategorized/ regardless of
    // series.
    if (metadata.title) formData.append('title', metadata.title);
    if (metadata.author) formData.append('author', metadata.author);
    if (metadata.series) formData.append('series', metadata.series);
    formData.append('epub', new Blob([epubData], { type: 'application/epub+zip' }), metadata.filename || 'book.epub');
    if (metadata.cover) formData.append('cover', metadata.cover, 'cover.jpg');

    const response = await syncFetch('/api/books', {
        method: 'POST',
        body: formData,
    });
    return response.json();
}

/**
 * Upload a cover image for an existing book on the server
 */
export async function uploadCover(bookId, coverBlob) {
    const formData = new FormData();
    formData.append('cover', coverBlob, 'cover.jpg');

    const response = await syncFetch(`/api/books/${bookId}/cover`, {
        method: 'PUT',
        body: formData,
    });
    return response.json();
}

/**
 * Sync reading progress with the server (batch).
 * When `force` is true the server overwrites unconditionally (explicit push).
 */
export async function syncProgress(progressUpdates, force = false) {
    const response = await syncFetch('/api/sync/progress', {
        method: 'POST',
        body: JSON.stringify({ progress: progressUpdates, force }),
    });
    return response.json();
}

/**
 * Write one book's read-state and position straight to the server, so marking
 * a book read on one device doesn't wait for someone to remember to push.
 */
export async function pushBookState(book) {
    if (!book?.syncId || !isServerConnected()) return;
    // Read-state only. Sending this device's position along with it erased
    // the server's when this device had never opened the book (it sent "no
    // location, 0%"), and pushed a stale one when it had.
    await syncProgress([{
        book_id: book.syncId,
        is_read: !!book.isRead,
        read_state_only: true,
        updated_at: new Date().toISOString(),
    }], true);
}

/**
 * Match local books to server books by syncId, then title, then file size.
 * Returns [{ localBook, serverBook }] with each server book matched once.
 */
function matchLocalToServer(localBooks, serverBooks) {
    const serverById = new Map();
    const serverByTitle = new Map();
    const serverByFileSize = new Map();
    for (const book of serverBooks) {
        serverById.set(book.id, book);
        if (book.title) serverByTitle.set(book.title.toLowerCase(), book);
        if (book.file_size) serverByFileSize.set(book.file_size, book);
    }

    const matchedServerIds = new Set();
    const pairs = [];
    for (const localBook of localBooks) {
        let serverBook = null;
        if (localBook.syncId && serverById.has(localBook.syncId)) {
            serverBook = serverById.get(localBook.syncId);
        }
        if (!serverBook && localBook.title) {
            const key = localBook.title.toLowerCase();
            if (serverByTitle.has(key) && !matchedServerIds.has(serverByTitle.get(key).id)) {
                serverBook = serverByTitle.get(key);
            }
        }
        if (!serverBook && localBook.data) {
            const localSize = localBook.data.byteLength || localBook.data.size || 0;
            if (localSize > 0 && serverByFileSize.has(localSize) && !matchedServerIds.has(serverByFileSize.get(localSize).id)) {
                serverBook = serverByFileSize.get(localSize);
            }
        }
        if (serverBook && !matchedServerIds.has(serverBook.id)) {
            pairs.push({ localBook, serverBook });
            matchedServerIds.add(serverBook.id);
        }
    }
    return pairs;
}

/**
 * PUSH — send local reading progress + read-state up to the server.
 * Progress only: never uploads/downloads book files. The server takes the
 * local state as truth (force overwrite).
 */
export async function pushProgress(localBooks, updateBookFn) {
    if (!isServerConnected()) {
        return { synced: false, reason: 'Not signed in to the PulseReader server' };
    }

    const result = { pushed: 0, errors: [] };
    try {
        const serverStatus = await getSyncStatus();
        const pairs = matchLocalToServer(localBooks, serverStatus.books);

        const updates = [];
        for (const { localBook, serverBook } of pairs) {
            // Link the local book to its server id for future syncs.
            if (!localBook.syncId && updateBookFn) {
                try { await updateBookFn(localBook.id, { syncId: serverBook.id }); } catch { /* ignore */ }
            }
            // Only push books this device actually knows something about.
            //
            // The server applies these with forceUpsert, which overwrites
            // unconditionally -- that is the point of Push. But a book this
            // device has never opened has no progress row at all (addBook only
            // seeds one when there is something to seed), so it arrives here as
            // progress undefined / lastRead undefined and would be sent as
            // "0%, no location, unread", silently erasing a position another
            // device set. Pushing a genuine reset still works: a book you have
            // opened has a lastRead, so it passes this guard.
            const hasLocalState =
                (localBook.progress ?? 0) > 0 || localBook.isRead || !!localBook.lastRead;
            if (!hasLocalState) continue;

            updates.push({
                book_id: serverBook.id,
                location: localBook.lastRead || null,
                progress: localBook.progress || 0,
                is_read: localBook.isRead || false,
                updated_at: new Date().toISOString(),
            });
        }

        if (updates.length > 0) {
            await syncProgress(updates, true);
            result.pushed = updates.length;
        }
        return { synced: true, ...result };
    } catch (err) {
        return { synced: false, reason: err.message, ...result };
    }
}

/**
 * PULL — take the server's reading progress + read-state down to local.
 * Progress only: never uploads/downloads book files. For matched books that
 * have a progress row on the server, local is overwritten to mirror it
 * (so read-state can also be cleared from another device).
 */
export async function pullProgress(localBooks, updateProgressFn, updateBookFn) {
    if (!isServerConnected()) {
        return { synced: false, reason: 'Not signed in to the PulseReader server' };
    }

    const result = { pulled: 0, errors: [] };
    try {
        const serverStatus = await getSyncStatus();
        const pairs = matchLocalToServer(localBooks, serverStatus.books);

        for (const { localBook, serverBook } of pairs) {
            if (!localBook.syncId && updateBookFn) {
                try { await updateBookFn(localBook.id, { syncId: serverBook.id }); } catch { /* ignore */ }
            }

            // A non-null progress timestamp means the server actually has a
            // reading_progress row for this book.
            const hasServerRow = serverBook.progress_updated_at != null;
            if (!hasServerRow) continue;

            try {
                // A row can hold read-state alone (marked read on a device
                // that never opened the book). Then there is no position to
                // take, and writing its 0% would reset this device's.
                if (serverBook.last_read) {
                    await updateProgressFn(localBook.id, serverBook.last_read, serverBook.progress || 0);
                }
                await updateBookFn(localBook.id, { isRead: serverBook.is_read === 1 });
                result.pulled++;
            } catch (err) {
                result.errors.push(`Failed to update "${localBook.title}": ${err.message}`);
            }
        }
        return { synced: true, ...result };
    } catch (err) {
        return { synced: false, reason: err.message, ...result };
    }
}

/**
 * Trigger a rescan of the books folder on the server
 */
export async function triggerRescan() {
    const response = await syncFetch('/api/sync/rescan', { method: 'POST' });
    return response.json();
}

/**
 * Rename a series on the server (moves files on disk + updates DB)
 */
export async function renameSeries(oldName, newName) {
    const response = await syncFetch('/api/books/series/rename', {
        method: 'PUT',
        body: JSON.stringify({ oldName, newName }),
    });
    return response.json();
}

/**
 * Update a book's metadata on the server
 */
export async function updateServerBook(bookId, updates) {
    const response = await syncFetch(`/api/books/${bookId}`, {
        method: 'PUT',
        body: JSON.stringify(updates),
    });
    return response.json();
}

/**
 * Full sync operation — SERVER IS SOURCE OF TRUTH for the book catalog.
 *
 * 0. Trigger server rescan so the DB reflects current disk state
 * 1. Get server book list
 * 2. Match local books to server books (by syncId, title, or file size)
 * 3. Update local metadata from server for matched books
 * 4. Upload local covers to server for matched books missing server covers
 * 5. Download new server books not found locally
 * 6. Upload truly new local books (no syncId = never been on server) to server
 * 7. Delete local books that have a syncId but no longer exist on server (server deleted them)
 * 8. Sync reading progress
 */
export async function performFullSync(localBooks, addBookFn, updateProgressFn, updateBookFn, deleteBookFn) {
    if (!isServerConnected()) {
        return { synced: false, reason: 'Not signed in to the PulseReader server' };
    }

    const results = {
        downloaded: 0,
        uploaded: 0,
        updated: 0,
        deleted: 0,
        coversUploaded: 0,
        progressSynced: 0,
        errors: [],
    };

    try {
        // Trigger a rescan first so the server DB reflects current disk state
        // (handles renamed/moved/deleted files on the server)
        try {
            await triggerRescan();
        } catch (err) {
            console.warn('Server rescan failed, continuing with existing state:', err.message);
        }

        // Get server state (now up-to-date after rescan)
        const serverStatus = await getSyncStatus();
        const serverBooks = serverStatus.books;

        // Build server lookup maps
        const serverById = new Map();
        const serverByTitle = new Map();
        const serverByFileSize = new Map();
        for (const book of serverBooks) {
            serverById.set(book.id, book);
            serverByTitle.set(book.title.toLowerCase(), book);
            if (book.file_size) {
                serverByFileSize.set(book.file_size, book);
            }
        }

        // Track which server books and local books are matched
        const matchedServerIds = new Set();
        const matchedLocalIds = new Set();

        // Match books: by syncId first, then title, then file size
        const matchedPairs = []; // { localBook, serverBook }

        for (const localBook of localBooks) {
            let serverBook = null;

            // Try matching by syncId first (most reliable)
            if (localBook.syncId && serverById.has(localBook.syncId)) {
                serverBook = serverById.get(localBook.syncId);
            }

            // Fall back to title matching
            if (!serverBook) {
                const key = localBook.title.toLowerCase();
                if (serverByTitle.has(key) && !matchedServerIds.has(serverByTitle.get(key).id)) {
                    serverBook = serverByTitle.get(key);
                }
            }

            // Fall back to file size matching (handles renamed books)
            if (!serverBook && localBook.data) {
                const localSize = localBook.data.byteLength || localBook.data.size || 0;
                if (localSize > 0 && serverByFileSize.has(localSize) && !matchedServerIds.has(serverByFileSize.get(localSize).id)) {
                    serverBook = serverByFileSize.get(localSize);
                }
            }

            if (serverBook && !matchedServerIds.has(serverBook.id)) {
                matchedPairs.push({ localBook, serverBook });
                matchedServerIds.add(serverBook.id);
                matchedLocalIds.add(localBook.id);
            }
        }

        // --- Step 1: Update local metadata from server for matched books ---
        for (const { localBook, serverBook } of matchedPairs) {
            const updates = {};

            if (!localBook.syncId) {
                updates.syncId = serverBook.id;
            }

            if (serverBook.title && serverBook.title !== localBook.title) {
                updates.title = serverBook.title;
            }

            if (serverBook.author && serverBook.author !== localBook.author) {
                updates.author = serverBook.author;
            }

            if (serverBook.series && serverBook.series !== localBook.series) {
                updates.series = serverBook.series;
            }

            // Sync isRead from server if server has it marked as read
            if (serverBook.is_read && !localBook.isRead) {
                updates.isRead = true;
            }

            if (!localBook.cover && serverBook.cover_path) {
                try {
                    const cover = await downloadCover(serverBook.id);
                    if (cover) {
                        updates.cover = cover;
                    }
                } catch { /* ignore */ }
            }

            if (Object.keys(updates).length > 0) {
                try {
                    await updateBookFn(localBook.id, updates);
                    results.updated++;
                } catch (err) {
                    results.errors.push(`Failed to update "${localBook.title}": ${err.message}`);
                }
            }

            // Upload local cover to server if server has no cover but local does
            if (localBook.cover && !serverBook.cover_path) {
                try {
                    await uploadCover(serverBook.id, localBook.cover);
                    results.coversUploaded++;
                } catch (err) {
                    results.errors.push(`Failed to upload cover for "${localBook.title}": ${err.message}`);
                }
            }
        }

        // --- Step 2: Download books that exist on server but not locally ---
        for (const serverBook of serverBooks) {
            if (matchedServerIds.has(serverBook.id)) continue;

            try {
                const epubData = await downloadBook(serverBook.id);
                const cover = await downloadCover(serverBook.id);

                await addBookFn({
                    title: serverBook.title,
                    author: serverBook.author || 'Unknown Author',
                    series: serverBook.series,
                    cover: cover,
                    data: epubData,
                    progress: serverBook.progress || 0,
                    lastRead: serverBook.last_read || null,
                    isRead: serverBook.is_read === 1,
                    syncId: serverBook.id,
                });

                results.downloaded++;
            } catch (err) {
                results.errors.push(`Failed to download "${serverBook.title}": ${err.message}`);
            }
        }

        // --- Step 3: Handle unmatched local books ---
        //
        // Deleting here is the destructive half of sync: deleteBookFn drops the
        // epub blob, the progress record and the locations cache. An empty (or
        // suspiciously small) server list is far more likely to mean the server
        // could not see its books volume than that the user deleted their
        // library, so refuse to mirror that emptiness. Without this, one boot
        // scan against an unmounted volume plus one Full Sync erases every
        // reading position on the device too.
        const previouslySynced = localBooks.filter((b) => b.syncId).length;
        const deletionsWouldBe = localBooks.filter(
            (b) => b.syncId && !matchedLocalIds.has(b.id)
        ).length;
        const wipingEverything = previouslySynced > 0 && deletionsWouldBe === previouslySynced;
        const skipDeletions = serverBooks.length === 0 || wipingEverything;

        if (skipDeletions && deletionsWouldBe > 0) {
            results.errors.push(
                `Skipped removing ${deletionsWouldBe} local book(s): the server reported ` +
                `${serverBooks.length} book(s), which would have deleted everything previously ` +
                'synced. Check the server can see its books folder, then sync again.'
            );
        }

        for (const localBook of localBooks) {
            if (matchedLocalIds.has(localBook.id)) continue;

            if (localBook.syncId) {
                // This book was previously synced but no longer exists on server → delete locally
                if (skipDeletions) continue;
                try {
                    await deleteBookFn(localBook.id);
                    results.deleted++;
                } catch (err) {
                    results.errors.push(`Failed to delete "${localBook.title}": ${err.message}`);
                }
            } else {
                // This book was added locally and never synced → upload to server
                try {
                    const serverResult = await uploadBook(localBook.data, {
                        title: localBook.title,
                        author: localBook.author,
                        series: localBook.series || 'Uncategorized',
                        filename: `${localBook.title}.epub`,
                        cover: localBook.cover,
                    });

                    if (serverResult?.id) {
                        try {
                            await updateBookFn(localBook.id, { syncId: serverResult.id });
                        } catch { /* ignore */ }
                    }

                    results.uploaded++;
                } catch (err) {
                    results.errors.push(`Failed to upload "${localBook.title}": ${err.message}`);
                }
            }
        }

        // --- Step 4: Sync reading progress ---
        const progressUpdates = [];
        for (const { localBook, serverBook } of matchedPairs) {
            if (localBook.progress > 0 || localBook.isRead) {
                progressUpdates.push({
                    book_id: serverBook.id,
                    location: localBook.lastRead,
                    progress: localBook.progress,
                    is_read: localBook.isRead || false,
                    updated_at: new Date().toISOString(),
                });
            }
        }

        // Always call syncProgress (even with empty array) so we receive
        // the server's current state, including is_read flags set by other devices
        const syncResult = await syncProgress(progressUpdates);

        if (syncResult.progress) {
            for (const serverProgress of syncResult.progress) {
                const matched = matchedPairs.find((p) => p.serverBook.id === serverProgress.book_id);
                if (!matched) continue;

                // Update local progress if server has higher progress
                if (serverProgress.progress > matched.localBook.progress) {
                    await updateProgressFn(matched.localBook.id, serverProgress.location, serverProgress.progress);
                    results.progressSynced++;
                }

                // Update local isRead if server has it marked as read
                if (serverProgress.is_read && !matched.localBook.isRead) {
                    await updateBookFn(matched.localBook.id, { isRead: true });
                    results.progressSynced++;
                }
            }
        }

        return { synced: true, ...results };
    } catch (err) {
        return { synced: false, reason: err.message, ...results };
    }
}
