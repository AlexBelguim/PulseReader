# PulseReader — Product Specification

A modern, mobile-first EPUB reader PWA with RSVP (Rapid Serial Visual Presentation) speed reading mode.

---

## Tech Stack (Keep As-Is)

- **Vite** — Build tool & dev server
- **React 19** — UI framework
- **react-router-dom** — Routing
- **epub.js** — EPUB parsing & rendering
- **Framer Motion** — Animations
- **idb** (IndexedDB) — Offline book storage
- **vite-plugin-pwa** — PWA support
- **lucide-react** — Icons

---

## Design Goals

- **Mobile-first** — Optimized for phone use, but works on desktop
- **Dark mode by default** — Pure black (#000) for OLED screens
- **Immersive reading** — Minimal chrome, maximum content
- **Premium feel** — Smooth animations, polished UI
- **Offline-first** — Books stored locally, works without internet

---

## Routes

| Path | Component | Description |
|------|-----------|-------------|
| `/` | Library | Book collection grid |
| `/read/:bookId` | Reader | Main reading experience |

---

## Pages

### 1. Library Page

**Purpose**: Display and manage user's book collection.

**Features**:
- Grid display of book covers (2/3 aspect ratio cards)
- Click to open book in Reader
- "Add Book" button — file picker for .epub files
- Delete button on each book (with confirmation)
- Reading progress indicator on each book cover
- Empty state with helpful message
- Future: Series grouping (already partially implemented)

**Book Card Shows**:
- Cover image (extracted from EPUB, fallback icon if none)
- Title (truncated with ellipsis)
- Author
- Progress bar (if > 0%)

**Data Extraction on Import**:
- Title from metadata
- Author from metadata
- Cover image (blob)
- Full EPUB data (ArrayBuffer)
- Series: default to "Uncategorized" (manual edit later)

---

### 2. Reader Page

**Purpose**: Immersive reading experience with comprehensive customization.

**Layout Structure**:
```
┌─────────────────────────────────────┐
│  Header (collapsible)               │
│  ← Back | Title | TOC | Settings    │
├─────────────────────────────────────┤
│                                     │
│                                     │
│          Reading Area               │
│     (epub.js rendered content)      │
│                                     │
│                                     │
│                        [RSVP FAB]   │
├─────────────────────────────────────┤
│  Footer Navigation Bar              │
│  ◄  [==== progress ====]  ►         │
│       672 van 2484                  │
└─────────────────────────────────────┘
```

#### 2.1 View Modes

**Normal Reading Mode**:
- epub.js renders the book content
- Supports both **Scrollable** and **Paginated** view modes (user toggle)
- Tap left/right edges OR use footer arrows to navigate pages
- Styles injected into epub iframe for theming

**Pulse Mode**:
- Full-screen overlay
- Shows one word at a time with ORP (Optimal Recognition Point) highlighting
- Auto-plays through text
- Keyboard/tap controls for pause/play
- Training mode with auto-acceleration

#### 2.2 Settings Panel

Opens as a slide-down overlay from settings button. Contains all reader customization options organized in sections.

**Section: EPUB/Reading Settings**

| Setting | Type | Options/Range | Default |
|---------|------|---------------|---------|
| View Mode | Toggle/Select | Scrollable / Paginated | Paginated |
| Color Theme | Dropdown | Night (black), Sepia, Light | Night |
| Font Type | Dropdown | System Default, Georgia (Serif), Inter (Sans), OpenDyslexic, Literata, Comfortaa, etc. | System Default |
| Font Size | Stepper (+/-) | 50% – 200% (step: 10) | 100% |
| Font Weight | Slider | 300 – 700 | 400 |
| Line Spacing | Stepper (+/-) | 80% – 200% (step: 10) | 150% |
| Text Alignment | Dropdown | Original, Left, Justify | Original |
| Two Pages (Landscape) | Toggle | On/Off | Off |
| Page Margins | Toggle | On/Off | On |

**Section: Pulse Settings**

| Setting | Type | Options/Range | Default |
|---------|------|---------------|---------|
| WPM Speed | Slider | 100 – 1000 (step: 25) | 300 |
| Training Mode | Toggle | On/Off (auto +10 WPM every 10s) | Off |

**All settings persisted to localStorage**.

#### 2.3 Color Themes

| Theme | Background | Text Color | Link Color |
|-------|-----------|------------|------------|
| Night | #000000 | #e0e0e0 | #64b5f6 |
| Sepia | #f4ecd8 | #5b4636 | #8b6914 |
| Light | #ffffff | #1a1a1a | #0066cc |

#### 2.4 Table of Contents (TOC)

- Slide-in drawer from right edge
- List of all chapters from epub navigation
- Click chapter to navigate
- Currently active chapter highlighted (if determinable)

#### 2.5 Progress & Navigation

**Footer Bar**:
- Left arrow button — previous page
- Right arrow button — next page
- Progress slider — drag to seek
- Current position display: "672 van 2484" (page X of Y) OR percentage

**Progress Saving**:
- Auto-save CFI (location) and percentage on navigation
- Resume from last read position when reopening book

#### 2.6 Pulse FAB Button

- Floating Action Button in bottom-right
- Tap to enter RSVP mode for current view
- Extracts text from current page/section
- Icon: Lightning bolt (Zap)

---

### 3. PulseReader (Overlay Component)

**Purpose**: Speed reading mode using word-by-word display.

**Features**:
- Single word displayed center-screen, large font
- ORP (Optimal Recognition Point) highlighting — pivot letter in accent color
- Alignment markers above/below word
- Auto-play on entry
- Tap anywhere to pause/play
- Keyboard: Space = play/pause, Arrows = skip ±10 words, Escape = exit

**Display When Paused**:
- Word position counter (e.g., "1,234 / 5,678")
- Progress bar
- Play/Pause button

**Speed Calculation**:
- Base delay = 60000ms / WPM
- Punctuation pauses:
  - `.`, `?`, `!` → 2.5x delay
  - `,`, `;`, `:` → 1.5x delay
- Long words (8+ chars) → 1.2x delay

**Training Mode**:
- When enabled, auto-increase WPM by 10 every 10 seconds
- Max cap at 1500 WPM
- Shows "(Training)" indicator

**Image Handling**:
- If an image is encountered, pause and show it
- User taps play to continue past image

---

## Data Layer

### IndexedDB Schema

**Database**: `pulse-reader-db` (version 2)

**Store**: `books`

| Field | Type | Description |
|-------|------|-------------|
| id | number | Auto-incremented primary key |
| title | string | Book title (indexed) |
| author | string | Author name |
| series | string | Series name (indexed), default "Uncategorized" |
| cover | Blob | Cover image |
| data | ArrayBuffer | Full EPUB file |
| lastRead | string | CFI location string |
| progress | number | 0-1 percentage |
| addedAt | Date | Import timestamp (indexed) |

### Service Functions

```javascript
initDB()              // Initialize/upgrade database
addBook(bookData)     // Add new book
getBooks()            // Get all books (sorted by addedAt)
getBook(id)           // Get single book by ID
updateBookProgress(id, location, progress)  // Update reading position
deleteBook(id)        // Remove book
```

---

## Styling

### CSS Variables

```css
:root {
  /* Colors */
  --color-bg: #000000;
  --color-surface: #121212;
  --color-surface-hover: #1e1e1e;
  --color-text: #e0e0e0;
  --color-text-muted: #a0a0a0;
  --color-primary: #ff4b4b;    /* Red accent for RSVP/buttons */
  --color-border: #333333;
  
  /* Typography */
  --font-sans: 'Inter', system-ui, sans-serif;
  --font-serif: 'Georgia', serif;
  --font-mono: 'JetBrains Mono', monospace;
  
  /* Spacing */
  --radius-lg: 16px;
  --radius-md: 8px;
  --radius-sm: 4px;
}
```

### Google Fonts to Load
- Inter (300-700) — Default UI & sans reading
- JetBrains Mono — RSVP display
- Georgia — Already system, no load needed
- Optional: Literata, Comfortaa, OpenDyslexic for reading

### Component Classes

- `.btn` — Base button
- `.btn-primary` — Accent colored button
- `.btn-ghost` — Transparent hover button
- `.card` — Elevated surface
- `.rsvp-container` — RSVP mode wrapper
- `.rsvp-display` — Word display area
- `.rsvp-pivot` — Highlighted pivot letter

---

## Responsive Behavior

- **Mobile (< 768px)**: Single column, touch-optimized, larger tap targets
- **Tablet (768-1024px)**: Optional two-page spread when toggled
- **Desktop (> 1024px)**: Centered reader with comfortable max-width

---

## Animation Guidelines

Use Framer Motion for:
- Page/route transitions
- Modal/drawer open/close
- Book card entrance (stagger)
- Settings panel slide
- Button hover/tap feedback

Keep animations snappy: 200-400ms, use spring physics when appropriate.

---

## PWA Configuration

- Installable on home screen
- Offline capable (books stored in IndexedDB)
- Service worker for caching static assets
- Manifest with app name, icons, theme color (#000000)

---

## File Structure (Suggested)

```
src/
├── components/
│   ├── Library.jsx          # Book grid page
│   ├── Reader.jsx           # Main reader page
│   ├── ReaderSettings.jsx   # Settings panel component
│   ├── RSVPReader.jsx       # RSVP overlay mode
│   ├── TableOfContents.jsx  # TOC drawer
│   └── BookCard.jsx         # Individual book in library
├── services/
│   └── db.js                # IndexedDB operations
├── hooks/
│   └── useReaderSettings.js # Settings state + persistence
├── utils/
│   └── epubHelpers.js       # EPUB extraction helpers
├── App.jsx                  # Router setup
├── main.jsx                 # Entry point
└── index.css                # Global styles + design tokens
```

---

## Reference Images

The reader should match this aesthetic:

1. **Reading View**: Pure black background, light gray text, clean typography, no distracting UI. Text should fill the screen comfortably with proper margins.

2. **Settings Panel**: Slide-in panel with organized sections:
   - Dropdowns for theme, font, alignment
   - Stepper controls (+/-) for font size, line spacing
   - Slider for font weight
   - Toggle switches for two-page mode, margins
   - Clean section headers like "FONT SIZE", "LINE SPACING"

---

## Key Behaviors

1. **Auto-resume**: Opening a book goes to last read position
2. **Settings sync**: Changing settings immediately updates the view
3. **Clean transitions**: Smooth animations between states
4. **Error handling**: Graceful fallbacks if EPUB is malformed
5. **Immersive mode**: Header/footer can auto-hide on scroll (optional enhancement)

---

## Files to DELETE Before Fresh Start

Delete these files/folders to start clean with components:

```
src/components/Library.jsx
src/components/Reader.jsx
src/components/RSVPReader.jsx
src/App.css
```

**KEEP these files** (they're good as-is or need minimal changes):

```
src/services/db.js          # Database layer is solid
src/main.jsx                # Entry point is fine
src/index.css               # Base styles (will extend)
vite.config.js              # Build config
package.json                # Dependencies
index.html                  # HTML shell
public/                     # Static assets
```

---

## Implementation Priority

1. **Phase 1**: Core Reader with settings panel (view mode, theme, fonts, sizing)
2. **Phase 2**: Library page with book management
3. **Phase 3**: RSVP mode integration
4. **Phase 4**: Polish (animations, edge cases, PWA optimization)

---

*Use this spec in a fresh chat to rebuild the UI with clean, modern components.*
