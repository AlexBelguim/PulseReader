import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Minus, Plus, RotateCcw } from 'lucide-react';

const ReaderSettings = ({ isOpen, onClose, settings, updateSetting, resetSettings }) => {

    // Dropdown component
    const Dropdown = ({ label, value, onChange, options }) => (
        <div className="settings-row">
            <label className="settings-label">{label}</label>
            <div className="settings-dropdown-wrapper">
                <select
                    className="settings-dropdown"
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                >
                    {options.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                            {opt.label}
                        </option>
                    ))}
                </select>
            </div>
        </div>
    );

    // Stepper component (+/-)
    const Stepper = ({ label, value, onChange, min, max, step, suffix = '' }) => (
        <div className="settings-row">
            <label className="settings-label">{label}</label>
            <div className="settings-stepper">
                <button
                    className="stepper-btn"
                    onClick={() => onChange(Math.max(min, value - step))}
                    disabled={value <= min}
                >
                    <Minus size={18} />
                </button>
                <span className="stepper-value">{value}{suffix}</span>
                <button
                    className="stepper-btn"
                    onClick={() => onChange(Math.min(max, value + step))}
                    disabled={value >= max}
                >
                    <Plus size={18} />
                </button>
            </div>
        </div>
    );

    // Slider component
    const Slider = ({ label, value, onChange, min, max, step }) => (
        <div className="settings-row">
            <label className="settings-label">{label}</label>
            <div className="settings-slider-wrapper">
                <input
                    type="range"
                    className="settings-slider"
                    min={min}
                    max={max}
                    step={step}
                    value={value}
                    onChange={(e) => onChange(parseInt(e.target.value))}
                />
                <span className="slider-value">{value}</span>
            </div>
        </div>
    );

    // Toggle component
    const Toggle = ({ label, value, onChange }) => (
        <div className="settings-row">
            <label className="settings-label">{label}</label>
            <button
                className={`settings-toggle ${value ? 'active' : ''}`}
                onClick={() => onChange(!value)}
            >
                <span className="toggle-track">
                    <span className="toggle-thumb" />
                </span>
            </button>
        </div>
    );

    return (
        <AnimatePresence>
            {isOpen && (
                <>
                    {/* Backdrop */}
                    <motion.div
                        className="settings-backdrop"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={onClose}
                    />

                    {/* Settings Panel */}
                    <motion.div
                        className="settings-panel"
                        initial={{ y: '-100%', opacity: 0 }}
                        animate={{ y: 0, opacity: 1 }}
                        exit={{ y: '-100%', opacity: 0 }}
                        transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                    >
                        {/* Header */}
                        <div className="settings-header">
                            <h2 className="settings-title">Reading Settings</h2>
                            <div className="settings-header-actions">
                                <button className="settings-reset-btn" onClick={resetSettings} title="Reset to defaults">
                                    <RotateCcw size={18} />
                                </button>
                                <button className="settings-close-btn" onClick={onClose}>
                                    <X size={24} />
                                </button>
                            </div>
                        </div>

                        {/* Scrollable Content */}
                        <div className="settings-content">

                            {/* EPUB Settings Section */}
                            <div className="settings-section">
                                <h3 className="settings-section-title">EPUB, FB2, MOBI, DOC, DOCX, RTF, TXT & CHM</h3>

                                <Dropdown
                                    label="View Mode"
                                    value={settings.viewMode}
                                    onChange={(v) => updateSetting('viewMode', v)}
                                    options={[
                                        { value: 'paginated', label: 'Paginated' },
                                        { value: 'scrollable', label: 'Scrollable' },
                                    ]}
                                />

                                <Dropdown
                                    label="Color Theme"
                                    value={settings.colorTheme}
                                    onChange={(v) => updateSetting('colorTheme', v)}
                                    options={[
                                        { value: 'oled', label: 'OLED (Pure Black)' },
                                        { value: 'night', label: 'Night' },
                                        { value: 'sepia', label: 'Sepia' },
                                        { value: 'light', label: 'Light' },
                                    ]}
                                />

                                <Dropdown
                                    label="Font Type"
                                    value={settings.fontType}
                                    onChange={(v) => updateSetting('fontType', v)}
                                    options={[
                                        { value: 'system', label: 'System Default' },
                                        { value: 'georgia', label: 'Georgia (Serif)' },
                                        { value: 'inter', label: 'Inter (Sans)' },
                                        { value: 'literata', label: 'Literata (Serif)' },
                                        { value: 'comfortaa', label: 'Comfortaa (Rounded)' },
                                        { value: 'opendyslexic', label: 'OpenDyslexic' },
                                    ]}
                                />

                                <Stepper
                                    label="Font Size"
                                    value={settings.fontSize}
                                    onChange={(v) => updateSetting('fontSize', v)}
                                    min={50}
                                    max={200}
                                    step={10}
                                />

                                <Slider
                                    label="Font Weight"
                                    value={settings.fontWeight}
                                    onChange={(v) => updateSetting('fontWeight', v)}
                                    min={300}
                                    max={700}
                                    step={100}
                                />

                                <Stepper
                                    label="Line Spacing"
                                    value={settings.lineSpacing}
                                    onChange={(v) => updateSetting('lineSpacing', v)}
                                    min={80}
                                    max={200}
                                    step={10}
                                    suffix="%"
                                />

                                <Dropdown
                                    label="Text Alignment"
                                    value={settings.textAlignment}
                                    onChange={(v) => updateSetting('textAlignment', v)}
                                    options={[
                                        { value: 'original', label: 'Original' },
                                        { value: 'left', label: 'Left' },
                                        { value: 'justify', label: 'Justify' },
                                    ]}
                                />

                                <Toggle
                                    label="Two Pages (Landscape)"
                                    value={settings.twoPageLayout}
                                    onChange={(v) => updateSetting('twoPageLayout', v)}
                                />

                                <Toggle
                                    label="Page Margins"
                                    value={settings.pageMargins}
                                    onChange={(v) => updateSetting('pageMargins', v)}
                                />
                            </div>

                            {/* RSVP Settings Section */}
                            <div className="settings-section">
                                <h3 className="settings-section-title">RSVP Speed Reading</h3>

                                <div className="settings-row">
                                    <label className="settings-label">Reading Speed</label>
                                    <div className="settings-slider-wrapper wide">
                                        <input
                                            type="range"
                                            className="settings-slider"
                                            min={100}
                                            max={1000}
                                            step={25}
                                            value={settings.rsvpSpeed}
                                            onChange={(e) => updateSetting('rsvpSpeed', parseInt(e.target.value))}
                                        />
                                        <span className="slider-value">{settings.rsvpSpeed} WPM</span>
                                    </div>
                                </div>

                                <Toggle
                                    label="Training Mode"
                                    value={settings.trainingMode}
                                    onChange={(v) => updateSetting('trainingMode', v)}
                                />

                                {settings.trainingMode && (
                                    <p className="settings-hint">
                                        Speed will increase by 10 WPM every 10 seconds
                                    </p>
                                )}
                            </div>

                        </div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
};

export default ReaderSettings;
