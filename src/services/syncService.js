/**
 * PulseReader Sync Service
 * Handles communication with the self-hosted sync server.
 */

const SYNC_CONFIG_KEY = 'pulsereader-sync-config';

/**
 * Get sync configuration from localStorage
 */
export function getSyncConfig() {
    try {
        const config = localStorage.getItem(SYNC_CONFIG_KEY);
        if (config) {
            return JSON.parse(config);
        }
    } catch (err) {
        console.error('Failed to read sync config:', err);
    }
    return { serverUrl: '', apiKey: '', enabled: false, autoSync: false };
}

/**
 * Save sync configuration to localStorage
 */
export function saveSyncConfig(config) {
    localStorage.setItem(SYNC_CONFIG_KEY, JSON.stringify(config));
}

/**
 * Make an authenticated request to the sync server
 */
async function syncFetch(endpoint, options = {}) {
    const config = getSyncConfig();
    if (!config.serverUrl) {
        throw new Error('Sync server not configured');
    }

    const url = `${config.serverUrl.replace(/\/$/, '')}${endpoint}`;
    const headers = {
        ...options.headers,
    };

    if (config.apiKey) {
        headers['X-API-Key'] = config.apiKey;
    }

    // Don't set Content-Type for FormData (browser sets it with boundary)
    if (!(options.body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(url, {
        ...options,
        headers,
    });

    if (!response.ok) {
        const error = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(error.error || `Server error: ${response.status}`);
    }

    return response;
}

/**
 * Test connection to the sync server
 */
export async function testConnection(serverUrl, apiKey) {
    try {
        const url = `${serverUrl.replace(/\/$/, '')}/health`;
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error('Server not reachable');

        const health = await response.json();
        if (health.status !== 'ok') throw new Error('Server unhealthy');

        // Test auth if API key provided
        if (apiKey) {
            const authResponse = await fetch(`${serverUrl.replace(/\/$/, '')}/api/sync/status`, {
                headers: { 'X-API-Key': apiKey },
                signal: AbortSignal.timeout(5000),
            });
            if (!authResponse.ok) throw new Error('Authentication failed');
        }

        return { success: true, version: health.version };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

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
    formData.append('epub', new Blob([epubData], { type: 'application/epub+zip' }), metadata.filename || 'book.epub');
    if (metadata.title) formData.append('title', metadata.title);
    if (metadata.author) formData.append('author', metadata.author);
    if (metadata.series) formData.append('series', metadata.series);
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
 * Sync reading progress with the server (batch)
 */
export async function syncProgress(progressUpdates) {
    const response = await syncFetch('/api/sync/progress', {
        method: 'POST',
        body: JSON.stringify({ progress: progressUpdates }),
    });
    return response.json();
}

/**
 * Trigger a rescan of the books folder on the server
 */
export async function triggerRescan() {
    const response = await syncFetch('/api/sync/rescan', { method: 'POST' });
    return response.json();
}

/**
 * Full sync operation:
 * 1. Get server book list
 * 2. Compare with local books (by syncId first, then by title)
 * 3. Update local metadata from server for matched books (title, author, series)
 * 4. Upload local covers to server for matched books missing server covers
 * 5. Download new books from server
 * 6. Upload local-only books to server
 * 7. Sync reading progress (last-write-wins)
 */
export async function performFullSync(localBooks, addBookFn, updateProgressFn, updateBookFn) {
    const config = getSyncConfig();
    if (!config.serverUrl) {
        return { synced: false, reason: 'Sync server URL not configured' };
    }

    const results = {
        downloaded: 0,
        uploaded: 0,
        updated: 0,
        coversUploaded: 0,
        progressSynced: 0,
        errors: [],
    };

    try {
        // Get server state
        const serverStatus = await getSyncStatus();
        const serverBooks = serverStatus.books;

        // Build lookup maps
        const serverById = new Map();
        const serverByTitle = new Map();
        const serverByFileSize = new Map();
        for (const book of serverBooks) {
            serverById.set(book.id, book);
            serverByTitle.set(book.title.toLowerCase(), book);
            // Use file_size for fuzzy matching (titles may have been renamed)
            if (book.file_size) {
                serverByFileSize.set(book.file_size, book);
            }
        }

        const localBySyncId = new Map();
        const localByTitle = new Map();
        for (const book of localBooks) {
            if (book.syncId) {
                localBySyncId.set(book.syncId, book);
            }
            localByTitle.set(book.title.toLowerCase(), book);
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

        // Update local metadata from server for matched books
        for (const { localBook, serverBook } of matchedPairs) {
            const updates = {};

            // Update syncId if not set
            if (!localBook.syncId) {
                updates.syncId = serverBook.id;
            }

            // Update title if changed on server
            if (serverBook.title && serverBook.title !== localBook.title) {
                updates.title = serverBook.title;
            }

            // Update author if changed on server
            if (serverBook.author && serverBook.author !== localBook.author) {
                updates.author = serverBook.author;
            }

            // Update series if changed on server
            if (serverBook.series && serverBook.series !== localBook.series) {
                updates.series = serverBook.series;
            }

            // Download cover from server if local book has no cover but server does
            if (!localBook.cover && serverBook.cover_path) {
                try {
                    const cover = await downloadCover(serverBook.id);
                    if (cover) {
                        updates.cover = cover;
                    }
                } catch { /* ignore cover download failures */ }
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

        // Download books that exist on server but not locally
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
                    syncId: serverBook.id,
                });

                results.downloaded++;
            } catch (err) {
                results.errors.push(`Failed to download "${serverBook.title}": ${err.message}`);
            }
        }

        // Upload books that exist locally but not on server
        for (const localBook of localBooks) {
            if (matchedLocalIds.has(localBook.id)) continue;

            try {
                const serverResult = await uploadBook(localBook.data, {
                    title: localBook.title,
                    author: localBook.author,
                    series: localBook.series || 'Uncategorized',
                    filename: `${localBook.title}.epub`,
                    cover: localBook.cover,
                });

                // Store the server ID locally for future syncs
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

        // Sync reading progress
        const progressUpdates = [];
        for (const { localBook, serverBook } of matchedPairs) {
            if (localBook.progress > 0) {
                progressUpdates.push({
                    book_id: serverBook.id,
                    location: localBook.lastRead,
                    progress: localBook.progress,
                    updated_at: new Date().toISOString(),
                });
            }
        }

        if (progressUpdates.length > 0) {
            const syncResult = await syncProgress(progressUpdates);

            // Apply server progress back to local books
            if (syncResult.progress) {
                for (const serverProgress of syncResult.progress) {
                    const matched = matchedPairs.find((p) => p.serverBook.id === serverProgress.book_id);
                    if (!matched) continue;

                    if (serverProgress.progress > matched.localBook.progress) {
                        await updateProgressFn(matched.localBook.id, serverProgress.location, serverProgress.progress);
                        results.progressSynced++;
                    }
                }
            }
        }

        return { synced: true, ...results };
    } catch (err) {
        return { synced: false, reason: err.message, ...results };
    }
}
