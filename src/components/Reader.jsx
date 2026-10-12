import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import ePub, { EpubCFI } from 'epubjs';
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
import {
    getBook,
    getProgress,
    updateBookProgress,
    saveProgress,
    getLocationsCache,
    saveLocationsCache,
} from '../services/db';
import { useReaderSettings } from '../hooks/useReaderSettings';
import ReaderSettings from './ReaderSettings';
import TableOfContents from './TableOfContents';
import RSVPOverlay from './RSVPOverlay';

// Signature of the settings that actually affect typography/layout. Used to
// avoid re-paginating the book when an unrelated setting (e.g. RSVP speed)
// changes.
const computeStyleSig = (s) => JSON.stringify([
    s.colorTheme, s.fontType, s.fontSize, s.fontWeight,
    s.lineSpacing, s.textAlignment, s.pageMargins,
]);

const Reader = () => {
    const { bookId } = useParams();
    const navigate = useNavigate();
    const viewerRef = useRef(null);
    const renditionRef = useRef(null);
    const bookRef = useRef(null);
    const isNavigatingRef = useRef(false);
    const lastLocationRef = useRef(null);
    // Reading position is state we own, not a reading of wherever epub.js
    // happens to have landed. Every reflow WE initiate -- fold/fullscreen
    // resize, a typography change, a programmatic restore -- makes epub.js emit
    // 'relocated' for a position the reader never navigated to, and
    // display(cfi) settles on the page START, which after a reflow sits earlier
    // than the anchor. Left unguarded, each one walks saved progress backward.
    //
    // A depth counter rather than a boolean: resize bursts and typography
    // changes overlap, and with a boolean whichever finishes first clears the
    // flag while the other is still re-laying out. Non-zero means "a reflow we
    // asked for is in flight, so relocated is noise, not navigation".
    const reflowDepthRef = useRef(0);
    const beginReflow = useCallback(() => {
        reflowDepthRef.current += 1;
    }, []);
    const endReflow = useCallback(() => {
        reflowDepthRef.current = Math.max(0, reflowDepthRef.current - 1);
    }, []);

    // State
    const [book, setBook] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [chapters, setChapters] = useState([]);
    const [currentChapter, setCurrentChapter] = useState('');
    const [, setCurrentLocation] = useState(null);
    const [progress, setProgress] = useState(0);
    const [locationsReady, setLocationsReady] = useState(false);
    const [currentPage, setCurrentPage] = useState(0);
    const [totalPages, setTotalPages] = useState(0);

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
    // Latest style generator (so the content hook injects current settings into
    // newly-loaded sections) and the last applied typography signature.
    const getEpubStylesRef = useRef(getEpubStyles);
    getEpubStylesRef.current = getEpubStyles;
    const styleSigRef = useRef(computeStyleSig(settings));

    // Fraction of the whole book that one screen page spans. Calibrated once
    // per layout (open / font change / fold) and frozen while reading, so the
    // page total stays stable instead of jumping per page. pageFractionGoodRef
    // says the fraction came from a section long enough to trust; until then
    // every relocated retries, so opening on a cover page self-corrects.
    const pageFractionRef = useRef(0);
    const pageFractionGoodRef = useRef(false);
    // spine index -> { first, count } of that section's location entries.
    const sectionLocsRef = useRef(new Map());

    // Where a spine section sits in the locations list. Locations are sorted,
    // so binary-search on the spine step (parsing only log N cfis); cached
    // because it is content-only and never changes for an opened book.
    const sectionLocations = useCallback((index) => {
        const cache = sectionLocsRef.current;
        if (cache.has(index)) return cache.get(index);
        const list = bookRef.current?.locations?._locations;
        if (!Array.isArray(list) || !list.length) return null;
        const lowerBound = (spine) => {
            let lo = 0, hi = list.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (new EpubCFI(list[mid]).spinePos < spine) lo = mid + 1;
                else hi = mid;
            }
            return lo;
        };
        const first = lowerBound(index);
        const info = { first, count: lowerBound(index + 1) - first };
        cache.set(index, info);
        return info;
    }, []);

    // Derive a screen-accurate "page X / Y". Pass recalibrate=true on a layout
    // change so the fraction (and therefore the total) is re-measured for the
    // new font size / margins / viewport; otherwise only the current page moves.
    //
    // Locations are ~1000-character chunks, and a phone page often holds less
    // than that -- so the visible span's start/end percentages were usually
    // identical (no total at all) or one chunk apart (total == chunk count,
    // far too low). Instead use the current section: epub.js knows exactly how
    // many screen pages it laid the section out into, and the locations know
    // what share of the book the section is.
    const updatePageCount = useCallback((location, recalibrate = false) => {
        try {
            const loc = bookRef.current?.locations;
            const totalLocs = loc?.length?.();
            if (!totalLocs) return;
            const index = location?.start?.index;
            const displayed = location?.start?.displayed;
            if (index == null || !(displayed?.total > 0)) return;
            const sec = sectionLocations(index);
            if (!sec) return;

            if (recalibrate) pageFractionGoodRef.current = false;
            if (!pageFractionGoodRef.current) {
                // A handful of chunks keeps the +/-1 chunk rounding small;
                // shorter sections (cover, title page) are too coarse to trust.
                const trusted = sec.count >= 3;
                if (trusted || !(pageFractionRef.current > 0)) {
                    const frac = (sec.count / totalLocs) / displayed.total;
                    if (frac > 0 && isFinite(frac)) {
                        pageFractionRef.current = frac;
                        pageFractionGoodRef.current = trusted;
                    }
                }
            }

            const frac = pageFractionRef.current;
            if (!(frac > 0)) return;
            const total = Math.max(1, Math.round(1 / frac));
            // Pages before this section + the page within it, so each page
            // turn moves the counter by exactly one inside a section.
            const before = Math.round((sec.first / totalLocs) / frac);
            const cur = Math.min(total, Math.max(1, before + (displayed.page || 1)));
            setTotalPages(total);
            setCurrentPage(cur);
        } catch {
            // best-effort — fall back to the percentage display
        }
    }, [sectionLocations]);

    // Briefly highlight just the first few words at a CFI — used to show
    // "you were here" when resuming a book and after a fold/fullscreen
    // re-layout. Wraps only the words (not the whole paragraph) in a temporary
    // inline span, then unwraps it. Inline wrapping doesn't change layout, so
    // it can't repaginate. Falls back to an element flash if wrapping fails.
    const flashCfi = useCallback((cfi) => {
        if (!cfi) return;
        try {
            const contents = renditionRef.current?.getContents();
            if (!contents || contents.length === 0) return;
            const startRange = contents[0].range(cfi);
            if (!startRange) return;

            const node = startRange.startContainer;
            const startOffset = startRange.startOffset;

            // Build a range over the first ~6 words from the anchor.
            if (node.nodeType === Node.TEXT_NODE) {
                const doc = node.ownerDocument;
                const rest = node.textContent.slice(startOffset);
                const m = rest.match(/^\s*(?:\S+\s+){0,5}\S+/);
                const len = m ? m[0].length : Math.min(rest.length, 40);
                if (len > 0) {
                    const range = doc.createRange();
                    range.setStart(node, startOffset);
                    range.setEnd(node, Math.min(startOffset + len, node.textContent.length));

                    const span = doc.createElement('span');
                    span.style.cssText =
                        'background-color: rgba(255,75,75,0.45); box-shadow: 0 0 8px rgba(255,75,75,0.5); border-radius: 3px;';
                    range.surroundContents(span);

                    setTimeout(() => {
                        const parent = span.parentNode;
                        if (!parent) return;
                        while (span.firstChild) parent.insertBefore(span.firstChild, span);
                        parent.removeChild(span);
                        parent.normalize();
                    }, 3000);
                    return;
                }
            }

            // Fallback: flash the containing element
            const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
            if (!el) return;
            el.style.transition = 'background-color 0.5s ease, box-shadow 0.5s ease';
            el.style.backgroundColor = 'rgba(255, 75, 75, 0.25)';
            el.style.boxShadow = '0 0 8px rgba(255, 75, 75, 0.4)';
            el.style.borderRadius = '4px';
            setTimeout(() => {
                el.style.backgroundColor = '';
                el.style.boxShadow = '';
                el.style.borderRadius = '';
            }, 2500);
        } catch {
            // flash is a best-effort visual hint
        }
    }, []);

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

                // Reading position now lives in a separate store; merge it in
                // so the resume logic below can read book.lastRead.
                const prog = await getProgress(parseInt(bookId));
                if (prog) {
                    bookData.lastRead = prog.cfi;
                    bookData.progress = prog.percentage;
                    bookData.isRead = prog.isRead;
                    // Seed the footer until locations load -- relocated carries
                    // no percentage before then, so it would read 0%.
                    setProgress(prog.percentage || 0);
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
                sectionLocsRef.current = new Map();
                pageFractionRef.current = 0;
                pageFractionGoodRef.current = false;

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

                // Inject custom CSS synchronously as an inline <style> on every
                // content document. Doing this inline (instead of an async blob
                // <link>) means the very first pagination already uses the saved
                // font size / margins — so settings apply the moment a book
                // opens instead of only after toggling something. The ref keeps
                // newly-loaded sections on the latest settings.
                rendition.hooks.content.register((contents) => {
                    const doc = contents.document;
                    if (!doc) return;
                    let styleEl = doc.getElementById('reader-custom-styles');
                    if (!styleEl) {
                        styleEl = doc.createElement('style');
                        styleEl.id = 'reader-custom-styles';
                        doc.head.appendChild(styleEl);
                    }
                    styleEl.textContent = getEpubStylesRef.current();
                });

                // Handle location changes
                rendition.on('relocated', (location) => {
                    // Only the reader moves the anchor. Anything emitted while
                    // a reflow we initiated is in flight is a consequence of
                    // that reflow, not navigation, so it is dropped.
                    if (reflowDepthRef.current > 0) {
                        isNavigatingRef.current = false;
                        return;
                    }

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

                    // Rendered page X / Y from the currently visible span.
                    // The span shrinks/grows with font size, margins and screen
                    // width, so this naturally reflects the live layout.
                    updatePageCount(location);

                    // Save progress to database (lightweight — progress store only)
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

                    // Map iframe coordinates to viewport coordinates. Use the
                    // frame the click came from: the continuous (scrolled)
                    // manager keeps several section iframes alive.
                    const iframe = e.view?.frameElement
                        || viewerRef.current?.querySelector('iframe');
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
                    // Deliberately NOT wrapped in beginReflow/endReflow. This
                    // first relocated is what seeds chapter, progress and page
                    // count -- suppress it and the reader opens blank. It does
                    // floor a mid-page cfi to the page start, but that settles
                    // after one open rather than compounding, so it is left as
                    // the one place epub.js is allowed to define the position.
                    await rendition.display(startLocation);

                    // Flash the resumed position after content is rendered
                    // Use a one-time relocated handler to ensure content is ready
                    const flashOnce = () => {
                        rendition.off('relocated', flashOnce);
                        setTimeout(() => flashCfi(startLocation), 200);
                    };
                    rendition.on('relocated', flashOnce);
                } else {
                    await rendition.display();
                }

                // Locations power the % slider and the page counter. They are
                // content-based (independent of font/screen), so we cache them
                // per book — first open generates once, every open after is
                // instant instead of re-parsing the whole book.
                const LOCATION_CHARS = 1000;
                const onLocationsReady = () => {
                    setLocationsReady(true);
                    const loc = renditionRef.current?.currentLocation?.();
                    if (loc) updatePageCount(loc, true);
                    if (lastLocationRef.current) {
                        const pct = epubBook.locations.percentageFromCfi(lastLocationRef.current);
                        if (pct !== undefined && pct !== null) setProgress(pct);
                    }
                };

                const cached = await getLocationsCache(parseInt(bookId));
                if (cached?.json && cached.chars === LOCATION_CHARS) {
                    try {
                        epubBook.locations.load(cached.json);
                        onLocationsReady();
                    } catch {
                        epubBook.locations.generate(LOCATION_CHARS).then(onLocationsReady);
                    }
                } else {
                    epubBook.locations.generate(LOCATION_CHARS).then(() => {
                        try {
                            saveLocationsCache(parseInt(bookId), {
                                json: epubBook.locations.save(),
                                chars: LOCATION_CHARS,
                            });
                        } catch { /* cache is best-effort */ }
                        onLocationsReady();
                    });
                }

                // Auto-hide UI after 3 seconds for immersive reading
                uiAutoHideTimerRef.current = setTimeout(() => {
                    setShowUI(false);
                }, 3000);

                // Update prev settings ref
                prevSettingsRef.current = {
                    viewMode: settings.viewMode,
                    twoPageLayout: settings.twoPageLayout,
                };
                styleSigRef.current = computeStyleSig(settings);

            } catch (err) {
                console.error('Failed to initialize reader:', err);
                setError('Failed to initialize reader');
            }
        };

        initReader();

        // Handle screen resize (Samsung Fold, orientation change, fullscreen).
        // Capture the page's top position the INSTANT a resize burst begins —
        // resize()/reflow emits 'relocated' which would otherwise overwrite
        // lastLocationRef and land us on the wrong (often previous) page.
        let resizeTimeout;
        let pendingResizeCfi = null;
        let resizeReflowOpen = false;
        const handleResize = () => {
            if (pendingResizeCfi == null) {
                pendingResizeCfi = lastLocationRef.current;
                // Guard from the FIRST event of the burst, not after the
                // debounce settles. epub.js registers its own throttled resize
                // listener and reflows on its schedule -- by the time a 300ms
                // debounce ran, its 'relocated' had already overwritten the
                // anchor, which is why folding the phone lost your place even
                // though this handler looked like it was holding the position.
                resizeReflowOpen = true;
                beginReflow();
            }
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(async () => {
                const cfi = pendingResizeCfi;
                pendingResizeCfi = null;
                try {
                    if (renditionRef.current && cfi) {
                        renditionRef.current.resize('100%', '100%');
                        try {
                            await renditionRef.current.display(cfi);
                        } catch { /* ignore */ }
                        const loc = renditionRef.current.currentLocation?.();
                        if (loc) updatePageCount(loc, true); // layout changed
                        // Flash the word/line that was at the top so you can see
                        // where you were after the fold/unfold or fullscreen toggle.
                        await new Promise((resolve) => setTimeout(resolve, 150));
                        flashCfi(cfi);
                    }
                } finally {
                    // Balanced on every path, including the no-rendition and
                    // no-cfi ones. A leaked increment would silently stop
                    // saving progress for the rest of the session.
                    if (resizeReflowOpen) {
                        resizeReflowOpen = false;
                        endReflow();
                    }
                }
            }, 300); // Debounce to ride out the fold/fullscreen animation
        };

        window.addEventListener('resize', handleResize);

        return () => {
            window.removeEventListener('resize', handleResize);
            clearTimeout(resizeTimeout);
            // The debounced tail never runs, so close the guard it opened.
            if (resizeReflowOpen) {
                resizeReflowOpen = false;
                endReflow();
            }
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

    // Update rendition styles when settings change (not requiring re-init)
    useEffect(() => {
        if (!renditionRef.current) return;

        // Skip if viewMode or twoPageLayout changed (handled by re-init)
        if (settings.viewMode !== prevSettingsRef.current.viewMode ||
            settings.twoPageLayout !== prevSettingsRef.current.twoPageLayout) {
            return;
        }

        // Only re-style/re-paginate when a setting that affects typography
        // actually changed. This stops unrelated changes — most importantly
        // adjusting the RSVP speed mid-read — from re-paginating the book.
        const sig = computeStyleSig(settings);
        if (sig === styleSigRef.current) return;
        styleSigRef.current = sig;

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
        // breaks the paginated layout. Re-calibrate the page total afterwards
        // so "page X / Y" reflects the new typography.
        if (lastLocationRef.current) {
            // Re-paginating is not navigation. Unguarded, every font-size or
            // margin nudge saved whatever page start the reflow settled on, and
            // the book crept backward one adjustment at a time.
            const anchor = lastLocationRef.current;
            beginReflow();
            rendition.display(anchor)
                .then(() => {
                    const loc = rendition.currentLocation?.();
                    if (loc) updatePageCount(loc, true);
                })
                .catch(() => { /* ignore */ })
                .finally(() => {
                    // Held briefly past the promise: epub.js queues its location
                    // report, so 'relocated' can land a tick after display()
                    // resolves. Releasing immediately would let exactly the
                    // event we are guarding against through.
                    setTimeout(() => {
                        lastLocationRef.current = anchor;
                        endReflow();
                    }, 150);
                });
        }

    }, [settings, getEpubStyles, themeColors, updatePageCount, beginReflow, endReflow]);

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
            let clickedOffset = null;

            if (selection && selection.rangeCount > 0) {
                // Expand selection to word
                selection.modify('move', 'backward', 'word');
                selection.modify('extend', 'forward', 'word');
                clickedWord = selection.toString().trim();
                if (selection.anchorNode) {
                    clickedNode = selection.anchorNode;
                    // Where in the node the word begins. The anchor stays put
                    // while 'extend' moves the focus, so this is the word start.
                    // Without it the overlay can only match the text node, and
                    // long-pressing the fifth word of a paragraph starts reading
                    // from that paragraph's first word instead.
                    clickedOffset = selection.anchorOffset;
                }
                selection.removeAllRanges();
            }

            if (!clickedWord && e.target) {
                // Fallback: use the text content of the clicked element
                clickedWord = e.target.textContent?.trim().split(/\s+/)[0] || '';
                clickedNode = e.target;
            }

            if (clickedWord) {
                setRsvpStartWord({ text: clickedWord, node: clickedNode, offset: clickedOffset });
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

    // Handle RSVP close - navigate to the last read position, persist the
    // exact word we stopped on, and highlight it.
    const handleRSVPCloseWithPosition = useCallback((wordInfo) => {
        if (!renditionRef.current) return;

        const cfi = wordInfo?.cfi;
        if (cfi) {
            let pct;
            try { pct = bookRef.current?.locations?.percentageFromCfi?.(cfi); } catch { /* ignore */ }
            // display() emits 'relocated' reporting the page START, which loses
            // the exact word. Re-asserting the cfi afterwards was a race: the
            // event can arrive after the promise resolves, and then it won.
            // Suppressing it instead makes the save below the only writer.
            beginReflow();
            renditionRef.current.display(cfi)
                .then(() => {
                    lastLocationRef.current = cfi;
                    saveProgress(parseInt(bookId), { cfi, percentage: pct ?? progress });
                    // relocated is suppressed, so drive the UI ourselves rather
                    // than leaving the bar parked at the pre-RSVP position.
                    if (pct !== undefined && pct !== null) setProgress(pct);
                    const loc = renditionRef.current?.currentLocation?.();
                    if (loc) {
                        setCurrentLocation(loc);
                        if (loc.start?.href) setCurrentChapter(loc.start.href);
                        updatePageCount(loc);
                    }
                    highlightLastWord(wordInfo);
                })
                .catch(() => { /* ignore */ })
                .finally(() => {
                    setTimeout(endReflow, 150);
                });
        } else if (wordInfo?.parent) {
            // Fallback: just highlight without navigation
            highlightLastWord(wordInfo);
        }
        // highlightLastWord is deliberately absent: it is declared below this
        // callback, so naming it here would hit the TDZ during render.
    }, [bookId, progress, beginReflow, endReflow, updatePageCount]);

    // Helper function to highlight the last word
    const highlightLastWord = useCallback((wordInfo) => {
        if (!wordInfo?.parent) return;

        try {
            // Find the word text in the parent and wrap it with a highlight span
            const parent = wordInfo.parent;

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
            // showRSVP belongs here too. Without it, arrow keys inside the RSVP
            // overlay paginate the book underneath: each skip turns the hidden
            // page, fires an unguarded relocated that overwrites saved progress,
            // and once the hidden rendition crosses a section boundary the
            // overlay's next-section load reads the drifted index and skips a
            // chapter. Escape was worse -- it navigated away while the overlay
            // was still awaiting its closing display(), unmounting mid-save.
            if (showSettings || showTOC || showRSVP) return;

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
    }, [goNext, goPrev, navigate, showSettings, showTOC, showRSVP]);

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
        const y = clientY - rect.top;
        const width = rect.width;

        // Check if mobile (narrow screen)
        const isMobile = window.innerWidth < 768;

        if (isMobile) {
            // Mobile Kindle-style: top strip = toggle UI, then left 30% = prev,
            // right 30% = next, center 40% = toggle UI
            if (y < rect.height * 0.2) {
                setShowUI((prev) => !prev);
            } else if (x < width * 0.3) {
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
                                {totalPages > 0
                                    ? `${currentPage} / ${totalPages}`
                                    : `${Math.round(progress * 100)}%`}
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

