<div align="center">
  <img src="/logo.png" alt="PulseReader Logo" width="120" />
  <h1>PulseReader</h1>
  <p>
    <b>A modern, high-performance EPUB reader with "Rapid Serial Visual Presentation" (RSVP) speed-reading capabilities.</b>
  </p>

  [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
  [![Vite](https://img.shields.io/badge/vite-%23646CFF.svg?style=flat&logo=vite&logoColor=white)](https://vitejs.dev/)
  [![React](https://img.shields.io/badge/react-%2320232a.svg?style=flat&logo=react&logoColor=%2361DAFB)](https://reactjs.org/)
</div>

## Features

- **Full PWA Support:** Installable on PC and Mobile, works offline.
- **OLED Dark Mode:** Pure black background for battery saving and comfort.
- **Library Management:** Upload and organize multiple EPUB files using local storage (IndexedDB).
- **Pulse Speed Reading:** 
    - Red-highlighted Optimal Recognition Point (Orp).
    - Adjustable WPM (Words Per Minute).
    - Heuristic pauses for punctuation.
- **Bookmarking:** Automatically remembers your progress in every book.

## getting Started

1. **Install Dependencies:**
   ```bash
   npm install
   ```

2. **Run Locally:**
   ```bash
   npm run dev
   ```

3. **Build for Production:**
   ```bash
   npm run build
   npx serve dist
   ```

## Usage

- **Add Book:** Click the "+" button in the library to select an `.epub` file from your device.
- **Reading:** Click a book cover to open standard view.
- **Pulse Mode:** Inside the reader, click the Lightning icon (⚡) to toggle Speed Reading mode.
- **Controls:** 
    - `Space`: Play/Pause Pulse.
    - `Left/Right Arrows`: Skip backward/forward (Pulse).
    - `Range Slider`: Adjust WPM speed.

## Project Structure

- `src/components`: UI Components (Reader, Library, PulseReader Display).
- `src/services`: Database (idb) and EPUB handling.
- `src/index.css`: Global Design System (Variables, Typography).
