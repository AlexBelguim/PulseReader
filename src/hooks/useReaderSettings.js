import { useState, useEffect, useCallback } from 'react';

const STORAGE_KEY = 'rsvp-reader-settings';

const defaultSettings = {
    // EPUB/Reading Settings
    viewMode: 'paginated', // 'scrollable' | 'paginated'
    colorTheme: 'oled', // 'oled' | 'night' | 'sepia' | 'light'
    fontType: 'system', // 'system' | 'georgia' | 'inter' | 'literata' | 'comfortaa' | 'opendyslexic'
    fontSize: 100, // 50-200 (percentage)
    fontWeight: 400, // 300-700
    lineSpacing: 150, // 80-200 (percentage)
    textAlignment: 'original', // 'original' | 'left' | 'justify'
    twoPageLayout: false,
    pageMargins: true,

    // RSVP Settings
    rsvpSpeed: 300, // WPM 100-1000
    trainingMode: false,
};

const themes = {
    oled: {
        background: '#000000',
        text: '#ffffff',
        link: '#ff6b6b',
    },
    night: {
        background: '#121212',
        text: '#e0e0e0',
        link: '#64b5f6',
    },
    sepia: {
        background: '#f4ecd8',
        text: '#5b4636',
        link: '#8b6914',
    },
    light: {
        background: '#ffffff',
        text: '#1a1a1a',
        link: '#0066cc',
    },
};

const fontFamilies = {
    system: 'system-ui, -apple-system, sans-serif',
    georgia: 'Georgia, serif',
    inter: "'Inter', system-ui, sans-serif",
    literata: "'Literata', Georgia, serif",
    comfortaa: "'Comfortaa', system-ui, sans-serif",
    opendyslexic: "'OpenDyslexic', system-ui, sans-serif",
};

export const useReaderSettings = () => {
    const [settings, setSettings] = useState(() => {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) {
                return { ...defaultSettings, ...JSON.parse(stored) };
            }
        } catch (e) {
            console.warn('Failed to load settings from localStorage:', e);
        }
        return defaultSettings;
    });

    // Persist settings to localStorage whenever they change
    useEffect(() => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
        } catch (e) {
            console.warn('Failed to save settings to localStorage:', e);
        }
    }, [settings]);

    const updateSetting = useCallback((key, value) => {
        setSettings((prev) => ({ ...prev, [key]: value }));
    }, []);

    const resetSettings = useCallback(() => {
        setSettings(defaultSettings);
    }, []);

    // Get current theme colors
    const themeColors = themes[settings.colorTheme] || themes.night;

    // Get current font family
    const fontFamily = fontFamilies[settings.fontType] || fontFamilies.system;

    // Generate CSS to inject into epub iframe
    const getEpubStyles = useCallback(() => {
        const theme = themes[settings.colorTheme] || themes.night;
        const font = fontFamilies[settings.fontType] || fontFamilies.system;

        let alignment = '';
        if (settings.textAlignment === 'left') {
            alignment = 'text-align: left !important;';
        } else if (settings.textAlignment === 'justify') {
            alignment = 'text-align: justify !important;';
        }

        return `
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Literata:wght@300;400;500;600;700&family=Comfortaa:wght@300;400;500;600;700&display=swap');
      
      html, body {
        background-color: ${theme.background} !important;
        color: ${theme.text} !important;
        font-family: ${font} !important;
        font-size: ${settings.fontSize}% !important;
        font-weight: ${settings.fontWeight} !important;
        line-height: ${settings.lineSpacing}% !important;
        ${alignment}
        -webkit-font-smoothing: antialiased !important;
        transition: background-color 0.3s ease, color 0.3s ease !important;
      }
      
      * {
        color: inherit !important;
        font-family: inherit !important;
      }
      
      p, div, span, li, td, th, h1, h2, h3, h4, h5, h6 {
        color: ${theme.text} !important;
        line-height: ${settings.lineSpacing}% !important;
        ${alignment}
      }
      
      a {
        color: ${theme.link} !important;
      }
      
      img {
        max-width: 100% !important;
        height: auto !important;
      }
      
      /* Selection styling */
      ::selection {
        background: rgba(100, 181, 246, 0.3) !important;
        color: ${theme.text} !important;
      }
    `;
    }, [settings]);

    return {
        settings,
        updateSetting,
        resetSettings,
        themeColors,
        fontFamily,
        getEpubStyles,
        themes,
        fontFamilies,
    };
};

export { defaultSettings, themes, fontFamilies };
