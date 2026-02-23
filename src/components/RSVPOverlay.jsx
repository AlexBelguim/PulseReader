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
    Eye,
    FastForward,
    ChevronsLeft,
    ChevronsRight,
} from 'lucide-react';

/**
 * RSVPOverlay - Rapid Serial Visual Presentation speed reading mode
 * Displays words one at a time for speed reading with centered ORP
 */
const RSVPOverlay = ({
    isOpen,
    onClose,
    rendition,
    startCfi,
    startWord,
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
    const [showImagePreview, setShowImagePreview] = useState(false);
    const [currentImageSrc, setCurrentImageSrc] = useState(null);

    // Settings State
    const [showSettings, setShowSettings] = useState(false);
    const [sentenceEndMultiplier, setSentenceEndMultiplier] = useState(2.5);   // . ! ?
    const [clauseMultiplier, setClauseMultiplier] = useState(1.5);             // , ; :
    const [dashMultiplier, setDashMultiplier] = useState(1.3);                 // hyphenated words
    const [nameMultiplier, setNameMultiplier] = useState(1.0);                 // capitalized words (names)
    const [longWordMultiplier, setLongWordMultiplier] = useState(1.05);        // per char over 6

    // Refs
    const timerRef = useRef(null);
    const wordsRef = useRef([]);
    const wordElementsRef = useRef([]);
    const lastWordBeforeImageRef = useRef(null);
    const imageStopPointsRef = useRef([]); // Array of { wordIndex, src }
    const currentCfiRef = useRef(null); // Track current CFI for page navigation
    const textNodesRef = useRef([]); // Track text nodes for CFI generation

    // Calculate base interval from WPM
    const getBaseInterval = useCallback(() => {
        return Math.round(60000 / wpm);
    }, [wpm]);

    // Track whether previous word ended a sentence (for name detection)
    const prevWordEndedSentenceRef = useRef(true); // true at start = first word of text

    // Calculate delay for specific word (punctuation, dashes, names, and length handling)
    const getWordDelay = useCallback((word) => {
        const base = getBaseInterval();
        if (!word) return base;

        let multiplier = 1;
        const lastChar = word.slice(-1);
        const isSentenceEnd = ['.', '!', '?'].includes(lastChar);

        // Sentence-ending punctuation multiplier (. ! ?)
        if (sentenceEndMultiplier > 1 && isSentenceEnd) {
            multiplier *= sentenceEndMultiplier;
        }
        // Clause punctuation multiplier (, ; :)
        else if (clauseMultiplier > 1 && [',', ';', ':'].includes(lastChar)) {
            multiplier *= clauseMultiplier;
        }

        // Dash/hyphen multiplier for compound words (e.g., "well-known")
        if (dashMultiplier > 1 && (word.includes('-') || word.includes('—') || word.includes('–'))) {
            multiplier *= dashMultiplier;
        }

        // Name/proper noun multiplier (capitalized words not at start of sentence)
        if (nameMultiplier > 1 && !prevWordEndedSentenceRef.current) {
            const cleanWord = word.replace(/^["""''([\[{]/, ''); // strip leading quotes/brackets
            if (cleanWord.length > 0 && cleanWord[0] === cleanWord[0].toUpperCase() && cleanWord[0] !== cleanWord[0].toLowerCase()) {
                multiplier *= nameMultiplier;
            }
        }

        // Update sentence tracking for next word
        prevWordEndedSentenceRef.current = isSentenceEnd;

        // Length multiplier: per-char increase for every character over 6
        if (longWordMultiplier > 1 && word.length > 6) {
            multiplier *= (1 + (word.length - 6) * (longWordMultiplier - 1));
        }

        return Math.round(base * multiplier);
    }, [getBaseInterval, sentenceEndMultiplier, clauseMultiplier, dashMultiplier, nameMultiplier, longWordMultiplier]);

    // Determine the visible range of the current page using rendition.currentLocation()
    const getVisibleRange = useCallback(() => {
        if (!rendition) return null;
        try {
            const location = rendition.currentLocation();
            if (!location) return null;
            
            const contents = rendition.getContents();
            if (!contents || contents.length === 0) return null;
            
            const content = contents[0];
            
            // Get the start and end CFIs of the visible page
            const startCfiPage = location.start?.cfi;
            const endCfiPage = location.end?.cfi;
            
            if (!startCfiPage || !endCfiPage) return null;
            
            let startRange = null;
            let endRange = null;
            
            try {
                startRange = content.range(startCfiPage);
            } catch (e) {
                // Fallback: use body start
            }
            try {
                endRange = content.range(endCfiPage);
            } catch (e) {
                // Fallback: use body end
            }
            
            return { startRange, endRange, content, startCfiPage, endCfiPage };
        } catch (err) {
            console.log('Could not determine visible range:', err);
            return null;
        }
    }, [rendition]);

    // Check if a node is within the visible range
    const isNodeInVisibleRange = useCallback((node, visibleRange) => {
        if (!visibleRange || !node) return true; // If we can't determine, include everything
        
        const { startRange, endRange } = visibleRange;
        
        try {
            // Check if node comes after the start of visible range
            if (startRange) {
                const startNode = startRange.startContainer;
                const pos = startNode.compareDocumentPosition(node);
                // If node is before the start of visible range, exclude it
                if (pos & Node.DOCUMENT_POSITION_PRECEDING) {
                    return false;
                }
            }
            
            // Check if node comes before the end of visible range
            if (endRange) {
                const endNode = endRange.endContainer;
                const pos = endNode.compareDocumentPosition(node);
                // If node is after the end of visible range, exclude it
                if (pos & Node.DOCUMENT_POSITION_FOLLOWING) {
                    return false;
                }
            }
            
            return true;
        } catch (e) {
            return true; // If comparison fails, include the node
        }
    }, []);

    // Extract text from current rendition page (only visible content)
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
            setShowImagePreview(false);
            setCurrentImageSrc(null);
            lastWordBeforeImageRef.current = null;
            imageStopPointsRef.current = [];

            const contents = rendition.getContents();
            if (!contents || contents.length === 0) {
                setError('No content available');
                setExtracting(false);
                return;
            }

            // Get visible range to filter content to current page only
            const visibleRange = getVisibleRange();

            const extractedWords = [];
            const elements = [];
            const textNodes = []; // Track text nodes for CFI matching

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
                let textWordCount = 0;
                // Track whether we've entered the visible range
                let passedVisibleStart = !visibleRange; // If no range info, include everything
                let passedVisibleEnd = false;
                
                while ((node = walker.nextNode())) {
                    // Check visibility - only include nodes within the visible page
                    if (visibleRange && !passedVisibleEnd) {
                        const nodeToCheck = node.nodeType === Node.TEXT_NODE ? node.parentElement || node : node;
                        const inRange = isNodeInVisibleRange(nodeToCheck, visibleRange);
                        
                        if (!passedVisibleStart) {
                            if (inRange) {
                                passedVisibleStart = true;
                            } else {
                                continue; // Skip nodes before visible range
                            }
                        }
                        
                        if (passedVisibleStart && !inRange) {
                            passedVisibleEnd = true;
                            break; // Stop at end of visible range
                        }
                    }
                    
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        // Skip decorative images that appear before any meaningful text
                        if (textWordCount < 20) {
                            continue;
                        }

                        // Extract image source URL for preview
                        let imgSrc = null;
                        const tag = node.tagName?.toLowerCase();
                        if (tag === 'img') {
                            imgSrc = node.src || node.getAttribute('src');
                        } else if (tag === 'svg') {
                            try {
                                const svgData = new XMLSerializer().serializeToString(node);
                                imgSrc = 'data:image/svg+xml;base64,' + btoa(svgData);
                            } catch (e) {
                                // fallback: no preview available
                            }
                        } else if (tag === 'image') {
                            imgSrc = node.href?.baseVal || node.getAttribute('href') || node.getAttribute('xlink:href');
                        }

                        // Image element - mark as image stop point
                        extractedWords.push({ text: '__IMAGE__', isImage: true, imgSrc });
                        elements.push({ parent: node.parentElement, isImage: true });
                        textNodes.push(null);
                        continue;
                    }

                    const text = node.textContent.trim();
                    if (!text) continue;

                    const nodeWords = text.split(/\s+/).filter(w => w.length > 0);
                    textWordCount += nodeWords.length;
                    nodeWords.forEach((w) => {
                        extractedWords.push({ text: w, isImage: false });
                        elements.push({ parent: node.parentElement, isImage: false });
                        textNodes.push(node);
                    });
                }
            });

            // Build list of all image stop points with their word indices and src URLs
            const allImageStops = [];
            let textCountSoFar = 0;
            for (let i = 0; i < extractedWords.length; i++) {
                if (extractedWords[i].isImage) {
                    allImageStops.push({
                        wordIndex: textCountSoFar,
                        src: extractedWords[i].imgSrc,
                    });
                } else {
                    textCountSoFar++;
                }
            }
            imageStopPointsRef.current = allImageStops;

            // Filter out image markers for display
            const displayWords = extractedWords
                .filter(w => !w.isImage)
                .map(w => w.text);
            const displayElements = elements.filter(e => !e.isImage);
            const displayTextNodes = textNodes.filter((_, i) => !extractedWords[i]?.isImage);

            // Set the first image stop index (if any)
            if (allImageStops.length > 0) {
                setImageStopIndex(allImageStops[0].wordIndex);
            }

            wordsRef.current = displayWords;
            wordElementsRef.current = displayElements;
            textNodesRef.current = displayTextNodes;
            setWords(displayWords);

            // Determine starting word index
            let startIdx = 0;

            // Priority 1: If a specific start word was selected (long-press word pick)
            if (startWord?.text) {
                const targetWord = startWord.text.toLowerCase();
                const targetNode = startWord.node;
                // Try to match by node first, then by word text
                let foundByNode = false;
                if (targetNode) {
                    for (let i = 0; i < displayTextNodes.length; i++) {
                        const tn = displayTextNodes[i];
                        if (tn === targetNode || tn?.parentElement === targetNode) {
                            startIdx = i;
                            foundByNode = true;
                            break;
                        }
                    }
                }
                if (!foundByNode) {
                    // Fallback: find the first occurrence of the word
                    for (let i = 0; i < displayWords.length; i++) {
                        if (displayWords[i].toLowerCase() === targetWord ||
                            displayWords[i].toLowerCase().startsWith(targetWord)) {
                            startIdx = i;
                            break;
                        }
                    }
                }
            }
            // Priority 2: Since we already filtered to visible page content,
            // start from the beginning (which IS the current page start)
            // No need for complex CFI matching - the extraction already handles it
            
            console.log('RSVP starting at word index:', startIdx, 'of', displayWords.length, 'words (visible page only)');
            setCurrentIndex(startIdx);
        } catch (err) {
            console.error('Failed to extract text:', err);
            setError('Failed to extract text from page');
        } finally {
            setExtracting(false);
        }
    }, [rendition, getVisibleRange, isNodeInVisibleRange]);

    // Extract text when overlay opens
    useEffect(() => {
        if (isOpen && rendition) {
            extractText();
            
            // Track location changes for proper close navigation
            const handleRelocated = (location) => {
                if (location?.start?.cfi) {
                    currentCfiRef.current = location.start.cfi;
                }
            };
            rendition.on('relocated', handleRelocated);
            
            return () => {
                rendition.off('relocated', handleRelocated);
                if (timerRef.current) {
                    clearTimeout(timerRef.current);
                }
            };
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
                    // Find the matching image stop point to get its src
                    const stopPoint = imageStopPointsRef.current.find(
                        sp => sp.wordIndex === imageStopIndex
                    );
                    if (stopPoint?.src) {
                        setCurrentImageSrc(stopPoint.src);
                    }
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

        // Generate CFI for current position if possible
        let currentCfi = currentCfiRef.current; // Use tracked CFI as fallback
        
        try {
            const contents = rendition?.getContents();
            if (contents && contents.length > 0 && textNodesRef.current[currentIndex]) {
                const textNode = textNodesRef.current[currentIndex];
                const word = wordsRef.current[currentIndex];
                if (textNode && word) {
                    // Create a range at the start of the current word
                    const doc = textNode.ownerDocument;
                    const range = doc.createRange();
                    const textContent = textNode.textContent;
                    const wordIndex = textContent.indexOf(word);
                    if (wordIndex >= 0) {
                        range.setStart(textNode, wordIndex);
                        range.setEnd(textNode, wordIndex + word.length);
                        // Generate CFI from the range
                        const wordCfi = contents[0].cfiFromRange(range);
                        if (wordCfi) {
                            currentCfi = wordCfi;
                        }
                    }
                }
            }
        } catch (err) {
            console.log('Could not generate CFI for current position:', err);
        }

        console.log('RSVP closing with CFI:', currentCfi);

        // Notify parent of current position with CFI
        if (onCloseWithPosition) {
            onCloseWithPosition({
                word: words[currentIndex],
                originalWord: wordsRef.current[currentIndex],
                parent: wordElementsRef.current[currentIndex]?.parent,
                index: currentIndex,
                cfi: currentCfi,
            });
        }

        onClose();
    }, [onClose, onCloseWithPosition, currentIndex, words, rendition]);

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

    // Page navigation
    const goToNextPage = useCallback(async () => {
        if (!rendition) {
            console.log('No rendition available for page navigation');
            return;
        }
        
        // Check if rendition has the next method
        if (typeof rendition.next !== 'function') {
            console.log('Rendition does not have next method');
            return;
        }
        
        setIsPlaying(false);
        setStoppedAtImage(false);
        setShowImagePreview(false);
        
        try {
            // Call next() - it returns a promise
            const result = rendition.next();
            
            // Handle both promise and non-promise returns
            if (result && typeof result.then === 'function') {
                await result;
            }
            
            // Wait for the new content to render, then re-extract visible page
            setTimeout(() => {
                extractText();
            }, 300);
        } catch (err) {
            console.error('Failed to go to next page:', err);
        }
    }, [rendition, extractText]);

    const goToPrevPage = useCallback(async () => {
        if (!rendition) {
            console.log('No rendition available for page navigation');
            return;
        }
        
        // Check if rendition has the prev method
        if (typeof rendition.prev !== 'function') {
            console.log('Rendition does not have prev method');
            return;
        }
        
        setIsPlaying(false);
        setStoppedAtImage(false);
        setShowImagePreview(false);
        
        try {
            // Call prev() - it returns a promise
            const result = rendition.prev();
            
            // Handle both promise and non-promise returns
            if (result && typeof result.then === 'function') {
                await result;
            }
            
            // Wait for the new content to render, then re-extract visible page
            setTimeout(() => {
                extractText();
            }, 300);
        } catch (err) {
            console.error('Failed to go to previous page:', err);
        }
    }, [rendition, extractText]);

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

    // Handle showing the image in a preview modal
    const handleShowImage = useCallback(() => {
        // Find the current image stop point to get its src
        const stopPoint = imageStopPointsRef.current.find(
            sp => sp.wordIndex === imageStopIndex
        );
        if (stopPoint?.src) {
            setCurrentImageSrc(stopPoint.src);
        }
        setShowImagePreview(true);
    }, [imageStopIndex]);

    // Handle closing the image preview modal
    const handleCloseImagePreview = useCallback(() => {
        setShowImagePreview(false);
    }, []);

    // Handle continuing past the image (skip it and resume reading)
    const handleContinuePastImage = useCallback(() => {
        setStoppedAtImage(false);
        setCurrentImageSrc(null);
        setShowImagePreview(false);

        // Find the next image stop point after the current one
        const currentStopIdx = imageStopPointsRef.current.findIndex(
            sp => sp.wordIndex === imageStopIndex
        );
        const nextStop = imageStopPointsRef.current[currentStopIdx + 1];

        if (nextStop) {
            setImageStopIndex(nextStop.wordIndex);
        } else {
            setImageStopIndex(-1); // No more images
        }

        // Resume playing
        setIsPlaying(true);
    }, [imageStopIndex]);

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
                    if (e.shiftKey) {
                        goToPrevPage();
                    } else {
                        skipBack();
                    }
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    if (e.shiftKey) {
                        goToNextPage();
                    } else {
                        skipForward();
                    }
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
    }, [isOpen, togglePlay, skipBack, skipForward, goToPrevPage, goToNextPage, increaseWpm, decreaseWpm, restart, handleClose]);

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
                                    <p>🖼️ Image detected - Reading paused</p>
                                    <div className="rsvp-image-actions">
                                        {currentImageSrc && (
                                            <button
                                                className="btn rsvp-show-image-btn"
                                                onClick={handleShowImage}
                                            >
                                                <Eye size={16} />
                                                Show Image
                                            </button>
                                        )}
                                        <button
                                            className="btn rsvp-continue-btn"
                                            onClick={handleContinuePastImage}
                                        >
                                            <FastForward size={16} />
                                            Continue
                                        </button>
                                    </div>
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
                                <div className="rsvp-settings-title">Delay Multipliers</div>

                                <div className="rsvp-setting-item">
                                    <div className="rsvp-setting-header">
                                        <label>Sentence End <span className="rsvp-setting-chars">. ! ?</span></label>
                                        <span className="rsvp-setting-value">{sentenceEndMultiplier.toFixed(1)}×</span>
                                    </div>
                                    <input
                                        type="range"
                                        min="1"
                                        max="5"
                                        step="0.1"
                                        value={sentenceEndMultiplier}
                                        onChange={(e) => setSentenceEndMultiplier(parseFloat(e.target.value))}
                                        className="rsvp-setting-slider"
                                    />
                                </div>

                                <div className="rsvp-setting-item">
                                    <div className="rsvp-setting-header">
                                        <label>Clauses <span className="rsvp-setting-chars">, ; :</span></label>
                                        <span className="rsvp-setting-value">{clauseMultiplier.toFixed(1)}×</span>
                                    </div>
                                    <input
                                        type="range"
                                        min="1"
                                        max="4"
                                        step="0.1"
                                        value={clauseMultiplier}
                                        onChange={(e) => setClauseMultiplier(parseFloat(e.target.value))}
                                        className="rsvp-setting-slider"
                                    />
                                </div>

                                <div className="rsvp-setting-item">
                                    <div className="rsvp-setting-header">
                                        <label>Dashed Words <span className="rsvp-setting-chars">- — –</span></label>
                                        <span className="rsvp-setting-value">{dashMultiplier.toFixed(1)}×</span>
                                    </div>
                                    <input
                                        type="range"
                                        min="1"
                                        max="3"
                                        step="0.1"
                                        value={dashMultiplier}
                                        onChange={(e) => setDashMultiplier(parseFloat(e.target.value))}
                                        className="rsvp-setting-slider"
                                    />
                                </div>

                                <div className="rsvp-setting-item">
                                    <div className="rsvp-setting-header">
                                        <label>Names <span className="rsvp-setting-chars">Capitalized</span></label>
                                        <span className="rsvp-setting-value">{nameMultiplier.toFixed(1)}×</span>
                                    </div>
                                    <input
                                        type="range"
                                        min="1"
                                        max="3"
                                        step="0.1"
                                        value={nameMultiplier}
                                        onChange={(e) => setNameMultiplier(parseFloat(e.target.value))}
                                        className="rsvp-setting-slider"
                                    />
                                </div>

                                <div className="rsvp-setting-item">
                                    <div className="rsvp-setting-header">
                                        <label>Long Words <span className="rsvp-setting-chars">&gt;6 chars</span></label>
                                        <span className="rsvp-setting-value">+{Math.round((longWordMultiplier - 1) * 100)}%/char</span>
                                    </div>
                                    <input
                                        type="range"
                                        min="1"
                                        max="1.2"
                                        step="0.01"
                                        value={longWordMultiplier}
                                        onChange={(e) => setLongWordMultiplier(parseFloat(e.target.value))}
                                        className="rsvp-setting-slider"
                                    />
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

                        <button className="rsvp-btn" onClick={goToPrevPage} title="Previous Page (Shift+←)">
                            <ChevronsLeft size={20} />
                        </button>
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
                        <button className="rsvp-btn" onClick={goToNextPage} title="Next Page (Shift+→)">
                            <ChevronsRight size={20} />
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
                        <span>Shift+←/→: Page</span>
                        <span>↑/↓: Speed</span>
                        <span>Esc: Close</span>
                    </div>
                </div>
            </motion.div>

            {/* Image Preview Modal */}
            <AnimatePresence>
                {showImagePreview && currentImageSrc && (
                    <motion.div
                        className="rsvp-image-modal-backdrop"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={handleCloseImagePreview}
                    >
                        <motion.div
                            className="rsvp-image-modal"
                            initial={{ opacity: 0, scale: 0.9 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.9 }}
                            onClick={(e) => e.stopPropagation()}
                        >
                            <button
                                className="rsvp-image-modal-close"
                                onClick={handleCloseImagePreview}
                            >
                                <X size={20} />
                            </button>
                            <img
                                src={currentImageSrc}
                                alt="Book image"
                                className="rsvp-image-modal-img"
                            />
                            <button
                                className="btn rsvp-continue-btn rsvp-image-modal-continue"
                                onClick={handleContinuePastImage}
                            >
                                <FastForward size={16} />
                                Continue Reading
                            </button>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </AnimatePresence>
    );
};

export default RSVPOverlay;
