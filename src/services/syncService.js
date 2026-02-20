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
 * 2. Compare with local books
 * 3. Download new books from server
 * 4. Upload local-only books to server
 * 5. Sync reading progress (last-write-wins)
 */
export async function performFullSync(localBooks, addBookFn, updateProgressFn) {
    const config = getSyncConfig();
    if (!config.serverUrl) {
        return { synced: false, reason: 'Sync server URL not configured' };
    }

    const results = {
        downloaded: 0,
        uploaded: 0,
        progressSynced: 0,
        errors: [],
    };

    try {
        // Get server state
        const serverStatus = await getSyncStatus();
        const serverBooks = serverStatus.books;

        // Build lookup maps
        const serverByTitle = new Map();
        for (const book of serverBooks) {
            serverByTitle.set(book.title.toLowerCase(), book);
        }

        const localByTitle = new Map();
        for (const book of localBooks) {
            localByTitle.set(book.title.toLowerCase(), book);
        }

        // Download books that exist on server but not locally
        for (const serverBook of serverBooks) {
            const key = serverBook.title.toLowerCase();
            if (!localByTitle.has(key)) {
                try {
                    const epubData = await downloadBook(serverBook.id);
                    let cover = await downloadCover(serverBook.id);

                    // If no cover from server, extract from epub
                    if (!cover) {
                        try {
                            const { default: ePub } = await import('epubjs');
                            const book = ePub(epubData);
                            await book.ready;
                            const coverUrl = await book.coverUrl();
                            if (coverUrl) {
                                const response = await fetch(coverUrl);
                                cover = await response.blob();
                            }
                            book.destroy();
                        } catch (coverErr) {
                            console.warn('Could not extract cover from epub:', coverErr);
                        }
                    }

                    // Extract author from epub if server has "Unknown Author"
                    let author = serverBook.author;
                    if (!author || author === 'Unknown Author') {
                        try {
                            const { default: ePub } = await import('epubjs');
                            const book = ePub(epubData);
                            await book.ready;
                            const metadata = await book.loaded.metadata;
                            if (metadata.creator) {
                                author = metadata.creator;
                            }
                            book.destroy();
                        } catch (metaErr) {
                            console.warn('Could not extract metadata from epub:', metaErr);
                        }
                    }

                    await addBookFn({
                        title: serverBook.title,
                        author: author,
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
        }

        // Upload books that exist locally but not on server
        for (const localBook of localBooks) {
            const key = localBook.title.toLowerCase();
            if (!serverByTitle.has(key)) {
                try {
                    await uploadBook(localBook.data, {
                        title: localBook.title,
                        author: localBook.author,
                        series: localBook.series || 'Uncategorized',
                        filename: `${localBook.title}.epub`,
                        cover: localBook.cover,
                    });
                    results.uploaded++;
                } catch (err) {
                    results.errors.push(`Failed to upload "${localBook.title}": ${err.message}`);
                }
            }
        }

        // Sync reading progress
        const progressUpdates = [];
        for (const localBook of localBooks) {
            const key = localBook.title.toLowerCase();
            const serverBook = serverByTitle.get(key);

            if (serverBook && localBook.progress > 0) {
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
                    const serverBook = serverBooks.find((b) => b.id === serverProgress.book_id);
                    if (!serverBook) continue;

                    const localBook = localByTitle.get(serverBook.title.toLowerCase());
                    if (localBook && serverProgress.progress > localBook.progress) {
                        await updateProgressFn(localBook.id, serverProgress.location, serverProgress.progress);
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
