import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    X,
    Play,
    Pause,
    SkipBack,
    SkipForward,
    Minus,
    Plus,
    Settings,
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
    onCloseWithPosition,
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

    // Settings State
    const [showSettings, setShowSettings] = useState(false);
    const [punctuationDelayEnabled, setPunctuationDelayEnabled] = useState(true);
    const [lengthDelayEnabled, setLengthDelayEnabled] = useState(true);

    // Refs
    const timerRef = useRef(null);
    const wordsRef = useRef([]);
    const wordElementsRef = useRef([]);
    const lastWordBeforeImageRef = useRef(null);

    // Calculate base interval from WPM
    const getBaseInterval = useCallback(() => {
        return Math.round(60000 / wpm);
    }, [wpm]);

    // Calculate delay for specific word (punctuation and length handling)
    const getWordDelay = useCallback((word) => {
        const base = getBaseInterval();
        if (!word) return base;

        let multiplier = 1;
        const lastChar = word.slice(-1);

        // Punctuation multipliers
        if (punctuationDelayEnabled) {
            if (['.', '!', '?'].includes(lastChar)) {
                multiplier *= 2.5;
            } else if ([',', ';', ':'].includes(lastChar)) {
                multiplier *= 1.5;
            }
        }

        // Length multiplier: +5% for every character over 6
        if (lengthDelayEnabled && word.length > 6) {
            multiplier *= (1 + (word.length - 6) * 0.05);
        }

        return Math.round(base * multiplier);
    }, [getBaseInterval, punctuationDelayEnabled, lengthDelayEnabled]);

    // Extract text from current rendition page
    const extractText = useCallback(async () => {
        if (!rendition) {
            setError('No rendition available');
            return;
        }

        try {
            setExtracting(true);
            setError(null);
            setStoppedAtImage(false);
            setImageStopIndex(-1);
            lastWordBeforeImageRef.current = null;

            const contents = rendition.getContents();
            if (!contents || contents.length === 0) {
                setError('No content available');
                setExtracting(false);
                return;
            }

            const extractedWords = [];
            const elements = [];

            contents.forEach((content) => {
                const doc = content.document;
                if (!doc || !doc.body) return;

                const walker = doc.createTreeWalker(
                    doc.body,
                    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
                    {
                        acceptNode: (node) => {
                            if (node.nodeType === Node.ELEMENT_NODE) {
                                const tag = node.tagName?.toLowerCase();
                                if (tag === 'img' || tag === 'image' || tag === 'svg') {
                                    return NodeFilter.FILTER_ACCEPT;
                                }
                                return NodeFilter.FILTER_SKIP;
                            }
                            if (node.nodeType === Node.TEXT_NODE) {
                                const text = node.textContent?.trim();
                                if (text && text.length > 0) {
                                    return NodeFilter.FILTER_ACCEPT;
                                }
                            }
                            return NodeFilter.FILTER_SKIP;
                        }
                    }
                );

                let node;
                while ((node = walker.nextNode())) {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        // Image element - mark as image stop point
                        extractedWords.push({ text: '__IMAGE__', isImage: true });
                        elements.push({ parent: node.parentElement, isImage: true });
                        continue;
                    }

                    const text = node.textContent.trim();
                    if (!text) continue;

                    const nodeWords = text.split(/\s+/).filter(w => w.length > 0);
                    nodeWords.forEach((w) => {
                        extractedWords.push({ text: w, isImage: false });
                        elements.push({ parent: node.parentElement, isImage: false });
                    });
                }
            });

            // Check for image stop points
            let stopIdx = -1;
            for (let i = 0; i < extractedWords.length; i++) {
                if (extractedWords[i].isImage) {
                    stopIdx = i;
                    break;
                }
            }

            // Filter out image markers for display
            const displayWords = extractedWords
                .filter(w => !w.isImage)
                .map(w => w.text);
            const displayElements = elements.filter(e => !e.isImage);

            if (stopIdx >= 0) {
                // Count actual words before the image
                const wordsBeforeImage = extractedWords
                    .slice(0, stopIdx)
                    .filter(w => !w.isImage)
                    .map(w => w.text);

                setImageStopIndex(wordsBeforeImage.length);
                if (wordsBeforeImage.length > 0) {
                    lastWordBeforeImageRef.current = {
                        word: wordsBeforeImage[wordsBeforeImage.length - 1],
                        parent: displayElements[wordsBeforeImage.length - 1]?.parent
                    };
                }
            }

            wordsRef.current = displayWords;
            wordElementsRef.current = displayElements;
            setWords(displayWords);
            setCurrentIndex(0);
        } catch (err) {
            console.error('Failed to extract text:', err);
            setError('Failed to extract text from page');
        } finally {
            setExtracting(false);
        }
    }, [rendition]);

    // Extract text when overlay opens
    useEffect(() => {
        if (isOpen && rendition) {
            extractText();
        }
        return () => {
            if (timerRef.current) {
                clearTimeout(timerRef.current);
            }
        };
    }, [isOpen, rendition, extractText]);

    // Calculate ORP (Optimal Recognition Point) index
    const getORPIndex = useCallback((word) => {
        if (!word) return 0;
        return Math.floor(word.length * 0.35);
    }, []);

    // Get word display parts (before, highlight, after)
    const wordDisplay = useMemo(() => {
        const word = words[currentIndex] || '';
        if (!word) return { before: '', highlight: '', after: '' };

        const orpIdx = getORPIndex(word);
        return {
            before: word.slice(0, orpIdx),
            highlight: word[orpIdx] || '',
            after: word.slice(orpIdx + 1),
        };
    }, [words, currentIndex, getORPIndex]);

    // Estimated time remaining
    const estimatedTimeLeft = useMemo(() => {
        const remaining = Math.max(0, words.length - currentIndex - 1);
        const seconds = Math.round((remaining / wpm) * 60);
        return seconds;
    }, [words.length, currentIndex, wpm]);

    // Schedule next word with variable delay
    const scheduleNextWord = useCallback(() => {
        if (timerRef.current) {
            clearTimeout(timerRef.current);
        }

        const currentWord = wordsRef.current[currentIndex];
        const delay = getWordDelay(currentWord);

        timerRef.current = setTimeout(() => {
            setCurrentIndex((prev) => {
                const next = prev + 1;

                // Check if we hit an image stop
                if (imageStopIndex >= 0 && next >= imageStopIndex) {
                    setIsPlaying(false);
                    setStoppedAtImage(true);
                    return prev;
                }

                // Check if we've reached the end
                if (next >= wordsRef.current.length) {
                    setIsPlaying(false);
                    return prev;
                }

                return next;
            });
        }, delay);
    }, [currentIndex, getWordDelay, imageStopIndex]);

    // Play/pause loop
    useEffect(() => {
        if (isPlaying && words.length > 0) {
            scheduleNextWord();
        } else {
            if (timerRef.current) {
                clearTimeout(timerRef.current);
            }
        }

        return () => {
            if (timerRef.current) {
                clearTimeout(timerRef.current);
            }
        };
    }, [isPlaying, currentIndex, scheduleNextWord, words.length]);

    // Toggle play/pause
    const togglePlay = useCallback(() => {
        if (stoppedAtImage) return;
        if (currentIndex >= words.length - 1) {
            setCurrentIndex(0);
        }
        setIsPlaying((prev) => !prev);
    }, [stoppedAtImage, currentIndex, words.length]);

    // Close handler
    const handleClose = useCallback(() => {
        setIsPlaying(false);
        if (timerRef.current) {
            clearTimeout(timerRef.current);
        }

        // Notify parent of current position
        if (onCloseWithPosition && wordElementsRef.current[currentIndex]) {
            onCloseWithPosition({
                word: words[currentIndex],
                originalWord: wordsRef.current[currentIndex],
                parent: wordElementsRef.current[currentIndex]?.parent,
                index: currentIndex,
            });
        }

        onClose();
    }, [onClose, onCloseWithPosition, currentIndex, words]);

    // Navigation controls
    const skipBack = useCallback(() => {
        setCurrentIndex((prev) => Math.max(0, prev - 10));
    }, []);

    const skipForward = useCallback(() => {
        setCurrentIndex((prev) => Math.min(words.length - 1, prev + 10));
    }, [words.length]);

    const restart = useCallback(() => {
        setCurrentIndex(0);
        setIsPlaying(false);
        setStoppedAtImage(false);
    }, []);

    // WPM controls
    const increaseWpm = useCallback(() => {
        setWpm((prev) => {
            const newWpm = Math.min(1000, prev + 25);
            onWpmChange?.(newWpm);
            return newWpm;
        });
    }, [onWpmChange]);

    const decreaseWpm = useCallback(() => {
        setWpm((prev) => {
            const newWpm = Math.max(50, prev - 25);
            onWpmChange?.(newWpm);
            return newWpm;
        });
    }, [onWpmChange]);

    // Handle continue to next page (when stopped at image)
    const handleContinueToNextPage = useCallback(() => {
        if (onStopAtImage) {
            onStopAtImage(lastWordBeforeImageRef.current, true);
        }
    }, [onStopAtImage]);

    // Keyboard shortcuts
    useEffect(() => {
        if (!isOpen) return;

        const handleKeyDown = (e) => {
            switch (e.key) {
                case ' ':
                    e.preventDefault();
                    togglePlay();
                    break;
                case 'ArrowLeft':
                    e.preventDefault();
                    skipBack();
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    skipForward();
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    increaseWpm();
                    break;
                case 'ArrowDown':
                    e.preventDefault();
                    decreaseWpm();
                    break;
                case 'r':
                case 'R':
                    restart();
                    break;
                case 'Escape':
                    handleClose();
                    break;
                default:
                    break;
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, togglePlay, skipBack, skipForward, increaseWpm, decreaseWpm, restart, handleClose]);

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
                    {/* Settings Menu */}
                    <AnimatePresence>
                        {showSettings && (
                            <motion.div
                                className="rsvp-settings-menu"
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: 10 }}
                            >
                                <div className="rsvp-setting-item">
                                    <label>
                                        <input
                                            type="checkbox"
                                            checked={punctuationDelayEnabled}
                                            onChange={(e) => setPunctuationDelayEnabled(e.target.checked)}
                                        />
                                        Punctuation Pauses
                                    </label>
                                    <span className="rsvp-setting-desc">Pause at sentences and clauses</span>
                                </div>
                                <div className="rsvp-setting-item">
                                    <label>
                                        <input
                                            type="checkbox"
                                            checked={lengthDelayEnabled}
                                            onChange={(e) => setLengthDelayEnabled(e.target.checked)}
                                        />
                                        Long Word Pauses
                                    </label>
                                    <span className="rsvp-setting-desc">Slower speed for long words</span>
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>

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
                        <button
                            className={`rsvp-btn ${showSettings ? 'active' : ''}`}
                            onClick={() => setShowSettings(!showSettings)}
                            title="Settings"
                        >
                            <Settings size={20} />
                        </button>

                        <div className="rsvp-controls-divider" />

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
