import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import ePub from 'epubjs';
import { BookOpen, Plus, Trash2, AlertCircle } from 'lucide-react';
import { getBooks, addBook, deleteBook } from '../services/db';

const Library = () => {
    const navigate = useNavigate();
    const fileInputRef = useRef(null);
    const [books, setBooks] = useState([]);
    const [loading, setLoading] = useState(true);
    const [importing, setImporting] = useState(false);
    const [deleteConfirm, setDeleteConfirm] = useState(null);

    // Load books from IndexedDB
    useEffect(() => {
        const loadBooks = async () => {
            try {
                const storedBooks = await getBooks();
                setBooks(storedBooks.reverse()); // Most recent first
            } catch (err) {
                console.error('Failed to load books:', err);
            } finally {
                setLoading(false);
            }
        };
        loadBooks();
    }, []);

    // Handle file import
    const handleFileChange = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setImporting(true);

        try {
            const arrayBuffer = await file.arrayBuffer();
            const book = ePub(arrayBuffer);
            await book.ready;

            // Extract metadata
            const metadata = await book.loaded.metadata;
            const title = metadata.title || file.name.replace('.epub', '');
            const author = metadata.creator || 'Unknown Author';

            // Extract cover
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

            // Save to IndexedDB
            const id = await addBook({
                title,
                author,
                cover,
                data: arrayBuffer,
                series: 'Uncategorized',
                progress: 0,
                lastRead: null,
            });

            // Reload books list
            const updatedBooks = await getBooks();
            setBooks(updatedBooks.reverse());

            // Clean up
            book.destroy();
        } catch (err) {
            console.error('Failed to import book:', err);
            alert('Failed to import book. Please ensure it\'s a valid EPUB file.');
        } finally {
            setImporting(false);
            if (fileInputRef.current) {
                fileInputRef.current.value = '';
            }
        }
    };

    // Handle book deletion
    const handleDelete = async (id) => {
        try {
            await deleteBook(id);
            setBooks((prev) => prev.filter((b) => b.id !== id));
            setDeleteConfirm(null);
        } catch (err) {
            console.error('Failed to delete book:', err);
        }
    };

    // Create cover URL from blob
    const getCoverUrl = (cover) => {
        if (cover) {
            return URL.createObjectURL(cover);
        }
        return null;
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
                {/* Add Book Button */}
                <div className="library-actions">
                    <label className={`btn btn-primary ${importing ? 'disabled' : ''}`}>
                        <Plus size={20} />
                        {importing ? 'Importing...' : 'Add Book'}
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept=".epub"
                            onChange={handleFileChange}
                            disabled={importing}
                        />
                    </label>
                </div>

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

                {/* Books Grid */}
                {!loading && books.length > 0 && (
                    <div className="library-grid">
                        <AnimatePresence>
                            {books.map((book, index) => (
                                <motion.div
                                    key={book.id}
                                    className="book-card"
                                    initial={{ opacity: 0, y: 20 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, scale: 0.9 }}
                                    transition={{ delay: index * 0.05 }}
                                    onClick={() => navigate(`/read/${book.id}`)}
                                >
                                    {/* Cover */}
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

                                        {/* Progress Bar */}
                                        {book.progress > 0 && (
                                            <div className="book-progress">
                                                <div
                                                    className="book-progress-bar"
                                                    style={{ width: `${book.progress * 100}%` }}
                                                />
                                            </div>
                                        )}

                                        {/* Delete Button */}
                                        <button
                                            className="book-delete-btn"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setDeleteConfirm(book.id);
                                            }}
                                        >
                                            <Trash2 size={16} />
                                        </button>
                                    </div>

                                    {/* Info */}
                                    <div className="book-info">
                                        <h3 className="book-title">{book.title}</h3>
                                        <p className="book-author">{book.author}</p>
                                    </div>
                                </motion.div>
                            ))}
                        </AnimatePresence>
                    </div>
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
        </div>
    );
};

export default Library;
