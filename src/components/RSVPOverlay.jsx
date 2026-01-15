import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    X,
    Play,
    Pause,
    SkipBack,
    SkipForward,
    Minus,
    Plus,
    RotateCcw,
} from 'lucide-react';

/**
 * RSVPOverlay - Rapid Serial Visual Presentation speed reading mode
 * Displays words one at a time for speed reading with centered ORP
 */
const RSVPOverlay = ({
    isOpen,
    onClose,
    rendition,
    wpm: initialWpm = 300,
    onWpmChange,
    onStopAtImage,
    onCloseWithPosition, // Called with current word info when closing
}) => {
    // State
    const [words, setWords] = useState([]);
    const [currentIndex, setCurrentIndex] = useState(0);
    const [isPlaying, setIsPlaying] = useState(false);
    const [wpm, setWpm] = useState(initialWpm);
    const [extracting, setExtracting] = useState(false);
    const [error, setError] = useState(null);
    const [stoppedAtImage, setStoppedAtImage] = useState(false);
    const [imageStopIndex, setImageStopIndex] = useState(-1);

    // Refs
    const timerRef = useRef(null);
    const wordsRef = useRef([]);
    const wordElementsRef = useRef([]); // Store references to original text nodes
    const lastWordBeforeImageRef = useRef(null);

    // Calculate interval from WPM
    const getInterval = useCallback(() => {
        return Math.round(60000 / wpm);
    }, [wpm]);

    // Extract text from EPUB content - only from visible viewport
    const extractText = useCallback(async () => {
        if (!rendition) {
            setError('Reader not ready');
            return;
        }

        setExtracting(true);
        setError(null);
        setStoppedAtImage(false);
        setImageStopIndex(-1);

        try {
            // Get the current visible content from the iframe
            const contents = rendition.getContents();

            if (!contents || contents.length === 0) {
                setError('No content available');
                setExtracting(false);
                return;
            }

            const wordList = [];
            wordElementsRef.current = [];
            let hitImage = false;
            let imageStopIdx = -1;

            // Check if we're in paginated or scrollable mode
            const isPaginated = rendition.settings?.flow !== 'scrolled';
            const location = rendition.currentLocation();

            // Paginaged mode: Use CFI range for exact text
            if (isPaginated && location?.start?.cfi && location?.end?.cfi) {
                try {
                    const sR = rendition.getRange(location.start.cfi);
                    const eR = rendition.getRange(location.end.cfi);
                    const range = document.createRange();
                    if (sR.commonAncestorContainer.ownerDocument === eR.commonAncestorContainer.ownerDocument) {
                        range.setStart(sR.startContainer, sR.startOffset);
                        range.setEnd(eR.endContainer, eR.endOffset);

                        const root = range.commonAncestorContainer.nodeType === 3 ? range.commonAncestorContainer.parentElement : range.commonAncestorContainer;
                        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL, {
                            acceptNode: n => ['script', 'style'].includes(n.tagName?.toLowerCase()) ? NodeFilter.FILTER_REJECT : (range.intersectsNode(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT)
                        });

                        let n;
                        while (n = walker.nextNode()) {
                            if (hitImage) break;
                            if (n.nodeType === 1 && ['img', 'svg', 'picture'].includes(n.tagName?.toLowerCase()) && range.intersectsNode(n)) {
                                hitImage = true;
                                imageStopIdx = wordList.length;
                                break;
                            }
                            if (n.nodeType === 3) {
                                let text = n.textContent;

                                // Handle partial text nodes at start/end of page
                                if (n === range.endContainer && n.nodeType === 3) {
                                    text = text.substring(0, range.endOffset);
                                }
                                if (n === range.startContainer && n.nodeType === 3) {
                                    text = text.substring(range.startOffset);
                                }

                                text = text.trim();
                                if (text) {
                                    text.split(/\s+/).filter(w => w.length).forEach(w => {
                                        const cw = w.replace(/[^\w\s.,!?;:'"()—–\-’‘]/g, '');
                                        if (cw.length) {
                                            wordList.push(cw);
                                            wordElementsRef.current.push({ node: n, parent: n.parentElement, word: cw, originalWord: w });
                                        }
                                    });
                                }
                            }
                        }
                    }
                } catch (e) { console.warn("CFI extract failed", e); }
            }

            // Extract text from all visible sections (Fallback)
            if (wordList.length === 0) {
                for (const content of contents) {
                    const doc = content.document;
                    const win = content.window;

                    if (doc && doc.body && win) {
                        // For paginated mode, extract all text since the page is the viewport
                        // For scrollable mode, check viewport bounds
                        const viewportHeight = win.innerHeight;
                        const viewportTop = isPaginated ? 0 : (win.scrollY || 0);
                        const viewportBottom = isPaginated ? Infinity : viewportTop + viewportHeight;

                        // Walk through all elements and collect text
                        const walker = doc.createTreeWalker(
                            doc.body,
                            NodeFilter.SHOW_ALL,
                            {
                                acceptNode: (node) => {
                                    const parent = node.parentElement;
                                    if (!parent) return NodeFilter.FILTER_REJECT;
                                    const tag = parent.tagName?.toLowerCase();
                                    if (['script', 'style', 'noscript'].includes(tag)) {
                                        return NodeFilter.FILTER_REJECT;
                                    }
                                    return NodeFilter.FILTER_ACCEPT;
                                }
                            }
                        );

                        let node;
                        while ((node = walker.nextNode())) {
                            // Check if we've hit an image
                            if (node.nodeType === Node.ELEMENT_NODE) {
                                const tagName = node.tagName?.toLowerCase();
                                if (tagName === 'img' || tagName === 'svg' || tagName === 'picture') {
                                    // Check if this image is in the viewport
                                    const rect = node.getBoundingClientRect();

                                    // In paginated mode, any image on the page triggers stop
                                    // In scrollable mode, check if it's in viewport
                                    if (isPaginated || (rect.top >= 0 && rect.top <= viewportHeight)) {
                                        hitImage = true;
                                        imageStopIdx = wordList.length;
                                        break;
                                    }
                                }
                            }

                            // Extract text from text nodes
                            if (node.nodeType === Node.TEXT_NODE) {
                                const parent = node.parentElement;
                                if (!parent) continue;

                                // Check if element is visible
                                const rect = parent.getBoundingClientRect();

                                // For paginated mode, include all text
                                // For scrollable mode, check viewport bounds
                                if (!isPaginated) {
                                    if (rect.bottom < 0 || rect.top > viewportHeight) {
                                        continue;
                                    }
                                }

                                const text = node.textContent.trim();
                                if (text) {
                                    // Split into words and track their source nodes
                                    const nodeWords = text.split(/\s+/).filter(w => w.length > 0);
                                    for (const word of nodeWords) {
                                        // Clean the word - keep basic punctuation AND smart quotes
                                        const cleanWord = word.replace(/[^\w\s.,!?;:'"()—–\-’‘]/g, '');
                                        if (cleanWord.length > 0) {
                                            wordList.push(cleanWord);
                                            wordElementsRef.current.push({
                                                node: node,
                                                parent: parent,
                                                word: cleanWord,
                                                originalWord: word
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            if (wordList.length === 0) {
                setError('No readable text found on this page');
                setExtracting(false);
                return;
            }

            // If we hit an image, store the last word before it
            if (hitImage && imageStopIdx > 0) {
                lastWordBeforeImageRef.current = wordElementsRef.current[imageStopIdx - 1];
                setImageStopIndex(imageStopIdx);
            }

            setWords(wordList);
            wordsRef.current = wordList;
            setCurrentIndex(0);
            setExtracting(false);
        } catch (err) {
            console.error('Failed to extract text:', err);
            setError('Failed to extract text from page');
            setExtracting(false);
        }
    }, [rendition]);

    // Extract text when overlay opens
    useEffect(() => {
        if (isOpen) {
            extractText();
            setIsPlaying(false);
            setCurrentIndex(0);
        } else {
            // Clean up when closing
            if (timerRef.current) {
                clearInterval(timerRef.current);
                timerRef.current = null;
            }
            setIsPlaying(false);
        }
    }, [isOpen, extractText]);

    // Handle playback
    useEffect(() => {
        if (isPlaying && words.length > 0) {
            timerRef.current = setInterval(() => {
                setCurrentIndex((prev) => {
                    // Check if we should stop at an image
                    if (imageStopIndex > 0 && prev >= imageStopIndex - 1) {
                        setIsPlaying(false);
                        setStoppedAtImage(true);
                        return prev;
                    }

                    if (prev >= words.length - 1) {
                        setIsPlaying(false);
                        return prev;
                    }
                    return prev + 1;
                });
            }, getInterval());
        } else {
            if (timerRef.current) {
                clearInterval(timerRef.current);
                timerRef.current = null;
            }
        }

        return () => {
            if (timerRef.current) {
                clearInterval(timerRef.current);
                timerRef.current = null;
            }
        };
    }, [isPlaying, words.length, getInterval, imageStopIndex]);

    // Handle stopped at image - notify parent and close
    useEffect(() => {
        if (stoppedAtImage && onStopAtImage) {
            const lastWord = lastWordBeforeImageRef.current;
            if (lastWord) {
                onStopAtImage(lastWord);
            }
        }
    }, [stoppedAtImage, onStopAtImage]);

    // Toggle play/pause
    const togglePlay = useCallback(() => {
        if (stoppedAtImage) {
            // Can't play past image
            return;
        }
        if (currentIndex >= words.length - 1) {
            setCurrentIndex(0);
        }
        setIsPlaying((prev) => !prev);
    }, [currentIndex, words.length, stoppedAtImage]);

    // Navigation
    const skipBack = useCallback(() => {
        setCurrentIndex((prev) => Math.max(0, prev - 10));
    }, []);

    const skipForward = useCallback(() => {
        const maxIndex = imageStopIndex > 0 ? Math.min(words.length - 1, imageStopIndex - 1) : words.length - 1;
        setCurrentIndex((prev) => Math.min(maxIndex, prev + 10));
    }, [words.length, imageStopIndex]);

    const restart = useCallback(() => {
        setCurrentIndex(0);
        setIsPlaying(false);
        setStoppedAtImage(false);
    }, []);

    // WPM controls
    const decreaseWpm = useCallback(() => {
        setWpm((prev) => {
            const newWpm = Math.max(100, prev - 50);
            onWpmChange?.(newWpm);
            return newWpm;
        });
    }, [onWpmChange]);

    const increaseWpm = useCallback(() => {
        setWpm((prev) => {
            const newWpm = Math.min(1000, prev + 50);
            onWpmChange?.(newWpm);
            return newWpm;
        });
    }, [onWpmChange]);

    // Handle close - pass current word info for highlighting
    const handleClose = useCallback(() => {
        // Pass current word info to parent for highlighting
        if (onCloseWithPosition && wordElementsRef.current[currentIndex]) {
            onCloseWithPosition(wordElementsRef.current[currentIndex]);
        }
        onClose();
    }, [onClose, onCloseWithPosition, currentIndex]);

    // Handle continue to next page (after image)
    const handleContinueToNextPage = useCallback(() => {
        if (onStopAtImage && lastWordBeforeImageRef.current) {
            onStopAtImage(lastWordBeforeImageRef.current, true); // true = navigate to next
        }
        onClose();
    }, [onStopAtImage, onClose]);

    // Keyboard controls
    useEffect(() => {
        if (!isOpen) return;

        const handleKeyDown = (e) => {
            // Always prevent default and stop propagation for handled keys
            // to ensure Reader doesn't also handle them
            switch (e.key) {
                case ' ':
                case 'Space':
                    e.preventDefault();
                    e.stopPropagation();
                    togglePlay();
                    break;
                case 'Escape':
                    e.preventDefault();
                    e.stopPropagation();
                    handleClose();
                    break;
                case 'ArrowLeft':
                    e.preventDefault();
                    e.stopPropagation();
                    skipBack();
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    e.stopPropagation();
                    skipForward();
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    e.stopPropagation();
                    increaseWpm();
                    break;
                case 'ArrowDown':
                    e.preventDefault();
                    e.stopPropagation();
                    decreaseWpm();
                    break;
                case 'r':
                case 'R':
                    e.preventDefault();
                    e.stopPropagation();
                    restart();
                    break;
                default:
                    break;
            }
        };

        // Use capture phase to handle events before they reach other listeners
        window.addEventListener('keydown', handleKeyDown, true);
        return () => window.removeEventListener('keydown', handleKeyDown, true);
    }, [isOpen, togglePlay, handleClose, skipBack, skipForward, increaseWpm, decreaseWpm, restart]);

    // Get the current word with ORP (Optimal Recognition Point) highlighting
    // ORP is positioned to keep the highlighted letter in the EXACT CENTER
    const getCurrentWordDisplay = () => {
        if (words.length === 0 || currentIndex >= words.length) {
            return { before: '', highlight: '', after: '', orpIndex: 0 };
        }

        const word = words[currentIndex];
        // ORP is typically around 30% into the word, or the first vowel
        // For better centering, we calculate based on word length
        let orpIndex;
        if (word.length <= 1) {
            orpIndex = 0;
        } else if (word.length <= 3) {
            orpIndex = 1;
        } else if (word.length <= 5) {
            orpIndex = 1;
        } else if (word.length <= 9) {
            orpIndex = 2;
        } else if (word.length <= 13) {
            orpIndex = 3;
        } else {
            orpIndex = 4;
        }

        return {
            before: word.slice(0, orpIndex),
            highlight: word[orpIndex] || '',
            after: word.slice(orpIndex + 1),
            orpIndex,
        };
    };

    const wordDisplay = getCurrentWordDisplay();
    const progress = words.length > 0 ? ((currentIndex + 1) / words.length) * 100 : 0;
    const estimatedTimeLeft = words.length > 0
        ? Math.ceil((words.length - currentIndex - 1) / (wpm / 60))
        : 0;

    if (!isOpen) return null;

    return (
        <AnimatePresence>
            <motion.div
                className="rsvp-overlay"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
            >
                {/* Close button */}
                <button className="rsvp-close" onClick={handleClose}>
                    <X size={24} />
                </button>

                {/* Main content area */}
                <div className="rsvp-content">
                    {extracting ? (
                        <div className="rsvp-loading">
                            <motion.div
                                className="loading-spinner"
                                animate={{ rotate: 360 }}
                                transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
                            />
                            <p>Extracting text...</p>
                        </div>
                    ) : error ? (
                        <div className="rsvp-error">
                            <p>{error}</p>
                            <button className="btn btn-primary" onClick={extractText}>
                                Try Again
                            </button>
                        </div>
                    ) : words.length === 0 ? (
                        <div className="rsvp-empty">
                            <p>No words to display</p>
                        </div>
                    ) : (
                        <>
                            {/* Center focus indicator - TOP */}
                            <div className="rsvp-center-indicator rsvp-center-indicator-top" />

                            {/* Word display with centered ORP */}
                            <div className="rsvp-word-container">
                                <div className="rsvp-word">
                                    <span className="word-before">{wordDisplay.before}</span>
                                    <span className="word-highlight">{wordDisplay.highlight}</span>
                                    <span className="word-after">{wordDisplay.after}</span>
                                </div>
                            </div>

                            {/* Center focus indicator - BOTTOM */}
                            <div className="rsvp-center-indicator rsvp-center-indicator-bottom" />

                            {/* Stopped at image message */}
                            {stoppedAtImage && (
                                <motion.div
                                    className="rsvp-image-notice"
                                    initial={{ opacity: 0, y: 10 }}
                                    animate={{ opacity: 1, y: 0 }}
                                >
                                    <p>⚠️ Image detected - Reading paused</p>
                                    <button
                                        className="btn btn-primary rsvp-continue-btn"
                                        onClick={handleContinueToNextPage}
                                    >
                                        Continue to Next Page →
                                    </button>
                                </motion.div>
                            )}

                            {/* Stats */}
                            <div className="rsvp-stats">
                                <span>{currentIndex + 1} / {words.length} words</span>
                                <span>•</span>
                                <span>{estimatedTimeLeft}s remaining</span>
                            </div>
                        </>
                    )}
                </div>

                {/* Controls */}
                <div className="rsvp-controls">
                    {/* Progress bar */}
                    <div className="rsvp-progress">
                        <input
                            type="range"
                            min="0"
                            max={Math.max(1, words.length - 1)}
                            value={currentIndex}
                            onChange={(e) => setCurrentIndex(parseInt(e.target.value))}
                            className="progress-slider"
                        />
                    </div>

                    {/* Main controls */}
                    <div className="rsvp-main-controls">
                        <button className="rsvp-btn" onClick={restart} title="Restart (R)">
                            <RotateCcw size={20} />
                        </button>
                        <button className="rsvp-btn" onClick={skipBack} title="Skip Back 10 (←)">
                            <SkipBack size={20} />
                        </button>
                        <button
                            className={`rsvp-btn rsvp-btn-play ${stoppedAtImage ? 'rsvp-btn-disabled' : ''}`}
                            onClick={togglePlay}
                            title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
                            disabled={stoppedAtImage}
                        >
                            {isPlaying ? <Pause size={28} /> : <Play size={28} />}
                        </button>
                        <button className="rsvp-btn" onClick={skipForward} title="Skip Forward 10 (→)">
                            <SkipForward size={20} />
                        </button>

                        {/* WPM Control */}
                        <div className="rsvp-wpm-control">
                            <button className="rsvp-btn-small" onClick={decreaseWpm} title="Decrease WPM (↓)">
                                <Minus size={16} />
                            </button>
                            <span className="rsvp-wpm-value">{wpm} WPM</span>
                            <button className="rsvp-btn-small" onClick={increaseWpm} title="Increase WPM (↑)">
                                <Plus size={16} />
                            </button>
                        </div>
                    </div>

                    {/* Keyboard hints */}
                    <div className="rsvp-hints">
                        <span>Space: Play/Pause</span>
                        <span>←/→: Skip 10</span>
                        <span>↑/↓: Speed</span>
                        <span>Esc: Close</span>
                    </div>
                </div>
            </motion.div>
        </AnimatePresence>
    );
};

export default RSVPOverlay;
