import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
    ArrowLeft,
    List,
    Play,
    Pause,
    SkipBack,
    SkipForward,
    RotateCcw,
    RotateCw,
    Minus,
    Plus,
    Moon,
    Headphones,
    Loader2,
    AlertCircle,
} from 'lucide-react';
import TableOfContents from './TableOfContents';
import {
    getAudiobook,
    trackUrl,
    coverUrl,
    getLocalProgress,
    saveProgress,
    setLocalProgress,
    newest,
    getSpeed,
    setSpeed as storeSpeed,
    formatClock,
    formatDuration,
} from '../services/audiobooks';

const SKIP_BACK = 15;
const SKIP_FORWARD = 30;
// Coming back after a while, a few seconds of what you last heard.
const RESUME_REWIND = 3;
const SERVER_SAVE_EVERY = 15000;
const LOCAL_SAVE_EVERY = 2000;
// This close to the end counts as listened to.
const FINISHED_WITHIN = 30;
const SLEEP_STEPS = [null, 15, 30, 60, 'chapter'];

/** Which track holds book time `t`. */
function trackAt(tracks, t) {
    let i = 0;
    while (i < tracks.length - 1 && t >= tracks[i + 1].start) i++;
    return i;
}

const AudioPlayer = () => {
    const { bookId } = useParams();
    const navigate = useNavigate();
    const audioRef = useRef(null);

    const [book, setBook] = useState(null);
    const [error, setError] = useState(null);
    const [trackIndex, setTrackIndex] = useState(0);
    const [time, setTime] = useState(0); // seconds into the whole book
    const [playing, setPlaying] = useState(false);
    const [buffering, setBuffering] = useState(false);
    const [speed, setSpeedState] = useState(getSpeed);
    const [showChapters, setShowChapters] = useState(false);
    const [scrub, setScrub] = useState(null); // slider value while dragging
    const [sleep, setSleep] = useState(null); // { minutes, endsAt } | { chapterEnd }
    const [clock, setClock] = useState(() => Date.now());

    // What the event handlers need without re-binding on every tick.
    const bookRef = useRef(null);
    const timeRef = useRef(0);
    const trackRef = useRef(0);
    const pendingSeek = useRef(null); // where to go in the next track once it loads
    const resumeAfterLoad = useRef(false);
    const ready = useRef(false); // the saved position has been applied
    const listened = useRef(false); // played or moved: worth saving
    const lastLocalSave = useRef(0);
    const lastServerSave = useRef(0);
    const sleepRef = useRef(null);
    useEffect(() => { sleepRef.current = sleep; }, [sleep]);

    // ---- load ---------------------------------------------------------------
    useEffect(() => {
        let cancelled = false;
        ready.current = false;
        listened.current = false;
        getAudiobook(bookId).then((b) => {
            if (cancelled) return;
            const local = getLocalProgress(b.id);
            const saved = newest(b.progress, local);
            if (saved && saved === local && local !== b.progress) {
                saveProgress(b.id, local).catch(() => {});
            }
            let start = saved?.position || 0;
            if (saved?.finished && b.duration && start >= b.duration - 60) start = 0;
            else if (start > RESUME_REWIND * 2) start -= RESUME_REWIND;

            const tracks = b.tracks.length ? b.tracks : [{ index: 0, start: 0, duration: b.duration }];
            const index = trackAt(tracks, start);
            bookRef.current = { ...b, tracks };
            trackRef.current = index;
            timeRef.current = start;
            pendingSeek.current = start - tracks[index].start;
            setBook(bookRef.current);
            setTrackIndex(index);
            setTime(start);
        }).catch((err) => {
            if (!cancelled) setError(err.message);
        });
        return () => { cancelled = true; };
    }, [bookId]);

    // ---- chapters -----------------------------------------------------------
    const chapters = useMemo(() => {
        if (!book) return [];
        return book.chapters?.length ? book.chapters : [{ title: book.title, start: 0 }];
    }, [book]);

    const chapterIndex = useMemo(() => {
        let i = 0;
        while (i < chapters.length - 1 && time + 0.25 >= chapters[i + 1].start) i++;
        return i;
    }, [chapters, time]);

    const duration = book?.duration || 0;
    const chapter = chapters[chapterIndex];
    const chapterStart = chapter?.start || 0;
    const chapterEnd = chapters[chapterIndex + 1]?.start ?? duration;
    const chapterLength = Math.max(0, chapterEnd - chapterStart);

    const endOfChapterAt = useCallback((t) => {
        const next = chapters.find((c) => c.start > t + 0.25);
        return next ? next.start : (bookRef.current?.duration || Infinity);
    }, [chapters]);

    // ---- saving -------------------------------------------------------------
    const persist = useCallback(({ server = true, keepalive = false, finished } = {}) => {
        const b = bookRef.current;
        if (!b || !ready.current || !listened.current) return;
        const position = timeRef.current;
        const progress = {
            position,
            finished: finished ?? (b.duration > 0 && position >= b.duration - FINISHED_WITHIN),
            updated_at: new Date().toISOString(),
        };
        lastLocalSave.current = Date.now();
        if (!server) {
            setLocalProgress(b.id, progress);
            return;
        }
        lastServerSave.current = Date.now();
        saveProgress(b.id, progress, { keepalive }).catch(() => { /* kept locally, sent later */ });
    }, []);

    // Leaving the page, switching apps, locking the phone: save now.
    useEffect(() => {
        const onHide = () => {
            if (document.visibilityState === 'hidden') persist({ keepalive: true });
        };
        const onPageHide = () => persist({ keepalive: true });
        document.addEventListener('visibilitychange', onHide);
        window.addEventListener('pagehide', onPageHide);
        return () => {
            document.removeEventListener('visibilitychange', onHide);
            window.removeEventListener('pagehide', onPageHide);
            // Leaving the page removes the <audio>, which stops it.
            persist({ keepalive: true });
        };
    }, [persist]);

    // ---- moving around --------------------------------------------------------
    const seek = useCallback((target) => {
        const b = bookRef.current;
        const audio = audioRef.current;
        if (!b || !audio) return;
        const t = Math.min(Math.max(0, target), b.duration || Infinity);
        const index = trackAt(b.tracks, t);
        listened.current = true;
        timeRef.current = t;
        setTime(t);
        if (index === trackRef.current) {
            audio.currentTime = t - b.tracks[index].start;
        } else {
            resumeAfterLoad.current = !audio.paused;
            pendingSeek.current = t - b.tracks[index].start;
            trackRef.current = index;
            setTrackIndex(index);
        }
        if (sleepRef.current?.chapterEnd !== undefined) {
            setSleep({ chapterEnd: endOfChapterAt(t) });
        }
        persist();
    }, [persist, endOfChapterAt]);

    const togglePlay = useCallback(() => {
        const audio = audioRef.current;
        if (!audio || !ready.current) return;
        if (audio.paused) {
            listened.current = true;
            audio.play().catch((err) => setError(`Couldn't start playing: ${err.message}`));
        } else {
            audio.pause();
        }
    }, []);

    const skip = useCallback((seconds) => seek(timeRef.current + seconds), [seek]);

    const prevChapter = useCallback(() => {
        // Like a music player: first back to the start of this chapter.
        if (timeRef.current - chapterStart > 3 || chapterIndex === 0) seek(chapterStart);
        else seek(chapters[chapterIndex - 1].start);
    }, [seek, chapters, chapterIndex, chapterStart]);

    const nextChapter = useCallback(() => {
        if (chapterIndex < chapters.length - 1) seek(chapters[chapterIndex + 1].start);
    }, [seek, chapters, chapterIndex]);

    const changeSpeed = useCallback((delta) => {
        setSpeedState((s) => {
            const next = Math.round(Math.min(3, Math.max(0.5, s + delta)) * 10) / 10;
            storeSpeed(next);
            return next;
        });
    }, []);

    useEffect(() => {
        const audio = audioRef.current;
        if (!audio) return;
        audio.defaultPlaybackRate = speed;
        audio.playbackRate = speed;
    }, [speed, trackIndex, book]);

    // ---- sleep timer ----------------------------------------------------------
    const sleepStep = sleep?.minutes ?? (sleep?.chapterEnd !== undefined ? 'chapter' : null);
    const cycleSleep = () => {
        const next = SLEEP_STEPS[(SLEEP_STEPS.indexOf(sleepStep) + 1) % SLEEP_STEPS.length];
        if (next === null) setSleep(null);
        else if (next === 'chapter') setSleep({ chapterEnd: endOfChapterAt(timeRef.current) });
        else setSleep({ minutes: next, endsAt: Date.now() + next * 60000 });
    };

    useEffect(() => {
        if (!sleep?.endsAt) return undefined;
        const tick = setInterval(() => {
            setClock(Date.now());
            if (Date.now() >= sleep.endsAt) {
                audioRef.current?.pause();
                setSleep(null);
            }
        }, 1000);
        return () => clearInterval(tick);
    }, [sleep]);

    const sleepLabel = !sleep ? 'Sleep'
        : sleep.endsAt ? formatClock((sleep.endsAt - clock) / 1000)
        : 'End of chapter';

    // ---- audio element events ---------------------------------------------------
    const onLoadedMetadata = () => {
        const audio = audioRef.current;
        const b = bookRef.current;
        if (!audio || !b) return;
        // A file the tags reader couldn't measure: the browser can.
        if (b.tracks.length === 1 && !b.duration && Number.isFinite(audio.duration)) {
            bookRef.current = { ...b, duration: audio.duration, tracks: [{ ...b.tracks[0], duration: audio.duration }] };
            setBook(bookRef.current);
        }
        audio.playbackRate = speed;
        if (pendingSeek.current !== null) {
            audio.currentTime = Math.max(0, pendingSeek.current);
            pendingSeek.current = null;
        }
        ready.current = true;
        if (resumeAfterLoad.current) {
            resumeAfterLoad.current = false;
            audio.play().catch(() => {});
        }
    };

    const onTimeUpdate = () => {
        const audio = audioRef.current;
        const b = bookRef.current;
        if (!audio || !b || !ready.current || pendingSeek.current !== null) return;
        const t = b.tracks[trackRef.current].start + audio.currentTime;
        timeRef.current = t;
        setTime(t);

        const s = sleepRef.current;
        if (s?.chapterEnd !== undefined && t >= s.chapterEnd - 0.3) {
            audio.pause();
            setSleep(null);
        }
        if (!audio.paused) {
            const now = Date.now();
            if (now - lastServerSave.current > SERVER_SAVE_EVERY) persist();
            else if (now - lastLocalSave.current > LOCAL_SAVE_EVERY) persist({ server: false });
        }
    };

    const onEnded = () => {
        const b = bookRef.current;
        if (!b) return;
        if (trackRef.current < b.tracks.length - 1) {
            // Next part of a book in several files: carry on.
            const index = trackRef.current + 1;
            pendingSeek.current = 0;
            resumeAfterLoad.current = true;
            trackRef.current = index;
            setTrackIndex(index);
            return;
        }
        timeRef.current = b.duration;
        setTime(b.duration);
        setPlaying(false);
        persist({ finished: true });
    };

    const onAudioError = () => {
        const err = audioRef.current?.error;
        if (!err) return;
        setPlaying(false);
        setBuffering(false);
        setError(err.code === 4
            ? "This browser can't play this file, or the server couldn't find it."
            : `Playback stopped: ${err.message || 'network error'}. Check the connection and try again.`);
    };

    // ---- lock screen, headphones, car --------------------------------------------
    const actions = useRef({});
    useEffect(() => {
        actions.current = { togglePlay, skip, prevChapter, nextChapter, seek, chapterStart };
    });

    useEffect(() => {
        if (!('mediaSession' in navigator)) return undefined;
        const ms = navigator.mediaSession;
        const handlers = {
            play: () => audioRef.current?.paused && actions.current.togglePlay(),
            pause: () => !audioRef.current?.paused && actions.current.togglePlay(),
            seekbackward: (d) => actions.current.skip(-(d?.seekOffset || SKIP_BACK)),
            seekforward: (d) => actions.current.skip(d?.seekOffset || SKIP_FORWARD),
            previoustrack: () => actions.current.prevChapter(),
            nexttrack: () => actions.current.nextChapter(),
            seekto: (d) => Number.isFinite(d?.seekTime) && actions.current.seek(actions.current.chapterStart + d.seekTime),
        };
        for (const [name, fn] of Object.entries(handlers)) {
            try { ms.setActionHandler(name, fn); } catch { /* not supported here */ }
        }
        return () => {
            for (const name of Object.keys(handlers)) {
                try { ms.setActionHandler(name, null); } catch { /* ignore */ }
            }
        };
    }, []);

    useEffect(() => {
        if (!('mediaSession' in navigator) || !book || !window.MediaMetadata) return;
        const cover = coverUrl(book);
        navigator.mediaSession.metadata = new window.MediaMetadata({
            title: chapter?.title || book.title,
            artist: book.author,
            album: book.title,
            artwork: cover ? [{ src: cover, sizes: '512x512' }] : [],
        });
    }, [book, chapter?.title]);

    useEffect(() => {
        if (!('mediaSession' in navigator) || !chapterLength) return;
        try {
            navigator.mediaSession.setPositionState({
                duration: chapterLength,
                position: Math.min(chapterLength, Math.max(0, time - chapterStart)),
                playbackRate: speed,
            });
        } catch { /* ignore */ }
    }, [time, chapterStart, chapterLength, speed]);

    // ---- keyboard -----------------------------------------------------------------
    useEffect(() => {
        const onKey = (e) => {
            // The slider is left alone on purpose: after dragging it, Space and
            // the arrows should still play and skip, not nudge the slider.
            if (e.target.closest?.('input:not([type="range"]), textarea')) return;
            const a = actions.current;
            if (e.key === ' ') { e.preventDefault(); a.togglePlay(); }
            else if (e.key === 'ArrowLeft') { e.preventDefault(); if (e.shiftKey) a.prevChapter(); else a.skip(-SKIP_BACK); }
            else if (e.key === 'ArrowRight') { e.preventDefault(); if (e.shiftKey) a.nextChapter(); else a.skip(SKIP_FORWARD); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); changeSpeed(0.1); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); changeSpeed(-0.1); }
            else if (e.key === 'Escape') {
                if (showChapters) setShowChapters(false);
                else navigate('/');
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [changeSpeed, navigate, showChapters]);

    // ---- render ---------------------------------------------------------------------
    if (error && !book) {
        return (
            <div className="reader-container">
                <div className="reader-error">
                    <AlertCircle size={40} />
                    <p>{error}</p>
                    <button className="btn btn-secondary" onClick={() => navigate('/')}>
                        <ArrowLeft size={18} /> Back to Library
                    </button>
                </div>
            </div>
        );
    }

    if (!book) {
        return (
            <div className="reader-container">
                <div className="reader-loading">
                    <motion.div
                        className="loading-spinner"
                        animate={{ rotate: 360 }}
                        transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
                    />
                    <p>Loading audiobook...</p>
                </div>
            </div>
        );
    }

    const cover = coverUrl(book);
    const sliderValue = scrub ?? Math.min(chapterLength, Math.max(0, time - chapterStart));
    const commitScrub = () => {
        if (scrub === null) return;
        seek(chapterStart + scrub);
        setScrub(null);
    };
    const left = Math.max(0, duration - time);
    const percent = duration ? Math.floor((time / duration) * 100) : 0;
    const chapterItems = chapters.map((c, i) => ({
        href: String(i),
        label: c.title,
        detail: formatClock(c.start),
    }));

    return (
        <div className="audio-player">
            {cover && <div className="audio-backdrop" style={{ backgroundImage: `url("${cover}")` }} />}

            <header className="audio-header">
                <button className="header-btn" onClick={() => navigate('/')} title="Back to Library (Esc)">
                    <ArrowLeft size={24} />
                </button>
                <div className="header-title">
                    <h1>{book.title}</h1>
                    {book.author && <span className="header-author">{book.author}</span>}
                </div>
                <div className="header-actions">
                    <button className="header-btn" onClick={() => setShowChapters(true)} title="Chapters">
                        <List size={24} />
                    </button>
                </div>
            </header>

            <main className="audio-stage">
                <motion.div
                    className="audio-cover"
                    initial={{ opacity: 0, scale: 0.96 }}
                    animate={{ opacity: 1, scale: playing ? 1 : 0.97 }}
                    transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                >
                    {cover ? (
                        <img src={cover} alt={book.title} />
                    ) : (
                        <div className="book-cover-placeholder">
                            <Headphones size={56} strokeWidth={1} />
                        </div>
                    )}
                </motion.div>

                <button className="audio-now" onClick={() => setShowChapters(true)} title="Chapters">
                    <h2>{chapter?.title}</h2>
                    <p>
                        {chapters.length > 1 ? `${chapterIndex + 1} of ${chapters.length}` : book.series}
                    </p>
                </button>

                {error && (
                    <div className="audio-error" onClick={() => setError(null)}>
                        <AlertCircle size={16} />
                        <span>{error}</span>
                    </div>
                )}
            </main>

            <div className="audio-controls">
                <div className="audio-scrubber">
                    <input
                        type="range"
                        className="progress-slider"
                        min={0}
                        max={chapterLength || 1}
                        step={1}
                        value={sliderValue}
                        onChange={(e) => setScrub(Number(e.target.value))}
                        onPointerUp={commitScrub}
                        onKeyUp={commitScrub}
                        onBlur={commitScrub}
                        aria-label="Position in chapter"
                    />
                    <div className="audio-times">
                        <span>{formatClock(sliderValue)}</span>
                        <span>-{formatClock(chapterLength - sliderValue)}</span>
                    </div>
                </div>

                <div className="rsvp-main-controls audio-main-controls">
                    <button className="rsvp-btn" onClick={prevChapter} title="Previous chapter (Shift+←)">
                        <SkipBack size={20} />
                    </button>
                    <button className="rsvp-btn audio-skip" onClick={() => skip(-SKIP_BACK)} title={`Back ${SKIP_BACK} seconds (←)`}>
                        <RotateCcw size={26} strokeWidth={1.75} />
                        <span>{SKIP_BACK}</span>
                    </button>
                    <button
                        className="rsvp-btn rsvp-btn-play"
                        onClick={togglePlay}
                        title={playing ? 'Pause (Space)' : 'Play (Space)'}
                    >
                        {buffering && playing ? <Loader2 size={28} className="spinning" />
                            : playing ? <Pause size={28} /> : <Play size={28} />}
                    </button>
                    <button className="rsvp-btn audio-skip" onClick={() => skip(SKIP_FORWARD)} title={`Forward ${SKIP_FORWARD} seconds (→)`}>
                        <RotateCw size={26} strokeWidth={1.75} />
                        <span>{SKIP_FORWARD}</span>
                    </button>
                    <button
                        className="rsvp-btn"
                        onClick={nextChapter}
                        disabled={chapterIndex >= chapters.length - 1}
                        title="Next chapter (Shift+→)"
                    >
                        <SkipForward size={20} />
                    </button>
                </div>

                <div className="audio-secondary">
                    <div className="rsvp-wpm-control audio-speed">
                        <button className="rsvp-btn-small" onClick={() => changeSpeed(-0.1)} title="Slower (↓)">
                            <Minus size={16} />
                        </button>
                        <span className="rsvp-wpm-value">{speed.toFixed(1)}×</span>
                        <button className="rsvp-btn-small" onClick={() => changeSpeed(0.1)} title="Faster (↑)">
                            <Plus size={16} />
                        </button>
                    </div>

                    <button className={`audio-pill ${sleep ? 'active' : ''}`} onClick={cycleSleep} title="Sleep timer">
                        <Moon size={16} />
                        <span>{sleepLabel}</span>
                    </button>

                    <span className="audio-left">
                        {percent}% · {formatDuration(left / speed)} left
                    </span>
                </div>
            </div>

            <TableOfContents
                isOpen={showChapters}
                onClose={() => setShowChapters(false)}
                chapters={chapterItems}
                currentChapter={String(chapterIndex)}
                onNavigate={(href) => seek(chapters[Number(href)].start)}
                title="Chapters"
                icon={Headphones}
            />

            <audio
                ref={audioRef}
                src={trackUrl(book.id, trackIndex)}
                preload="metadata"
                onLoadedMetadata={onLoadedMetadata}
                onTimeUpdate={onTimeUpdate}
                onPlay={() => setPlaying(true)}
                onPause={() => { setPlaying(false); persist(); }}
                onWaiting={() => setBuffering(true)}
                onPlaying={() => { setBuffering(false); setError(null); }}
                onCanPlay={() => setBuffering(false)}
                onEnded={onEnded}
                onError={onAudioError}
            />
        </div>
    );
};

export default AudioPlayer;
