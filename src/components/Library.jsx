import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import ePub from 'epubjs';
import {
    BookOpen,
    Plus,
    Trash2,
    AlertCircle,
    Server,
    ArrowLeft,
    Check,
    BookMarked,
    Edit3,
} from 'lucide-react';
import {
    getBooks,
    addBook,
    deleteBook,
    updateBookProgress,
    updateBook,
    toggleBookRead,
} from '../services/db';
import { getSyncConfig, performFullSync } from '../services/syncService';
import SyncSettings from './SyncSettings';

const Library = () => {
    const navigate = useNavigate();
    const fileInputRef = useRef(null);
    const seriesFileInputRef = useRef(null);
    const [books, setBooks] = useState([]);
    const [loading, setLoading] = useState(true);
    const [importing, setImporting] = useState(false);
    const [deleteConfirm, setDeleteConfirm] = useState(null);
    const [showSyncSettings, setShowSyncSettings] = useState(false);
    const [syncStatus, setSyncStatus] = useState(null);
    const [selectedSeries, setSelectedSeries] = useState(null);
    const [editingSeries, setEditingSeries] = useState(null); // book id being edited
    const [seriesInput, setSeriesInput] = useState('');

    // Load books from IndexedDB
    useEffect(() => {
        const loadBooks = async () => {
            try {
                const storedBooks = await getBooks();
                setBooks(storedBooks.reverse());
            } catch (err) {
                console.error('Failed to load books:', err);
            } finally {
                setLoading(false);
            }
        };
        loadBooks();
    }, []);

    // Auto-sync on load if configured
    useEffect(() => {
        const config = getSyncConfig();
        if (config.enabled && config.autoSync && config.serverUrl && !loading) {
            handleAutoSync();
        }
    }, [loading]);

    // Group books by series
    const seriesGroups = useMemo(() => {
        const groups = new Map();
        for (const book of books) {
            const series = book.series || 'Uncategorized';
            if (!groups.has(series)) {
                groups.set(series, []);
            }
            groups.get(series).push(book);
        }
        // Sort books within each series by title
        for (const [, seriesBooks] of groups) {
            seriesBooks.sort((a, b) => a.title.localeCompare(b.title));
        }
        return groups;
    }, [books]);

    // Get all unique series names for the series editor dropdown
    const allSeriesNames = useMemo(() => {
        const names = new Set();
        for (const book of books) {
            if (book.series) names.add(book.series);
        }
        return Array.from(names).sort();
    }, [books]);

    // Get the cover for a series (first book with a cover)
    const getSeriesCover = (seriesBooks) => {
        const bookWithCover = seriesBooks.find((b) => b.cover);
        return bookWithCover?.cover || null;
    };

    const handleAutoSync = async () => {
        setSyncStatus('syncing');
        try {
            const result = await performFullSync(
                books,
                async (bookData) => {
                    const id = await addBook(bookData);
                    return id;
                },
                async (id, location, progress) => {
                    await updateBookProgress(id, location, progress);
                }
            );
            if (result.synced) {
                setSyncStatus('success');
                const updatedBooks = await getBooks();
                setBooks(updatedBooks.reverse());
            } else {
                setSyncStatus('error');
            }
            setTimeout(() => setSyncStatus(null), 3000);
        } catch {
            setSyncStatus('error');
            setTimeout(() => setSyncStatus(null), 3000);
        }
    };

    const handleSyncComplete = async () => {
        const updatedBooks = await getBooks();
        setBooks(updatedBooks.reverse());
    };

    // Handle file import (with optional series context)
    const handleFileChange = async (e, targetSeries) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;

        setImporting(true);

        for (const file of files) {
            try {
                const arrayBuffer = await file.arrayBuffer();
                const book = ePub(arrayBuffer);
                await book.ready;

                const metadata = await book.loaded.metadata;
                const title = metadata.title || file.name.replace('.epub', '');
                const author = metadata.creator || 'Unknown Author';

                let cover = null;
                try {
                    const coverUrl = await book.coverUrl();
                    if (coverUrl) {
                        const response = await fetch(coverUrl);
                        cover = await response.blob();
                    }
                } catch (err) {
                    console.warn('Could not extract cover:', err);
                }

                await addBook({
                    title,
                    author,
                    cover,
                    data: arrayBuffer,
                    series: targetSeries || selectedSeries || 'Uncategorized',
                    progress: 0,
                    lastRead: null,
                });

                book.destroy();
            } catch (err) {
                console.error(`Failed to import ${file.name}:`, err);
            }
        }

        const updatedBooks = await getBooks();
        setBooks(updatedBooks.reverse());
        setImporting(false);

        if (fileInputRef.current) fileInputRef.current.value = '';
        if (seriesFileInputRef.current) seriesFileInputRef.current.value = '';
    };

    const handleDelete = async (id) => {
        try {
            await deleteBook(id);
            setBooks((prev) => prev.filter((b) => b.id !== id));
            setDeleteConfirm(null);
        } catch (err) {
            console.error('Failed to delete book:', err);
        }
    };

    const handleToggleRead = async (e, id) => {
        e.stopPropagation();
        const newState = await toggleBookRead(id);
        setBooks((prev) =>
            prev.map((b) => (b.id === id ? { ...b, isRead: newState } : b))
        );
    };

    const handleSeriesChange = async (bookId, newSeries) => {
        await updateBook(bookId, { series: newSeries });
        setBooks((prev) =>
            prev.map((b) => (b.id === bookId ? { ...b, series: newSeries } : b))
        );
        setEditingSeries(null);
        setSeriesInput('');
    };

    const getCoverUrl = (cover) => {
        if (cover) {
            return URL.createObjectURL(cover);
        }
        return null;
    };

    // ===== RENDER: Series Detail View =====
    const renderSeriesView = () => {
        const seriesBooks = seriesGroups.get(selectedSeries) || [];
        const readCount = seriesBooks.filter((b) => b.isRead || b.progress >= 0.95).length;

        return (
            <>
                {/* Series Header */}
                <div className="series-header">
                    <button
                        className="btn btn-ghost series-back-btn"
                        onClick={() => setSelectedSeries(null)}
                    >
                        <ArrowLeft size={20} />
                        Back
                    </button>
                    <div className="series-header-info">
                        <h2>{selectedSeries}</h2>
                        <p className="series-count">
                            {seriesBooks.length} book{seriesBooks.length !== 1 ? 's' : ''}
                            {readCount > 0 && ` · ${readCount} read`}
                        </p>
                    </div>
                </div>

                {/* Books Grid */}
                <div className="library-grid">
                    <AnimatePresence>
                        {seriesBooks.map((book, index) => (
                            <motion.div
                                key={book.id}
                                className={`book-card ${book.isRead || book.progress >= 0.95 ? 'book-read' : ''}`}
                                initial={{ opacity: 0, y: 20 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, scale: 0.9 }}
                                transition={{ delay: index * 0.03 }}
                                onClick={() => navigate(`/read/${book.id}`)}
                            >
                                <div className="book-cover">
                                    {book.cover ? (
                                        <img
                                            src={getCoverUrl(book.cover)}
                                            alt={book.title}
                                            onLoad={(e) => URL.revokeObjectURL(e.target.src)}
                                        />
                                    ) : (
                                        <div className="book-cover-placeholder">
                                            <BookOpen size={40} strokeWidth={1} />
                                        </div>
                                    )}

                                    {/* Read badge */}
                                    {(book.isRead || book.progress >= 0.95) && (
                                        <div className="book-read-badge">
                                            <Check size={14} />
                                        </div>
                                    )}

                                    {/* Progress Bar */}
                                    {book.progress > 0 && book.progress < 0.95 && (
                                        <div className="book-progress">
                                            <div
                                                className="book-progress-bar"
                                                style={{ width: `${book.progress * 100}%` }}
                                            />
                                        </div>
                                    )}

                                    {/* Action buttons overlay */}
                                    <div className="book-actions-overlay">
                                        <button
                                            className="book-action-btn"
                                            onClick={(e) => handleToggleRead(e, book.id)}
                                            title={book.isRead ? 'Mark as unread' : 'Mark as read'}
                                        >
                                            <BookMarked size={14} />
                                        </button>
                                        <button
                                            className="book-action-btn"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setEditingSeries(book.id);
                                                setSeriesInput(book.series || '');
                                            }}
                                            title="Change series"
                                        >
                                            <Edit3 size={14} />
                                        </button>
                                        <button
                                            className="book-action-btn danger"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setDeleteConfirm(book.id);
                                            }}
                                            title="Delete"
                                        >
                                            <Trash2 size={14} />
                                        </button>
                                    </div>
                                </div>

                                <div className="book-info">
                                    <h3 className="book-title">{book.title}</h3>
                                    <p className="book-author">{book.author}</p>
                                </div>
                            </motion.div>
                        ))}

                        {/* Add Book Card */}
                        <motion.label
                            className={`book-card add-book-card ${importing ? 'disabled' : ''}`}
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: seriesBooks.length * 0.03 }}
                        >
                            <div className="book-cover add-book-cover">
                                <Plus size={40} strokeWidth={1.5} />
                                <span>{importing ? 'Importing...' : 'Add Book'}</span>
                            </div>
                            <input
                                ref={seriesFileInputRef}
                                type="file"
                                accept=".epub"
                                multiple
                                onChange={(e) => handleFileChange(e, selectedSeries)}
                                disabled={importing}
                                style={{ display: 'none' }}
                            />
                        </motion.label>
                    </AnimatePresence>
                </div>
            </>
        );
    };

    // ===== RENDER: Series Grid (Main View) =====
    const renderSeriesGrid = () => {
        const seriesEntries = Array.from(seriesGroups.entries());

        return (
            <div className="library-grid series-grid">
                <AnimatePresence>
                    {seriesEntries.map(([seriesName, seriesBooks], index) => {
                        const cover = getSeriesCover(seriesBooks);
                        const readCount = seriesBooks.filter((b) => b.isRead || b.progress >= 0.95).length;
                        const totalCount = seriesBooks.length;

                        return (
                            <motion.div
                                key={seriesName}
                                className="book-card series-card"
                                initial={{ opacity: 0, y: 20 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, scale: 0.9 }}
                                transition={{ delay: index * 0.05 }}
                                onClick={() => setSelectedSeries(seriesName)}
                            >
                                <div className="book-cover">
                                    {cover ? (
                                        <img
                                            src={getCoverUrl(cover)}
                                            alt={seriesName}
                                            onLoad={(e) => URL.revokeObjectURL(e.target.src)}
                                        />
                                    ) : (
                                        <div className="book-cover-placeholder">
                                            <BookOpen size={40} strokeWidth={1} />
                                        </div>
                                    )}

                                    {/* Book count badge */}
                                    <div className="series-count-badge">
                                        {totalCount}
                                    </div>

                                    {/* All read indicator */}
                                    {readCount === totalCount && totalCount > 0 && (
                                        <div className="book-read-badge">
                                            <Check size={14} />
                                        </div>
                                    )}
                                </div>

                                <div className="book-info">
                                    <h3 className="book-title">{seriesName}</h3>
                                    <p className="book-author">
                                        {readCount}/{totalCount} read
                                    </p>
                                </div>
                            </motion.div>
                        );
                    })}
                </AnimatePresence>
            </div>
        );
    };

    return (
        <div className="library-container">
            <header className="library-header">
                <h1>
                    <BookOpen size={32} />
                    PulseReader
                </h1>
            </header>

            <div className="library-content">
                {/* Action Buttons (only on main view) */}
                {!selectedSeries && (
                    <div className="library-actions">
                        <label className={`btn btn-primary ${importing ? 'disabled' : ''}`}>
                            <Plus size={20} />
                            {importing ? 'Importing...' : 'Add Book'}
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept=".epub"
                                multiple
                                onChange={(e) => handleFileChange(e)}
                                disabled={importing}
                            />
                        </label>

                        <button
                            className={`btn btn-secondary sync-btn ${syncStatus ? 'sync-' + syncStatus : ''}`}
                            onClick={() => setShowSyncSettings(true)}
                            title="Sync Server Settings"
                        >
                            <Server size={20} />
                            Sync
                            {syncStatus === 'syncing' && <span className="sync-indicator syncing" />}
                            {syncStatus === 'success' && <span className="sync-indicator success" />}
                            {syncStatus === 'error' && <span className="sync-indicator error" />}
                        </button>
                    </div>
                )}

                {/* Loading State */}
                {loading && (
                    <div className="library-loading">
                        <motion.div
                            className="loading-spinner"
                            animate={{ rotate: 360 }}
                            transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
                        />
                        <p>Loading library...</p>
                    </div>
                )}

                {/* Empty State */}
                {!loading && books.length === 0 && (
                    <div className="library-empty">
                        <BookOpen size={64} strokeWidth={1} />
                        <h2>Your Library is Empty</h2>
                        <p>Add your first book to get started</p>
                    </div>
                )}

                {/* Main Content */}
                {!loading && books.length > 0 && (
                    selectedSeries ? renderSeriesView() : renderSeriesGrid()
                )}
            </div>

            {/* Delete Confirmation Modal */}
            <AnimatePresence>
                {deleteConfirm && (
                    <>
                        <motion.div
                            className="modal-backdrop"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            onClick={() => setDeleteConfirm(null)}
                        />
                        <motion.div
                            className="delete-modal"
                            initial={{ opacity: 0, scale: 0.9 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.9 }}
                        >
                            <AlertCircle size={40} className="modal-icon" />
                            <h3>Delete this book?</h3>
                            <p>This action cannot be undone.</p>
                            <div className="modal-actions">
                                <button
                                    className="btn btn-ghost"
                                    onClick={() => setDeleteConfirm(null)}
                                >
                                    Cancel
                                </button>
                                <button
                                    className="btn btn-danger"
                                    onClick={() => handleDelete(deleteConfirm)}
                                >
                                    Delete
                                </button>
                            </div>
                        </motion.div>
                    </>
                )}
            </AnimatePresence>

            {/* Series Edit Modal */}
            <AnimatePresence>
                {editingSeries && (
                    <>
                        <motion.div
                            className="modal-backdrop"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            onClick={() => { setEditingSeries(null); setSeriesInput(''); }}
                        />
                        <motion.div
                            className="series-edit-modal"
                            initial={{ opacity: 0, scale: 0.9 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.9 }}
                        >
                            <h3>Move to Series</h3>
                            <input
                                type="text"
                                value={seriesInput}
                                onChange={(e) => setSeriesInput(e.target.value)}
                                placeholder="Enter series name..."
                                autoFocus
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' && seriesInput.trim()) {
                                        handleSeriesChange(editingSeries, seriesInput.trim());
                                    }
                                }}
                            />
                            {/* Existing series suggestions */}
                            {allSeriesNames.length > 0 && (
                                <div className="series-suggestions">
                                    {allSeriesNames
                                        .filter((s) => s.toLowerCase().includes(seriesInput.toLowerCase()))
                                        .map((name) => (
                                            <button
                                                key={name}
                                                className="series-suggestion-btn"
                                                onClick={() => handleSeriesChange(editingSeries, name)}
                                            >
                                                {name}
                                            </button>
                                        ))}
                                </div>
                            )}
                            <div className="modal-actions">
                                <button
                                    className="btn btn-ghost"
                                    onClick={() => { setEditingSeries(null); setSeriesInput(''); }}
                                >
                                    Cancel
                                </button>
                                <button
                                    className="btn btn-primary"
                                    onClick={() => {
                                        if (seriesInput.trim()) {
                                            handleSeriesChange(editingSeries, seriesInput.trim());
                                        }
                                    }}
                                    disabled={!seriesInput.trim()}
                                >
                                    Move
                                </button>
                            </div>
                        </motion.div>
                    </>
                )}
            </AnimatePresence>

            {/* Sync Settings Panel */}
            <AnimatePresence>
                {showSyncSettings && (
                    <SyncSettings
                        books={books}
                        onSyncComplete={handleSyncComplete}
                        onClose={() => setShowSyncSettings(false)}
                    />
                )}
            </AnimatePresence>
        </div>
    );
};

export default Library;
