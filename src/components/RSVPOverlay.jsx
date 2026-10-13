import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { EpubCFI } from 'epubjs';
import { tokenizeWithOffsets } from '../utils/tokenize';
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
// Extra delay (ms) applied to the first word of a new chapter so crossing a
// section boundary feels like a brief breath rather than an abrupt jump.
const CHAPTER_PAUSE_MS = 1200;

// Smaller than this (CSS px, either side) is decoration, not an illustration:
// gaiji (characters set as inline images in Japanese light novels), scene-break
// ornaments, dividers, publisher logos.
const MIN_ILLUSTRATION_PX = 100;

function isIllustration(node) {
    let w = 0;
    let h = 0;
    try {
        const rect = node.getBoundingClientRect();
        w = rect.width;
        h = rect.height;
    } catch { /* not laid out */ }
    if (!w && !h && node.naturalWidth) {
        w = node.naturalWidth;
        h = node.naturalHeight;
    }
    // Not laid out and not loaded yet: give it the benefit of the doubt.
    // Missing a full-page illustration is worse than one pause too many.
    if (!w && !h) return true;
    return w >= MIN_ILLUSTRATION_PX && h >= MIN_ILLUSTRATION_PX;
}

/**
 * Index of the first word that is on screen, or -1. Words run in document
 * order, and in paginated mode the page a word is on never goes down as the
 * index goes up (scrolled mode: the same holds for its vertical position), so
 * "is this word before the visible area?" flips once and can be binary-searched.
 */
function firstWordOnScreen(rendition, textNodes, offsets, words) {
    try {
        const box = rendition?.manager?.container?.getBoundingClientRect?.();
        if (!box || !textNodes.length) return -1;
        const scrolled = rendition.settings?.flow === 'scrolled';
        const rectOf = (i) => {
            const node = textNodes[i];
            if (!node) return null;
            const range = node.ownerDocument.createRange();
            range.setStart(node, offsets[i]);
            range.setEnd(node, offsets[i] + words[i].length);
            const r = range.getBoundingClientRect();
            const frame = node.ownerDocument.defaultView?.frameElement?.getBoundingClientRect();
            if (!frame || (!r.width && !r.height)) return null;
            return { left: frame.left + r.left, right: frame.left + r.right, top: frame.top + r.top, bottom: frame.top + r.bottom };
        };
        const before = (r) => (scrolled ? r.bottom <= box.top + 1 : r.right <= box.left + 1);
        let lo = 0;
        let hi = textNodes.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            const r = rectOf(mid);
            if (r && before(r)) lo = mid + 1;
            else hi = mid;
        }
        const r = lo < textNodes.length ? rectOf(lo) : null;
        const visible = r && (scrolled
            ? r.top < box.bottom && r.bottom > box.top
            : r.left < box.right && r.right > box.left);
        return visible ? lo : -1;
    } catch {
        return -1;
    }
}

const RSVPOverlay = ({
    isOpen,
    onClose,
    rendition,
    startWord,
    wpm: initialWpm = 300,
    onWpmChange,
    tone = 'bright',
    onToneChange,
    onProgress,
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
    // The stop we are currently paused on ({ wordIndex, src }), or null. This
    // used to be a forward-only index pointer, which went stale the moment the
    // reader skipped or scrubbed: playback then matched `next >= pointer`
    // forever and froze on an image it had already gone past.
    const [activeStop, setActiveStop] = useState(null);
    const [showImagePreview, setShowImagePreview] = useState(false);
    const [currentImageSrc, setCurrentImageSrc] = useState(null);
    const [chapterBreak, setChapterBreak] = useState(false); // brief "new chapter" hint
    const [advancing, setAdvancing] = useState(false); // loading the next section

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
    const wordOffsetsRef = useRef([]); // Char offset of each word within its text node
    // Image stops the reader has already been shown and dismissed, so passing
    // one again (or scrubbing back over it) does not re-trigger the pause.
    const dismissedStopsRef = useRef(new Set());
    const isLoadingNextPageRef = useRef(false); // Prevent double-triggers during section advance
    const chapterPauseRef = useRef(false); // Apply CHAPTER_PAUSE_MS to the next word
    const chapterBreakTimerRef = useRef(null);
    const pageNavTimerRef = useRef(null);
    // Each section document's CFI base, recorded at extraction. Building a
    // word's CFI from this instead of the live rendition still works while
    // the reader is being torn down (leaving with RSVP open), when
    // rendition.getContents() is already empty.
    const cfiBasesRef = useRef(new WeakMap());

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
            const cleanWord = word.replace(/^["""''([[{]/, ''); // strip leading quotes/brackets
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

    // Walk one or more rendition section documents and build a flat, continuous
    // word stream for the WHOLE section (chapter) — not just the visible page.
    // Streaming the whole chapter is what lets RSVP keep going smoothly instead
    // of stopping and re-extracting at every rendered page.
    const extractWordsFromContents = useCallback((contents) => {
        const extractedWords = [];
        const elements = [];
        const textNodes = [];

        contents.forEach((content) => {
            const doc = content.document;
            if (!doc || !doc.body) return;
            if (content.cfiBase) cfiBasesRef.current.set(doc, content.cfiBase);

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
                    const tag = node.tagName?.toLowerCase();
                    // Light novels wrap most illustrations as <svg><image href>.
                    // Use the <image> inside (the walker visits it next): an
                    // svg serialised on its own can't load the picture it
                    // points at, so its preview came out blank.
                    if (tag === 'svg' && node.querySelector('image')) continue;
                    if (!isIllustration(node)) continue;

                    let imgSrc = null;
                    if (tag === 'img') {
                        imgSrc = node.src || node.getAttribute('src');
                    } else if (tag === 'svg') {
                        try {
                            const svgData = new XMLSerializer().serializeToString(node);
                            // URI-encoded rather than btoa: btoa throws on any
                            // non-Latin-1 character, e.g. Japanese text in the svg.
                            imgSrc = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgData);
                        } catch {
                            // fallback: no preview available
                        }
                    } else if (tag === 'image') {
                        imgSrc = node.href?.baseVal || node.getAttribute('href') || node.getAttribute('xlink:href');
                    }

                    extractedWords.push({ text: '__IMAGE__', isImage: true, imgSrc });
                    elements.push({ parent: node.parentElement, isImage: true });
                    textNodes.push(null);
                    continue;
                }

                const raw = node.textContent;
                if (!raw || !raw.trim()) continue;

                // Each word carries the offset it actually sits at, so the CFI
                // builder never has to search for it by value. See tokenize.js.
                for (const { text: w, offset } of tokenizeWithOffsets(raw)) {
                    extractedWords.push({ text: w, isImage: false, offset });
                    elements.push({ parent: node.parentElement, isImage: false });
                    textNodes.push(node);
                }
            }
        });

        // Image stop points, indexed against the display (text-only) word list:
        // a stop at wordIndex k sits just before word k, so 0 is "before the
        // first word" (an illustration opening the chapter) and words.length is
        // "after the last". Each gets its own id, because several can share a
        // wordIndex (back-to-back plates, an image-only section) and dismissing
        // one must not dismiss the rest.
        const imageStops = [];
        let textCountSoFar = 0;
        for (let i = 0; i < extractedWords.length; i++) {
            if (extractedWords[i].isImage) {
                const src = extractedWords[i].imgSrc;
                const prev = imageStops[imageStops.length - 1];
                // The same picture twice in a row is one illustration (an
                // <img> fallback next to its <svg>, say), not two stops.
                if (prev && prev.wordIndex === textCountSoFar && src && prev.src === src) continue;
                imageStops.push({ id: imageStops.length, wordIndex: textCountSoFar, src });
            } else {
                textCountSoFar++;
            }
        }

        const textOnly = extractedWords.filter(w => !w.isImage);
        const displayWords = textOnly.map(w => w.text);
        // Parallel to displayWords: the character offset of each word inside its
        // own text node, so nothing ever has to search for a word by value.
        const displayOffsets = textOnly.map(w => w.offset);
        const displayElements = elements.filter(e => !e.isImage);
        const displayTextNodes = textNodes.filter((_, i) => !extractedWords[i]?.isImage);

        return { displayWords, displayOffsets, displayElements, displayTextNodes, imageStops };
    }, []);

    // Extract the current section (whole chapter) and choose the starting word.
    const extractText = useCallback(async () => {
        if (!rendition) {
            setError('No rendition available');
            return;
        }

        try {
            setExtracting(true);
            setError(null);
            setStoppedAtImage(false);
            setActiveStop(null);
            dismissedStopsRef.current = new Set();
            setShowImagePreview(false);
            setCurrentImageSrc(null);
            lastWordBeforeImageRef.current = null;
            imageStopPointsRef.current = [];
            chapterPauseRef.current = false;
            setChapterBreak(false);

            const contents = rendition.getContents();
            if (!contents || contents.length === 0) {
                setError('No content available');
                setExtracting(false);
                return;
            }

            // Visible range is used only to choose WHERE to start reading, so we
            // begin at the on-screen position rather than the top of the chapter.
            const visibleRange = getVisibleRange();

            const { displayWords, displayOffsets, displayElements, displayTextNodes, imageStops } =
                extractWordsFromContents(contents);

            // No "current stop" pointer to prime -- the stop to pause at is
            // derived from where the reader actually is, each tick.
            imageStopPointsRef.current = imageStops;

            wordsRef.current = displayWords;
            wordElementsRef.current = displayElements;
            textNodesRef.current = displayTextNodes;
            wordOffsetsRef.current = displayOffsets;
            setWords(displayWords);

            // Determine starting word index
            let startIdx = 0;

            if (startWord?.text) {
                // Priority 1: a specific word was picked via long-press
                const targetWord = startWord.text.toLowerCase();
                const targetNode = startWord.node;
                const targetOffset = startWord.offset;
                let foundByNode = false;
                if (targetNode) {
                    // Land on the word that was actually pressed. Matching the
                    // node alone took its FIRST word, so long-pressing halfway
                    // down a paragraph rewound to the top of it.
                    let firstInNode = -1;
                    let bestByOffset = -1;
                    let bestDelta = Infinity;
                    for (let i = 0; i < displayTextNodes.length; i++) {
                        const tn = displayTextNodes[i];
                        const exact = tn === targetNode;
                        if (!exact && tn?.parentElement !== targetNode) continue;
                        if (firstInNode === -1) firstInNode = i;
                        // Offsets only mean anything inside the node they were
                        // measured in. The parentElement branch can span several
                        // sibling text nodes, so it cannot use them.
                        if (exact && typeof targetOffset === 'number') {
                            const delta = Math.abs(displayOffsets[i] - targetOffset);
                            if (delta < bestDelta) {
                                bestDelta = delta;
                                bestByOffset = i;
                            }
                        }
                    }
                    const picked = bestByOffset !== -1 ? bestByOffset : firstInNode;
                    if (picked !== -1) {
                        startIdx = picked;
                        foundByNode = true;
                    }
                }
                if (!foundByNode) {
                    for (let i = 0; i < displayWords.length; i++) {
                        if (displayWords[i].toLowerCase() === targetWord ||
                            displayWords[i].toLowerCase().startsWith(targetWord)) {
                            startIdx = i;
                            break;
                        }
                    }
                }
            } else if ((startIdx = firstWordOnScreen(rendition, displayTextNodes, displayOffsets, displayWords)) >= 0) {
                // Priority 2: the first word actually on screen. (Found by
                // geometry: the node comparison below works per text node, and
                // one paragraph's text node spans many pages, so it started
                // RSVP at the top of the paragraph -- often pages back.)
            } else if (visibleRange) {
                startIdx = 0;
                // Fallback: the first word of the currently visible page
                for (let i = 0; i < displayTextNodes.length; i++) {
                    const tn = displayTextNodes[i];
                    const nodeToCheck = tn?.nodeType === Node.TEXT_NODE ? (tn.parentElement || tn) : tn;
                    if (tn && isNodeInVisibleRange(nodeToCheck, visibleRange)) {
                        startIdx = i;
                        break;
                    }
                }
            }

            if (startIdx < 0) startIdx = 0;
            console.log('RSVP starting at word index:', startIdx, 'of', displayWords.length, 'words (full section)');
            setCurrentIndex(startIdx);
        } catch (err) {
            console.error('Failed to extract text:', err);
            setError('Failed to extract text from page');
        } finally {
            setExtracting(false);
        }
    }, [rendition, getVisibleRange, isNodeInVisibleRange, extractWordsFromContents, startWord]);

    // The first image stop crossed in moving from `from` to `to`, ignoring any
    // the reader has already dismissed. Derived from the actual position every
    // time it is asked, so there is no pointer left to go stale.
    const findCrossedStop = useCallback((from, to) => (
        imageStopPointsRef.current.find(
            (sp) => sp.wordIndex > from
                && sp.wordIndex <= to
                && !dismissedStopsRef.current.has(sp.id)
        ) || null
    ), []);

    // A not-yet-seen stop sitting exactly at `wordIndex`. Moving forward never
    // "crosses" a stop at the reader's own position, so the ones at the start
    // of a section (wordIndex 0) and any queued behind a just-dismissed one
    // are found with this instead.
    const findStopAt = useCallback((wordIndex) => (
        imageStopPointsRef.current.find(
            (sp) => sp.wordIndex === wordIndex && !dismissedStopsRef.current.has(sp.id)
        ) || null
    ), []);

    const pauseAtStop = useCallback((stop) => {
        setIsPlaying(false);
        setStoppedAtImage(true);
        setActiveStop(stop);
        setCurrentImageSrc(stop.src || null);
    }, []);

    // Advance to the next spine section (chapter) and keep streaming. Reading
    // continues uninterrupted within a chapter; only chapter boundaries get a
    // short pause (CHAPTER_PAUSE_MS) so the change of section is noticeable.
    const loadNextSection = useCallback(async () => {
        if (!rendition || isLoadingNextPageRef.current) return;
        isLoadingNextPageRef.current = true;
        setAdvancing(true);

        try {
            const book = rendition.book;
            const loc = rendition.currentLocation();

            // Resolve the current spine index, then the next section.
            let curIndex = loc?.start?.index;
            if (typeof curIndex !== 'number' && loc?.start?.href && book?.spine) {
                curIndex = book.spine.get(loc.start.href)?.index;
            }
            const nextSection = (book?.spine && typeof curIndex === 'number')
                ? book.spine.get(curIndex + 1)
                : null;

            if (!nextSection) {
                // End of book
                setIsPlaying(false);
                isLoadingNextPageRef.current = false;
                return;
            }

            const result = rendition.display(nextSection.href);
            if (result && typeof result.then === 'function') {
                await result;
            }
            // Let the new section render before reading from it
            await new Promise(resolve => setTimeout(resolve, 250));

            const contents = rendition.getContents();
            if (!contents || contents.length === 0) {
                setIsPlaying(false);
                isLoadingNextPageRef.current = false;
                return;
            }

            const { displayWords, displayOffsets, displayElements, displayTextNodes, imageStops } =
                extractWordsFromContents(contents);

            imageStopPointsRef.current = imageStops;
            // Dismissals are indexed by word position, which restarts at 0 in a
            // new section -- carrying them over would silently skip its images.
            dismissedStopsRef.current = new Set();
            setActiveStop(null);

            if (displayWords.length === 0 && imageStops.length === 0) {
                // Nothing to read or look at (nav doc, blank page) — skip it.
                // Awaited, so this call's finally can't clear the loading flag
                // while the next one is still running.
                isLoadingNextPageRef.current = false;
                await loadNextSection();
                return;
            }

            wordsRef.current = displayWords;
            wordElementsRef.current = displayElements;
            textNodesRef.current = displayTextNodes;
            wordOffsetsRef.current = displayOffsets;
            setWords(displayWords);
            setCurrentIndex(0);
            setStoppedAtImage(false);
            setShowImagePreview(false);
            setCurrentImageSrc(null);

            // An illustration opening the chapter, or a section that is only
            // an illustration (how most light novels ship their plates). These
            // used to be skipped outright: the old filter dropped any image
            // before a section's 20th word, and a wordless section was passed
            // over as empty.
            const opening = imageStops.find((sp) => sp.wordIndex === 0);
            if (opening) {
                pauseAtStop(opening);
                console.log('RSVP paused at an illustration opening the next section');
                return;
            }

            // Take a brief breath at the chapter boundary.
            chapterPauseRef.current = true;
            setChapterBreak(true);
            clearTimeout(chapterBreakTimerRef.current);
            chapterBreakTimerRef.current = setTimeout(() => setChapterBreak(false), CHAPTER_PAUSE_MS);

            console.log('RSVP advanced to next chapter:', displayWords.length, 'words');
        } catch (err) {
            console.error('Failed to advance to next chapter:', err);
            setIsPlaying(false);
        } finally {
            isLoadingNextPageRef.current = false;
            setAdvancing(false);
        }
    }, [rendition, extractWordsFromContents, pauseAtStop]);

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
        let delay = getWordDelay(currentWord);
        // Linger on the first word of a freshly-loaded chapter.
        if (chapterPauseRef.current) {
            delay += CHAPTER_PAUSE_MS;
            chapterPauseRef.current = false;
        }

        timerRef.current = setTimeout(() => {
            // Decided out here, not inside a setCurrentIndex updater. Updaters
            // must be pure -- pausing and setting the image from inside one made
            // React fire those effects twice under StrictMode. currentIndex is a
            // dependency of this callback, so reading it directly is current.
            const prev = currentIndex;
            const next = prev + 1;

            const stop = findCrossedStop(prev, next);
            if (stop) {
                pauseAtStop(stop);
                return;
            }

            // Reached end of current chapter — stream into the next section
            if (next >= wordsRef.current.length) {
                loadNextSection();
                return;
            }

            setCurrentIndex(next);
        }, delay);
    }, [currentIndex, getWordDelay, loadNextSection, findCrossedStop, pauseAtStop]);

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
        // Opened on an illustration-only page: nothing to read here, so play
        // means "on to the next chapter".
        if (words.length === 0) {
            setIsPlaying(true);
            loadNextSection();
            return;
        }
        if (currentIndex >= words.length - 1) {
            setCurrentIndex(0);
        }
        setIsPlaying((prev) => !prev);
    }, [stoppedAtImage, currentIndex, words.length, loadNextSection]);

    // CFI of the word at `idx`, or null. Shared by close and the progress
    // reports below, so both save exactly the same position.
    const buildWordCfi = useCallback((idx) => {
        try {
            const textNode = textNodesRef.current[idx];
            const word = wordsRef.current[idx];
            if (!textNode || !word) return null;
            // The base of the section this word is in. The scrolled
            // (continuous) manager keeps several sections alive, and a CFI
            // built with another section's base points into the wrong chapter.
            const doc = textNode.ownerDocument;
            const cfiBase = cfiBasesRef.current.get(doc);
            if (!cfiBase) return null;
            const textContent = textNode.textContent;
            // The offset recorded when this word was tokenised -- the
            // occurrence the reader is actually on. indexOf(word) found the
            // first one in the node, so any repeated word ("the", "and", a
            // character's name) saved a position earlier in the paragraph
            // than where reading had reached.
            const offset = wordOffsetsRef.current[idx];
            if (
                offset == null
                || offset + word.length > textContent.length
                || !textContent.startsWith(word, offset)
            ) return null;
            const range = doc.createRange();
            range.setStart(textNode, offset);
            range.setEnd(textNode, offset + word.length);
            return new EpubCFI(range, cfiBase).toString() || null;
        } catch (err) {
            console.log('Could not generate CFI for current position:', err);
            return null;
        }
    }, []);

    // Report the reading position while RSVP runs, not only on close: every
    // PROGRESS_EVERY words, whenever playback stops, when the app goes to the
    // background (the last moment a phone reliably lets a PWA write), and
    // when the reader unmounts (Back gesture). Closing the app mid-chapter
    // used to resume wherever RSVP had been started.
    const PROGRESS_EVERY = 25;
    const currentIndexRef = useRef(0);
    currentIndexRef.current = currentIndex;
    const onProgressRef = useRef(onProgress);
    onProgressRef.current = onProgress;
    const lastReportedRef = useRef(null);
    const reportProgress = useCallback(() => {
        if (!wordsRef.current.length) return;
        const cfi = buildWordCfi(currentIndexRef.current);
        if (!cfi || cfi === lastReportedRef.current) return;
        lastReportedRef.current = cfi;
        onProgressRef.current?.(cfi);
    }, [buildWordCfi]);

    useEffect(() => {
        if (isOpen && isPlaying && currentIndex > 0 && currentIndex % PROGRESS_EVERY === 0) reportProgress();
    }, [isOpen, isPlaying, currentIndex, reportProgress]);

    useEffect(() => {
        if (isOpen && !isPlaying) reportProgress();
    }, [isOpen, isPlaying, reportProgress]);

    useEffect(() => {
        if (!isOpen) return;
        const onHide = () => { if (document.visibilityState === 'hidden') reportProgress(); };
        document.addEventListener('visibilitychange', onHide);
        window.addEventListener('pagehide', reportProgress);
        return () => {
            document.removeEventListener('visibilitychange', onHide);
            window.removeEventListener('pagehide', reportProgress);
            // Closing via X/Esc saves through onCloseWithPosition; this covers
            // leaving the reader with RSVP still open.
            reportProgress();
        };
    }, [isOpen, reportProgress]);

    // Close handler
    const handleClose = useCallback(() => {
        setIsPlaying(false);
        if (timerRef.current) {
            clearTimeout(timerRef.current);
        }

        // CFI of the current word, falling back to the tracked page CFI
        const currentCfi = buildWordCfi(currentIndex) || currentCfiRef.current;

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
    }, [onClose, onCloseWithPosition, currentIndex, words, buildWordCfi]);

    // Navigation controls
    const skipBack = useCallback(() => {
        setCurrentIndex((prev) => Math.max(0, prev - 10));
    }, []);

    const skipForward = useCallback(() => {
        const target = Math.min(words.length - 1, currentIndex + 10);
        // A ten-word jump can vault a full-page illustration. The old check
        // (next >= pointer) meant to catch that overshoot but did it from the
        // playback tick, where a passed stop then matched forever and froze
        // playback. Checking the span actually crossed keeps the intent.
        const stop = findCrossedStop(currentIndex, target);
        if (stop) {
            setCurrentIndex(Math.max(currentIndex, stop.wordIndex - 1));
            pauseAtStop(stop);
            return;
        }
        setCurrentIndex(target);
    }, [words.length, currentIndex, findCrossedStop, pauseAtStop]);

    const restart = useCallback(() => {
        setCurrentIndex(0);
        setIsPlaying(false);
        setStoppedAtImage(false);
        setChapterBreak(false);
        chapterPauseRef.current = false;
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
            clearTimeout(pageNavTimerRef.current);
            pageNavTimerRef.current = setTimeout(() => {
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
            clearTimeout(pageNavTimerRef.current);
            pageNavTimerRef.current = setTimeout(() => {
                extractText();
            }, 300);
        } catch (err) {
            console.error('Failed to go to previous page:', err);
        }
    }, [rendition, extractText]);

    // WPM controls
    // The parent is told outside the state updater: updaters run during
    // render, and setting Reader's state from inside one is a React error.
    const increaseWpm = useCallback(() => {
        const newWpm = Math.min(1000, wpm + 25);
        setWpm(newWpm);
        onWpmChange?.(newWpm);
    }, [wpm, onWpmChange]);

    const decreaseWpm = useCallback(() => {
        const newWpm = Math.max(50, wpm - 25);
        setWpm(newWpm);
        onWpmChange?.(newWpm);
    }, [wpm, onWpmChange]);

    // Handle showing the image in a preview modal
    const handleShowImage = useCallback(() => {
        // The stop we paused on already carries its src -- no lookup, and
        // nothing to go stale.
        if (activeStop?.src) {
            setCurrentImageSrc(activeStop.src);
        }
        setShowImagePreview(true);
    }, [activeStop]);

    // Handle closing the image preview modal
    const handleCloseImagePreview = useCallback(() => {
        setShowImagePreview(false);
    }, []);

    // Handle continuing past the image (skip it and resume reading)
    const handleContinuePastImage = useCallback(() => {
        // Mark this one seen instead of advancing a pointer to "the next
        // image". The tick finds the next stop by position anyway, so there is
        // no pointer left to fall out of step with where the reader is.
        if (activeStop) {
            dismissedStopsRef.current.add(activeStop.id);
            // Another illustration right behind this one (a run of colour
            // plates, two images on one page): show it before any words.
            const queued = findStopAt(activeStop.wordIndex);
            if (queued) {
                setShowImagePreview(false);
                pauseAtStop(queued);
                return;
            }
        }
        setActiveStop(null);
        setStoppedAtImage(false);
        setCurrentImageSrc(null);
        setShowImagePreview(false);

        // A section that is only illustrations has no words to resume; go
        // straight on to the next one.
        if (wordsRef.current.length === 0) {
            setIsPlaying(true);
            loadNextSection();
            return;
        }

        // Resume playing
        setIsPlaying(true);
    }, [activeStop, findStopAt, pauseAtStop, loadNextSection]);

    // Reader renders this overlay unconditionally and it merely returns null
    // when closed, so closing unmounts nothing and no cleanup runs. Timers
    // scheduled just before a close would otherwise still fire: the page-nav
    // one re-extracts text into a closed overlay 300ms later, at exactly the
    // moment the Reader is re-displaying the saved position.
    useEffect(() => {
        if (isOpen) return;
        clearTimeout(timerRef.current);
        clearTimeout(chapterBreakTimerRef.current);
        clearTimeout(pageNavTimerRef.current);
    }, [isOpen]);

    // Keyboard shortcuts
    useEffect(() => {
        if (!isOpen) return;

        const handleKeyDown = (e) => {
            switch (e.key) {
                case ' ':
                    e.preventDefault();
                    if (stoppedAtImage) handleContinuePastImage();
                    else togglePlay();
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
    }, [isOpen, togglePlay, stoppedAtImage, handleContinuePastImage, skipBack, skipForward, goToPrevPage, goToNextPage, increaseWpm, decreaseWpm, restart, handleClose]);

    if (!isOpen) return null;

    return (
        <AnimatePresence>
            <motion.div
                key="rsvp-overlay"
                className="rsvp-overlay"
                data-tone={tone}
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
                    ) : stoppedAtImage ? (
                        // Paused at an illustration: show it, full size within
                        // the overlay. Tap it for the larger preview.
                        <motion.div
                            className="rsvp-image-stop"
                            initial={{ opacity: 0, scale: 0.98 }}
                            animate={{ opacity: 1, scale: 1 }}
                        >
                            {currentImageSrc ? (
                                <img
                                    src={currentImageSrc}
                                    alt="Illustration from the book"
                                    className="rsvp-image-stop-img"
                                    onClick={handleShowImage}
                                    onError={() => setCurrentImageSrc(null)}
                                />
                            ) : (
                                <p className="rsvp-image-stop-missing">Illustration (no preview available)</p>
                            )}
                            <button
                                className="btn rsvp-continue-btn"
                                onClick={handleContinuePastImage}
                                autoFocus
                            >
                                <FastForward size={16} />
                                Continue reading
                            </button>
                        </motion.div>
                    ) : words.length === 0 && advancing ? (
                        <div className="rsvp-loading">
                            <p>Loading next chapter…</p>
                        </div>
                    ) : words.length === 0 ? (
                        <div className="rsvp-empty">
                            <p>No text on this page.</p>
                            <p className="rsvp-empty-hint">Press play to continue with the next chapter.</p>
                        </div>
                    ) : (
                        <>
                            {/* Brief "new chapter" hint at section boundaries */}
                            <AnimatePresence>
                                {chapterBreak && (
                                    <motion.div
                                        className="rsvp-chapter-break"
                                        initial={{ opacity: 0, y: -8 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        exit={{ opacity: 0 }}
                                        style={{
                                            position: 'absolute',
                                            top: '22%',
                                            left: 0,
                                            right: 0,
                                            textAlign: 'center',
                                            fontSize: '0.75rem',
                                            letterSpacing: '0.2em',
                                            textTransform: 'uppercase',
                                            opacity: 0.6,
                                        }}
                                    >
                                        ◆ New chapter
                                    </motion.div>
                                )}
                            </AnimatePresence>

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
                                {/* Bright white and red on an OLED black can be harsh
                                    over a long session; softer levels dim both the
                                    word and the red focus letter. */}
                                <div className="rsvp-settings-title">Word colour</div>
                                <div className="rsvp-tone-options" role="radiogroup" aria-label="Word colour">
                                    {[['bright', 'Bright'], ['soft', 'Soft'], ['dim', 'Dim']].map(([value, label]) => (
                                        <button
                                            key={value}
                                            role="radio"
                                            aria-checked={tone === value}
                                            className={`rsvp-tone-option ${tone === value ? 'active' : ''}`}
                                            data-tone={value}
                                            onClick={() => onToneChange?.(value)}
                                        >
                                            <span className="rsvp-tone-sample">a<b>b</b>c</span>
                                            {label}
                                        </button>
                                    ))}
                                </div>

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
                            className="rsvp-btn rsvp-btn-play"
                            onClick={stoppedAtImage ? handleContinuePastImage : togglePlay}
                            title={stoppedAtImage ? 'Continue reading (Space)' : isPlaying ? 'Pause (Space)' : 'Play (Space)'}
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
            <AnimatePresence key="rsvp-image-preview">
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
