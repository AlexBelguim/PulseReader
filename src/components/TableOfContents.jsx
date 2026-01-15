import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, BookOpen } from 'lucide-react';

const TableOfContents = ({ isOpen, onClose, chapters, currentChapter, onNavigate }) => {

    const handleChapterClick = (chapter) => {
        onNavigate(chapter.href);
        onClose();
    };

    // Render chapters recursively for nested structures
    const renderChapters = (items, level = 0) => {
        return items.map((chapter, index) => (
            <React.Fragment key={chapter.id || `${chapter.href}-${index}`}>
                <motion.button
                    className={`toc-item ${currentChapter === chapter.href ? 'active' : ''}`}
                    style={{ paddingLeft: `${20 + level * 16}px` }}
                    onClick={() => handleChapterClick(chapter)}
                    whileHover={{ backgroundColor: 'rgba(255, 255, 255, 0.05)' }}
                    whileTap={{ scale: 0.98 }}
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: index * 0.02 }}
                >
                    <span className="toc-item-label">{chapter.label}</span>
                </motion.button>

                {chapter.subitems && chapter.subitems.length > 0 && (
                    renderChapters(chapter.subitems, level + 1)
                )}
            </React.Fragment>
        ));
    };

    return (
        <AnimatePresence>
            {isOpen && (
                <>
                    {/* Backdrop */}
                    <motion.div
                        className="toc-backdrop"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={onClose}
                    />

                    {/* TOC Drawer */}
                    <motion.div
                        className="toc-drawer"
                        initial={{ x: '100%' }}
                        animate={{ x: 0 }}
                        exit={{ x: '100%' }}
                        transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                    >
                        {/* Header */}
                        <div className="toc-header">
                            <div className="toc-header-title">
                                <BookOpen size={20} />
                                <h2>Table of Contents</h2>
                            </div>
                            <button className="toc-close-btn" onClick={onClose}>
                                <X size={24} />
                            </button>
                        </div>

                        {/* Chapter List */}
                        <div className="toc-content">
                            {chapters && chapters.length > 0 ? (
                                renderChapters(chapters)
                            ) : (
                                <div className="toc-empty">
                                    <p>No chapters available</p>
                                </div>
                            )}
                        </div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
};

export default TableOfContents;
