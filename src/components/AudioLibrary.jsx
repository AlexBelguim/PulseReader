import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, Check, Headphones, Play, RotateCcw } from 'lucide-react';
import { coverUrl, formatDuration, fractionDone, saveProgress } from '../services/audiobooks';

// Coming back from the player lands in the series you were in.
const SERIES_KEY = 'pulsereader-audio-series';
const readSeries = () => {
    try { return sessionStorage.getItem(SERIES_KEY); } catch { return null; }
};
const writeSeries = (name) => {
    try {
        if (name) sessionStorage.setItem(SERIES_KEY, name);
        else sessionStorage.removeItem(SERIES_KEY);
    } catch { /* ignore */ }
};

const isFinished = (b) => !!b.progress?.finished;
const isStarted = (b) => !isFinished(b) && (b.progress?.position || 0) > 0;

/** A cover from the server, with the placeholder behind it if it can't load. */
const Cover = ({ book, alt }) => {
    const [failed, setFailed] = useState(false);
    const src = coverUrl(book);
    return (
        <>
            <div className="book-cover-placeholder">
                <Headphones size={40} strokeWidth={1} />
            </div>
            {src && !failed && <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} />}
        </>
    );
};

const AudioLibrary = ({ audiobooks, onProgressChange, onError }) => {
    const navigate = useNavigate();
    const [selected, setSelectedState] = useState(() => {
        const s = readSeries();
        return s && audiobooks.some((b) => b.series === s) ? s : null;
    });
    const setSelected = (name) => {
        writeSeries(name);
        setSelectedState(name);
    };

    const groups = useMemo(() => {
        const map = new Map();
        for (const b of audiobooks) {
            if (!map.has(b.series)) map.set(b.series, []);
            map.get(b.series).push(b);
        }
        return map;
    }, [audiobooks]);

    const continueWith = useMemo(() => audiobooks
        .filter(isStarted)
        .sort((a, b) => Date.parse(b.progress.updated_at || 0) - Date.parse(a.progress.updated_at || 0))[0],
    [audiobooks]);

    const open = (book) => navigate(`/listen/${book.id}`);

    const toggleFinished = async (e, book) => {
        e.stopPropagation();
        const finished = !isFinished(book);
        const position = book.progress?.position || 0;
        const progress = {
            // Not finished after all: from the start, if it was at the end.
            position: !finished && position >= book.duration - 60 ? 0 : position,
            finished,
            updated_at: new Date().toISOString(),
        };
        onProgressChange(book.id, progress);
        try {
            await saveProgress(book.id, progress);
        } catch (err) {
            onError(`Marked here, but the server didn't save it: ${err.message}`);
        }
    };

    const card = (book, index) => {
        const done = fractionDone(book);
        const finished = isFinished(book);
        return (
            <motion.div
                key={book.id}
                className={`book-card ${finished ? 'book-read' : ''}`}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ delay: index * 0.03 }}
                onClick={() => open(book)}
            >
                <div className="book-cover">
                    <Cover book={book} alt={book.title} />
                    {finished && (
                        <div className="book-read-badge">
                            <Check size={14} />
                        </div>
                    )}
                    <div className="audio-duration-badge">
                        <Headphones size={12} />
                        {formatDuration(book.duration)}
                    </div>
                    {isStarted(book) && (
                        <div className="book-progress">
                            <div className="book-progress-bar" style={{ width: `${done * 100}%` }} />
                        </div>
                    )}
                    <div className="book-actions-overlay">
                        <button
                            className="book-action-btn"
                            onClick={(e) => toggleFinished(e, book)}
                            title={finished ? 'Mark as not finished' : 'Mark as finished'}
                        >
                            {finished ? <RotateCcw size={14} /> : <Check size={14} />}
                        </button>
                    </div>
                </div>
                <div className="book-info">
                    <h3 className="book-title">{book.title}</h3>
                    <p className="book-author">
                        {isStarted(book)
                            ? `${formatDuration(book.duration - book.progress.position)} left`
                            : book.author}
                    </p>
                </div>
            </motion.div>
        );
    };

    // ===== One series =====
    if (selected && groups.has(selected)) {
        const books = groups.get(selected);
        const finishedCount = books.filter(isFinished).length;
        const total = books.reduce((n, b) => n + (b.duration || 0), 0);
        return (
            <>
                <div className="series-header">
                    <button className="btn btn-ghost series-back-btn" onClick={() => setSelected(null)}>
                        <ArrowLeft size={20} />
                        Back
                    </button>
                    <div className="series-header-info">
                        <h2>{selected}</h2>
                        <p className="series-count">
                            {books.length} audiobook{books.length !== 1 ? 's' : ''} · {formatDuration(total)}
                            {finishedCount > 0 && ` · ${finishedCount} finished`}
                        </p>
                    </div>
                </div>
                {/* Keyed, so switching views starts a fresh grid instead of animating one into the other */}
                <div className="library-grid" key={`series:${selected}`}>
                    <AnimatePresence>{books.map(card)}</AnimatePresence>
                </div>
            </>
        );
    }

    // ===== All series =====
    return (
        <>
            {continueWith && (
                <motion.button
                    className="audio-continue"
                    onClick={() => open(continueWith)}
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                >
                    <div className="audio-continue-cover">
                        <Cover book={continueWith} alt={continueWith.title} />
                    </div>
                    <div className="audio-continue-info">
                        <span className="audio-continue-label">Continue listening</span>
                        <h3>{continueWith.title}</h3>
                        <p>
                            {continueWith.author} · {formatDuration(continueWith.duration - continueWith.progress.position)} left
                        </p>
                        <div className="audio-continue-progress">
                            <div style={{ width: `${fractionDone(continueWith) * 100}%` }} />
                        </div>
                    </div>
                    <span className="audio-continue-play">
                        <Play size={22} />
                    </span>
                </motion.button>
            )}

            <div className="library-grid series-grid" key="all-series">
                <AnimatePresence>
                    {Array.from(groups.entries()).map(([series, books], index) => {
                        const finishedCount = books.filter(isFinished).length;
                        const withCover = books.find((b) => b.has_cover) || books[0];
                        const authors = {};
                        for (const b of books) authors[b.author] = (authors[b.author] || 0) + 1;
                        const author = Object.entries(authors).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
                        return (
                            <motion.div
                                key={series}
                                className="book-card series-card"
                                initial={{ opacity: 0, y: 20 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, scale: 0.9 }}
                                transition={{ delay: index * 0.05 }}
                                onClick={() => setSelected(series)}
                            >
                                <div className="book-cover">
                                    <Cover book={withCover} alt={series} />
                                    <div className="series-count-badge">{books.length}</div>
                                    {finishedCount === books.length && (
                                        <div className="book-read-badge">
                                            <Check size={14} />
                                        </div>
                                    )}
                                </div>
                                <div className="book-info">
                                    <h3 className="book-title">{series}</h3>
                                    <p className="book-author">{author}</p>
                                    <p className="book-author series-read-count">
                                        {finishedCount}/{books.length} finished
                                    </p>
                                </div>
                            </motion.div>
                        );
                    })}
                </AnimatePresence>
            </div>
        </>
    );
};

export default AudioLibrary;
