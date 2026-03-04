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
    Maximize,
    Minimize,
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
    const [locationsReady, setLocationsReady] = useState(false);

    // UI State
    const [showSettings, setShowSettings] = useState(false);
    const [showTOC, setShowTOC] = useState(false);
    const [showUI, setShowUI] = useState(true);
    const [showRSVP, setShowRSVP] = useState(false);
    const [wordSelectMode, setWordSelectMode] = useState(false);
    const [rsvpStartWord, setRsvpStartWord] = useState(null); // { text, node }
    const longPressTimerRef = useRef(null);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const handleTapZoneRef = useRef(null); // Will be set when handleTapZone is created
    const wordSelectModeRef = useRef(false);
    const uiAutoHideTimerRef = useRef(null); // Auto-hide UI after initial display

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

                    // Calculate progress from percentage
                    if (location.start?.percentage !== undefined) {
                        setProgress(location.start.percentage);
                    }

                    // Update current chapter
                    if (location.start?.href) {
                        setCurrentChapter(location.start.href);
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

                // Handle clicks inside the epub iframe for tap zone navigation
                rendition.on('click', (e) => {
                    // Don't handle if in word select mode
                    if (wordSelectModeRef.current) return;

                    // Map iframe coordinates to viewport coordinates
                    const iframe = viewerRef.current?.querySelector('iframe');
                    if (!iframe) return;

                    const iframeRect = iframe.getBoundingClientRect();
                    const viewportX = e.clientX + iframeRect.left;
                    const viewportY = e.clientY + iframeRect.top;

                    handleTapZoneRef.current(viewportX, viewportY);
                });

                // Display book FIRST - resume from last position if available
                // Priority: savedCfi (from mode switch) > book.lastRead (from DB)
                const startLocation = savedCfi || book.lastRead;
                if (startLocation) {
                    await rendition.display(startLocation);

                    // Flash the resumed position after content is rendered
                    // Use a one-time relocated handler to ensure content is ready
                    const flashOnce = () => {
                        rendition.off('relocated', flashOnce);
                        setTimeout(() => {
                            try {
                                const contents = renditionRef.current?.getContents();
                                if (contents && contents.length > 0) {
                                    const range = contents[0].range(startLocation);
                                    if (range) {
                                        const el = range.startContainer.nodeType === Node.ELEMENT_NODE
                                            ? range.startContainer
                                            : range.startContainer.parentElement;
                                        if (el) {
                                            el.style.transition = 'background-color 0.5s ease, box-shadow 0.5s ease';
                                            el.style.backgroundColor = 'rgba(255, 75, 75, 0.25)';
                                            el.style.boxShadow = '0 0 8px rgba(255, 75, 75, 0.4)';
                                            el.style.borderRadius = '4px';
                                            setTimeout(() => {
                                                el.style.backgroundColor = '';
                                                el.style.boxShadow = '';
                                                el.style.borderRadius = '';
                                            }, 3000);
                                        }
                                    }
                                }
                            } catch (err) {
                                // Silently fail - flash is just a visual hint
                            }
                        }, 200);
                    };
                    rendition.on('relocated', flashOnce);
                } else {
                    await rendition.display();
                }

                // Generate locations for progress slider seeking
                epubBook.locations.generate(150).then(() => {
                    setLocationsReady(true);
                    // Update slider position from current reading position
                    if (lastLocationRef.current) {
                        const pct = epubBook.locations.percentageFromCfi(lastLocationRef.current);
                        if (pct !== undefined && pct !== null) {
                            setProgress(pct);
                        }
                    }
                });

                // Auto-hide UI after 3 seconds for immersive reading
                uiAutoHideTimerRef.current = setTimeout(() => {
                    setShowUI(false);
                }, 3000);

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

        // Handle screen resize (Samsung Fold, orientation change, etc.)
        let resizeTimeout;
        const handleResize = () => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(async () => {
                if (renditionRef.current && lastLocationRef.current) {
                    renditionRef.current.resize('100%', '100%');
                    renditionRef.current.display(lastLocationRef.current);

                    // No need to regenerate locations — percentage is position-based
                    // The resize + display above handles visual re-pagination
                }
            }, 300); // Debounce to avoid rapid re-renders during fold animation
        };

        window.addEventListener('resize', handleResize);

        return () => {
            window.removeEventListener('resize', handleResize);
            clearTimeout(resizeTimeout);
            if (uiAutoHideTimerRef.current) {
                clearTimeout(uiAutoHideTimerRef.current);
            }
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
                let styleEl = doc.getElementById('reader-custom-styles');
                if (!styleEl) {
                    styleEl = doc.createElement('style');
                    styleEl.id = 'reader-custom-styles';
                    doc.head.appendChild(styleEl);
                }
                styleEl.textContent = getEpubStyles();
            }
        });

        // Force re-display at current position so epub.js re-paginates
        // with the new styles. Without this, changing font/margins/spacing
        // breaks the paginated layout.
        if (lastLocationRef.current) {
            rendition.display(lastLocationRef.current);
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

    // Handle RSVP button - click for normal start, long-press for word selection
    const handleRSVPClick = useCallback((e) => {
        e.stopPropagation();
        if (wordSelectMode) {
            // Cancel word selection mode
            setWordSelectMode(false);
            return;
        }
        setRsvpStartWord(null);
        setShowRSVP(true);
        setShowUI(false);
    }, [wordSelectMode]);

    const handleRSVPPointerDown = useCallback((e) => {
        longPressTimerRef.current = setTimeout(() => {
            e.preventDefault?.();
            setWordSelectMode(true);
        }, 600);
    }, []);

    const handleRSVPPointerUp = useCallback(() => {
        if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
        }
    }, []);

    // Word selection mode: listen for clicks on words in the epub content
    useEffect(() => {
        if (!wordSelectMode || !renditionRef.current) return;

        const contents = renditionRef.current.getContents();
        if (!contents || contents.length === 0) return;

        const handleWordClick = (e) => {
            e.preventDefault();
            e.stopPropagation();

            const selection = contents[0].window.getSelection();
            // Try to get the clicked word
            let clickedWord = '';
            let clickedNode = null;

            if (selection && selection.rangeCount > 0) {
                // Expand selection to word
                selection.modify('move', 'backward', 'word');
                selection.modify('extend', 'forward', 'word');
                clickedWord = selection.toString().trim();
                if (selection.anchorNode) {
                    clickedNode = selection.anchorNode;
                }
                selection.removeAllRanges();
            }

            if (!clickedWord && e.target) {
                // Fallback: use the text content of the clicked element
                clickedWord = e.target.textContent?.trim().split(/\s+/)[0] || '';
                clickedNode = e.target;
            }

            if (clickedWord) {
                setRsvpStartWord({ text: clickedWord, node: clickedNode });
                setWordSelectMode(false);
                setShowRSVP(true);
                setShowUI(false);
            }
        };

        // Add click listener to the epub content
        const doc = contents[0].document;
        doc.addEventListener('click', handleWordClick, true);

        // Add visual indicator
        doc.body.style.cursor = 'crosshair';

        return () => {
            doc.removeEventListener('click', handleWordClick, true);
            doc.body.style.cursor = '';
        };
    }, [wordSelectMode]);

    // Handle RSVP close - navigate to the last read position and highlight it
    const handleRSVPCloseWithPosition = useCallback((wordInfo) => {
        if (!renditionRef.current) return;

        // If we have a CFI, navigate to it first
        if (wordInfo?.cfi) {
            renditionRef.current.display(wordInfo.cfi).then(() => {
                // After navigation, highlight the word
                highlightLastWord(wordInfo);
            });
        } else if (wordInfo?.parent) {
            // Fallback: just highlight without navigation
            highlightLastWord(wordInfo);
        }
    }, []);

    // Helper function to highlight the last word
    const highlightLastWord = useCallback((wordInfo) => {
        if (!wordInfo?.parent) return;

        try {
            // Find the word text in the parent and wrap it with a highlight span
            const parent = wordInfo.parent;
            const word = wordInfo.originalWord || wordInfo.word;

            // Create a highlight effect on the parent element
            parent.style.transition = 'background-color 0.3s, box-shadow 0.3s';
            parent.style.backgroundColor = 'rgba(255, 75, 75, 0.4)';
            parent.style.boxShadow = '0 0 10px rgba(255, 75, 75, 0.6)';
            parent.style.borderRadius = '4px';

            // Scroll the element into view if needed
            parent.scrollIntoView({ behavior: 'smooth', block: 'center' });

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

    // Fullscreen functionality
    const toggleFullscreen = useCallback(() => {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().then(() => {
                setIsFullscreen(true);
            }).catch(err => {
                console.log('Fullscreen error:', err);
            });
        } else {
            document.exitFullscreen().then(() => {
                setIsFullscreen(false);
            }).catch(err => {
                console.log('Exit fullscreen error:', err);
            });
        }
    }, []);

    // Listen for fullscreen changes (e.g., user pressing Escape)
    useEffect(() => {
        const handleFullscreenChange = () => {
            setIsFullscreen(!!document.fullscreenElement);
        };

        document.addEventListener('fullscreenchange', handleFullscreenChange);
        return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
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

    // Core tap zone handler - used by both outer div clicks and iframe clicks
    // Kindle-style: tap left = prev, tap right = next, tap center = toggle UI
    const handleTapZone = useCallback((clientX, clientY) => {
        // Cancel any auto-hide timer on interaction
        if (uiAutoHideTimerRef.current) {
            clearTimeout(uiAutoHideTimerRef.current);
            uiAutoHideTimerRef.current = null;
        }

        const rect = viewerRef.current?.getBoundingClientRect();
        if (!rect) return;

        // clientX/clientY are relative to the viewport
        const x = clientX - rect.left;
        const width = rect.width;

        // Check if mobile (narrow screen)
        const isMobile = window.innerWidth < 768;

        if (isMobile) {
            // Mobile Kindle-style: left 30% = prev, right 30% = next, center 40% = toggle UI
            if (x < width * 0.3) {
                goPrev();
            } else if (x > width * 0.7) {
                goNext();
            } else {
                // Center tap toggles UI (header, footer, FAB)
                setShowUI((prev) => !prev);
            }
        } else {
            // Desktop: left 25% = prev, right 25% = next, center = toggle UI
            if (x < width * 0.25) {
                goPrev();
            } else if (x > width * 0.75) {
                goNext();
            } else {
                setShowUI((prev) => !prev);
            }
        }
    }, [goNext, goPrev]);

    // Handle tap on viewer outer div (padding area around iframe)
    const handleViewerClick = useCallback((e) => {
        // Don't handle if clicking on a button, interactive element, or RSVP FAB
        if (e.target.closest('button') ||
            e.target.closest('input') ||
            e.target.closest('.rsvp-fab') ||
            e.target.closest('.reader-footer') ||
            e.target.closest('.reader-header')) {
            return;
        }

        handleTapZone(e.clientX, e.clientY);
    }, [handleTapZone]);

    // Keep refs in sync with latest values for use inside epub iframe click handler
    handleTapZoneRef.current = handleTapZone;
    wordSelectModeRef.current = wordSelectMode;

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
                                onClick={(e) => handleButtonClick(e, toggleFullscreen)}
                                title={isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
                            >
                                {isFullscreen ? <Minimize size={24} /> : <Maximize size={24} />}
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

            {/* Word Selection Mode Banner */}
            <AnimatePresence>
                {wordSelectMode && (
                    <motion.div
                        className="word-select-banner"
                        initial={{ opacity: 0, y: -20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -20 }}
                    >
                        <span>👆 Tap a word to start RSVP from there</span>
                        <button onClick={() => setWordSelectMode(false)}>Cancel</button>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* RSVP FAB Button - toggles with UI */}
            <AnimatePresence>
                {showUI && !showRSVP && (
                    <motion.button
                        className={`rsvp-fab ${wordSelectMode ? 'rsvp-fab-active' : ''}`}
                        initial={{ scale: 0, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0, opacity: 0 }}
                        whileHover={{ scale: 1.1 }}
                        whileTap={{ scale: 0.9 }}
                        onClick={handleRSVPClick}
                        onPointerDown={handleRSVPPointerDown}
                        onPointerUp={handleRSVPPointerUp}
                        onPointerLeave={handleRSVPPointerUp}
                        title="RSVP Speed Reading (long-press to pick start word)"
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
                                {`${Math.round(progress * 100)}%`}
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
                    setRsvpStartWord(null);
                }}
                rendition={renditionRef.current}
                startCfi={lastLocationRef.current}
                startWord={rsvpStartWord}
                wpm={settings.rsvpSpeed}
                onWpmChange={(newWpm) => updateSetting('rsvpSpeed', newWpm)}
                onStopAtImage={handleRSVPStopAtImage}
                onCloseWithPosition={handleRSVPCloseWithPosition}
            />
        </div>
    );
};

export default Reader;

