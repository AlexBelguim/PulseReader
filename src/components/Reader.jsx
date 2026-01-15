import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import ePub from 'epubjs';
import {
    ArrowLeft,
    Settings,
    List,
    ChevronLeft,
    ChevronRight,
    Zap,
} from 'lucide-react';
import { getBook, updateBookProgress } from '../services/db';
import { useReaderSettings } from '../hooks/useReaderSettings';
import ReaderSettings from './ReaderSettings';
import TableOfContents from './TableOfContents';
import RSVPOverlay from './RSVPOverlay';

const Reader = () => {
    const { bookId } = useParams();
    const navigate = useNavigate();
    const viewerRef = useRef(null);
    const renditionRef = useRef(null);
    const bookRef = useRef(null);
    const isNavigatingRef = useRef(false);
    const lastLocationRef = useRef(null);

    // State
    const [book, setBook] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [chapters, setChapters] = useState([]);
    const [currentChapter, setCurrentChapter] = useState('');
    const [currentLocation, setCurrentLocation] = useState(null);
    const [progress, setProgress] = useState(0);
    const [totalPages, setTotalPages] = useState(0);
    const [currentPage, setCurrentPage] = useState(0);
    const [locationsReady, setLocationsReady] = useState(false);

    // UI State
    const [showSettings, setShowSettings] = useState(false);
    const [showTOC, setShowTOC] = useState(false);
    const [showUI, setShowUI] = useState(true);
    const [showRSVP, setShowRSVP] = useState(false);

    // Settings hook
    const {
        settings,
        updateSetting,
        resetSettings,
        getEpubStyles,
        themeColors
    } = useReaderSettings();

    // Track settings that require re-initialization
    const prevSettingsRef = useRef({
        viewMode: settings.viewMode,
        twoPageLayout: settings.twoPageLayout,
    });

    // Track font size for page count regeneration
    const prevFontSizeRef = useRef(settings.fontSize);

    // Load book from IndexedDB
    useEffect(() => {
        const loadBook = async () => {
            try {
                setLoading(true);
                const bookData = await getBook(parseInt(bookId));

                if (!bookData) {
                    setError('Book not found');
                    return;
                }

                setBook(bookData);
            } catch (err) {
                console.error('Failed to load book:', err);
                setError('Failed to load book');
            } finally {
                setLoading(false);
            }
        };

        loadBook();
    }, [bookId]);

    // Initialize epub.js rendition
    useEffect(() => {
        if (!book?.data || !viewerRef.current) return;

        const initReader = async () => {
            try {
                // Save current position before cleanup
                const savedCfi = lastLocationRef.current;

                // Clean up previous instance
                if (renditionRef.current) {
                    renditionRef.current.destroy();
                }
                if (bookRef.current) {
                    bookRef.current.destroy();
                }

                setLocationsReady(false);

                // Create new book instance
                const epubBook = ePub(book.data);
                bookRef.current = epubBook;

                // Wait for book to be ready
                await epubBook.ready;

                // Get chapters from navigation
                const navigation = await epubBook.loaded.navigation;
                if (navigation?.toc) {
                    setChapters(navigation.toc);
                }

                // Create rendition
                const rendition = epubBook.renderTo(viewerRef.current, {
                    width: '100%',
                    height: '100%',
                    flow: settings.viewMode === 'scrollable' ? 'scrolled' : 'paginated',
                    spread: settings.twoPageLayout ? 'auto' : 'none',
                    manager: settings.viewMode === 'scrollable' ? 'continuous' : 'default',
                });

                renditionRef.current = rendition;

                // Apply theme styles
                rendition.themes.default({
                    body: {
                        background: themeColors.background,
                        color: themeColors.text,
                        'font-family': 'inherit',
                        padding: settings.pageMargins ? '20px' : '0',
                    }
                });

                // Inject custom CSS
                rendition.hooks.content.register((contents) => {
                    contents.addStylesheet(generateStyleUrl());
                });

                // Handle location changes
                rendition.on('relocated', (location) => {
                    setCurrentLocation(location);
                    lastLocationRef.current = location.start?.cfi;

                    // Calculate progress
                    if (location.start?.percentage !== undefined) {
                        setProgress(location.start.percentage);
                    }

                    // Update current chapter
                    if (location.start?.href) {
                        setCurrentChapter(location.start.href);
                    }

                    // Get page numbers if available
                    if (epubBook.locations && epubBook.locations.length()) {
                        const currentLoc = epubBook.locations.locationFromCfi(location.start.cfi);
                        setCurrentPage(currentLoc || 0);
                        setTotalPages(epubBook.locations.length());
                    }

                    // Save progress to database
                    if (location.start?.cfi) {
                        updateBookProgress(
                            parseInt(bookId),
                            location.start.cfi,
                            location.start.percentage || 0
                        );
                    }

                    // Reset navigation lock
                    isNavigatingRef.current = false;
                });

                // Generate locations for accurate page count (runs in background)
                // The character count per page affects pagination
                const charsPerPage = Math.round(1024 / (settings.fontSize / 100));
                epubBook.locations.generate(charsPerPage).then(() => {
                    setTotalPages(epubBook.locations.length());
                    setLocationsReady(true);
                    prevFontSizeRef.current = settings.fontSize;

                    // Force a re-display to update page number after locations are ready
                    if (lastLocationRef.current && renditionRef.current) {
                        renditionRef.current.display(lastLocationRef.current);
                    }
                });

                // Display book - resume from last position if available
                // Priority: savedCfi (from mode switch) > book.lastRead (from DB)
                const startLocation = savedCfi || book.lastRead;
                if (startLocation) {
                    await rendition.display(startLocation);
                    // Force another display to ensure correct page is shown
                    setTimeout(() => {
                        if (renditionRef.current && startLocation) {
                            renditionRef.current.display(startLocation);
                        }
                    }, 100);
                } else {
                    await rendition.display();
                }

                // Update prev settings ref
                prevSettingsRef.current = {
                    viewMode: settings.viewMode,
                    twoPageLayout: settings.twoPageLayout,
                };

            } catch (err) {
                console.error('Failed to initialize reader:', err);
                setError('Failed to initialize reader');
            }
        };

        initReader();

        return () => {
            if (renditionRef.current) {
                renditionRef.current.destroy();
            }
            if (bookRef.current) {
                bookRef.current.destroy();
            }
        };
    }, [book?.data, bookId, settings.viewMode, settings.twoPageLayout]);

    // Generate a data URL for the stylesheet
    const generateStyleUrl = useCallback(() => {
        const styles = getEpubStyles();
        const blob = new Blob([styles], { type: 'text/css' });
        return URL.createObjectURL(blob);
    }, [getEpubStyles]);

    // Update rendition styles when settings change (not requiring re-init)
    useEffect(() => {
        if (!renditionRef.current) return;

        // Skip if viewMode or twoPageLayout changed (handled by re-init)
        if (settings.viewMode !== prevSettingsRef.current.viewMode ||
            settings.twoPageLayout !== prevSettingsRef.current.twoPageLayout) {
            return;
        }

        const rendition = renditionRef.current;

        // Re-inject styles when settings change
        rendition.themes.default({
            body: {
                background: themeColors.background,
                color: themeColors.text,
                padding: settings.pageMargins ? '20px' : '0',
            }
        });

        // Apply styles to current content
        rendition.getContents().forEach((c) => {
            const doc = c.document;
            if (doc) {
                // Update or create style element
                let styleEl = doc.getElementById('reader-custom-styles');
                if (!styleEl) {
                    styleEl = doc.createElement('style');
                    styleEl.id = 'reader-custom-styles';
                    doc.head.appendChild(styleEl);
                }
                styleEl.textContent = getEpubStyles();
            }
        });

        // Regenerate locations if font size changed significantly
        if (bookRef.current && Math.abs(settings.fontSize - prevFontSizeRef.current) >= 10) {
            const charsPerPage = Math.round(1024 / (settings.fontSize / 100));
            setLocationsReady(false);
            bookRef.current.locations.generate(charsPerPage).then(() => {
                setTotalPages(bookRef.current.locations.length());
                setLocationsReady(true);
                prevFontSizeRef.current = settings.fontSize;
            });
        }

    }, [settings, getEpubStyles, themeColors]);

    // Navigation functions with debouncing
    const goNext = useCallback(() => {
        if (renditionRef.current && !isNavigatingRef.current) {
            isNavigatingRef.current = true;
            renditionRef.current.next();
            // Fallback reset in case relocated event doesn't fire
            setTimeout(() => {
                isNavigatingRef.current = false;
            }, 300);
        }
    }, []);

    const goPrev = useCallback(() => {
        if (renditionRef.current && !isNavigatingRef.current) {
            isNavigatingRef.current = true;
            renditionRef.current.prev();
            // Fallback reset in case relocated event doesn't fire
            setTimeout(() => {
                isNavigatingRef.current = false;
            }, 300);
        }
    }, []);

    const goToLocation = useCallback((cfi) => {
        if (renditionRef.current) {
            renditionRef.current.display(cfi);
        }
    }, []);

    const handleProgressChange = useCallback((e) => {
        const newProgress = parseFloat(e.target.value);
        if (bookRef.current && bookRef.current.locations && locationsReady) {
            const cfi = bookRef.current.locations.cfiFromPercentage(newProgress);
            if (cfi && renditionRef.current) {
                renditionRef.current.display(cfi);
            }
        }
    }, [locationsReady]);

    // Handle chapter navigation from TOC
    const handleChapterNavigate = useCallback((href) => {
        if (renditionRef.current) {
            // Some EPUBs have relative paths in TOC that fail resolution
            const target = href.replace(/^\.\.\//, '');

            renditionRef.current.display(target).catch(err => {
                console.warn("Navigation failed with cleaned target, trying original:", err);
                renditionRef.current.display(href).catch(e => console.error("Final navigation failed:", e));
            });
        }
    }, []);

    // Handle RSVP button click
    const handleRSVPClick = useCallback((e) => {
        e.stopPropagation();
        setShowRSVP(true);
        setShowUI(false); // Hide other UI when RSVP is open
    }, []);

    // Handle RSVP close - highlight the last read word for 5 seconds
    const handleRSVPCloseWithPosition = useCallback((wordInfo) => {
        if (!wordInfo?.parent || !renditionRef.current) return;

        try {
            // Find the word text in the parent and wrap it with a highlight span
            const parent = wordInfo.parent;
            const word = wordInfo.originalWord || wordInfo.word;

            // Create a highlight effect on the parent element
            parent.style.transition = 'background-color 0.3s, box-shadow 0.3s';
            parent.style.backgroundColor = 'rgba(255, 75, 75, 0.4)';
            parent.style.boxShadow = '0 0 10px rgba(255, 75, 75, 0.6)';
            parent.style.borderRadius = '4px';

            // Remove highlight after 5 seconds
            setTimeout(() => {
                parent.style.backgroundColor = '';
                parent.style.boxShadow = '';
                parent.style.borderRadius = '';
            }, 5000);
        } catch (err) {
            console.log('Could not highlight last word position:', err);
        }
    }, []);

    // Handle RSVP stop at image - navigate to next page and highlight last word
    const handleRSVPStopAtImage = useCallback((lastWordInfo, navigateToNext = true) => {
        if (!renditionRef.current) return;

        // Close RSVP overlay
        setShowRSVP(false);
        setShowUI(true);

        if (navigateToNext) {
            // Navigate to next page
            renditionRef.current.next().then(() => {
                // After navigation, try to highlight the context
                // This helps user know where they stopped reading
                if (lastWordInfo?.parent) {
                    try {
                        // Add a temporary highlight style to the parent element
                        const parent = lastWordInfo.parent;
                        parent.style.transition = 'background-color 0.3s';
                        parent.style.backgroundColor = 'rgba(255, 75, 75, 0.3)';

                        // Remove highlight after 5 seconds
                        setTimeout(() => {
                            parent.style.backgroundColor = '';
                        }, 5000);
                    } catch (err) {
                        console.log('Could not highlight last word position');
                    }
                }
            });
        }
    }, []);

    // Keyboard navigation
    useEffect(() => {
        const handleKeyDown = (e) => {
            if (showSettings || showTOC) return;

            switch (e.key) {
                case 'ArrowRight':
                case 'PageDown':
                    goNext();
                    break;
                case 'ArrowLeft':
                case 'PageUp':
                    goPrev();
                    break;
                case 'Escape':
                    navigate('/');
                    break;
                default:
                    break;
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [goNext, goPrev, navigate, showSettings, showTOC]);

    // Handle tap on viewer to toggle UI
    const handleViewerClick = useCallback((e) => {
        // Don't handle if clicking on a button, interactive element, or RSVP FAB
        if (e.target.closest('button') ||
            e.target.closest('input') ||
            e.target.closest('.rsvp-fab') ||
            e.target.closest('.reader-footer') ||
            e.target.closest('.reader-header')) {
            return;
        }

        const rect = viewerRef.current?.getBoundingClientRect();
        if (!rect) return;

        const x = e.clientX - rect.left;
        const width = rect.width;

        // Tap left 25% = prev, right 25% = next, center = toggle UI
        if (x < width * 0.25) {
            goPrev();
        } else if (x > width * 0.75) {
            goNext();
        } else {
            setShowUI((prev) => !prev);
        }
    }, [goNext, goPrev]);

    // Prevent button clicks from bubbling to viewer
    const handleButtonClick = useCallback((e, action) => {
        e.stopPropagation();
        action();
    }, []);

    // Loading state
    if (loading) {
        return (
            <div className="reader-loading">
                <motion.div
                    className="loading-spinner"
                    animate={{ rotate: 360 }}
                    transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
                />
                <p>Loading book...</p>
            </div>
        );
    }

    // Error state
    if (error) {
        return (
            <div className="reader-error">
                <p>{error}</p>
                <button className="btn btn-primary" onClick={() => navigate('/')}>
                    Back to Library
                </button>
            </div>
        );
    }

    return (
        <div
            className="reader-container"
            style={{ backgroundColor: themeColors.background }}
        >
            {/* Header */}
            <AnimatePresence>
                {showUI && (
                    <motion.header
                        className="reader-header"
                        initial={{ y: -60, opacity: 0 }}
                        animate={{ y: 0, opacity: 1 }}
                        exit={{ y: -60, opacity: 0 }}
                        transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                    >
                        <button
                            className="header-btn"
                            onClick={(e) => handleButtonClick(e, () => navigate('/'))}
                            title="Back to Library"
                        >
                            <ArrowLeft size={24} />
                        </button>

                        <div className="header-title">
                            <h1>{book?.title || 'Untitled'}</h1>
                            {book?.author && <span className="header-author">{book.author}</span>}
                        </div>

                        <div className="header-actions">
                            <button
                                className="header-btn"
                                onClick={(e) => handleButtonClick(e, () => setShowTOC(true))}
                                title="Table of Contents"
                            >
                                <List size={24} />
                            </button>
                            <button
                                className="header-btn"
                                onClick={(e) => handleButtonClick(e, () => setShowSettings(true))}
                                title="Settings"
                            >
                                <Settings size={24} />
                            </button>
                        </div>
                    </motion.header>
                )}
            </AnimatePresence>

            {/* Main Reading Area */}
            <div
                ref={viewerRef}
                className="reader-viewer"
                onClick={handleViewerClick}
                style={{
                    paddingTop: '60px',
                    paddingBottom: '80px',
                }}
            />

            {/* RSVP FAB Button */}
            <AnimatePresence>
                {showUI && (
                    <motion.button
                        className="rsvp-fab"
                        initial={{ scale: 0, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0, opacity: 0 }}
                        whileHover={{ scale: 1.1 }}
                        whileTap={{ scale: 0.9 }}
                        onClick={handleRSVPClick}
                        title="RSVP Speed Reading"
                    >
                        <Zap size={24} />
                    </motion.button>
                )}
            </AnimatePresence>

            {/* Footer Navigation */}
            <AnimatePresence>
                {showUI && (
                    <motion.footer
                        className="reader-footer"
                        initial={{ y: 80, opacity: 0 }}
                        animate={{ y: 0, opacity: 1 }}
                        exit={{ y: 80, opacity: 0 }}
                        transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                    >
                        <button
                            className="nav-btn"
                            onClick={(e) => handleButtonClick(e, goPrev)}
                            disabled={progress === 0}
                        >
                            <ChevronLeft size={28} />
                        </button>

                        <div className="progress-container">
                            <input
                                type="range"
                                className="progress-slider"
                                min={0}
                                max={1}
                                step={0.001}
                                value={progress}
                                onChange={handleProgressChange}
                                onClick={(e) => e.stopPropagation()}
                            />
                            <span className="progress-text">
                                {totalPages > 0
                                    ? `${currentPage} van ${totalPages}`
                                    : `${Math.round(progress * 100)}%`
                                }
                            </span>
                        </div>

                        <button
                            className="nav-btn"
                            onClick={(e) => handleButtonClick(e, goNext)}
                            disabled={progress >= 1}
                        >
                            <ChevronRight size={28} />
                        </button>
                    </motion.footer>
                )}
            </AnimatePresence>

            {/* Settings Panel */}
            <ReaderSettings
                isOpen={showSettings}
                onClose={() => setShowSettings(false)}
                settings={settings}
                updateSetting={updateSetting}
                resetSettings={resetSettings}
            />

            {/* Table of Contents Drawer */}
            <TableOfContents
                isOpen={showTOC}
                onClose={() => setShowTOC(false)}
                chapters={chapters}
                currentChapter={currentChapter}
                onNavigate={handleChapterNavigate}
            />

            {/* RSVP Speed Reading Overlay */}
            <RSVPOverlay
                isOpen={showRSVP}
                onClose={() => {
                    setShowRSVP(false);
                    setShowUI(true);
                }}
                rendition={renditionRef.current}
                wpm={settings.rsvpSpeed}
                onWpmChange={(newWpm) => updateSetting('rsvpSpeed', newWpm)}
                onStopAtImage={handleRSVPStopAtImage}
                onCloseWithPosition={handleRSVPCloseWithPosition}
            />
        </div>
    );
};

export default Reader;

