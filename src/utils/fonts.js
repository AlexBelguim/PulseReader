// Fonts ship with the app (public/fonts/) instead of coming from Google Fonts:
// they are in the PWA precache, so they work offline from the first open, and
// opening the app no longer reports to Google. All are SIL OFL 1.1; the
// licenses sit next to the files.
//
// Inter, Literata, Comfortaa and JetBrains Mono are Google Fonts' own latin and
// latin-ext subsets of the variable fonts (one file per subset covers every
// weight). OpenDyslexic is the upstream build from
// github.com/antijingoist/opendyslexic (compiled/), unmodified.

const LATIN = 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';
const LATIN_EXT = 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF';

const subsets = (family, slug, weight) => [
    { family, weight, file: `${slug}-latin.woff2`, unicodeRange: LATIN },
    { family, weight, file: `${slug}-latin-ext.woff2`, unicodeRange: LATIN_EXT },
];

// Keyed like the reader's fontType setting; 'system' and 'georgia' are local
// fonts and have no entry.
const FACES = {
    inter: subsets('Inter', 'inter', '100 900'),
    literata: subsets('Literata', 'literata', '200 900'),
    comfortaa: subsets('Comfortaa', 'comfortaa', '300 700'),
    opendyslexic: [
        { family: 'OpenDyslexic', weight: '400', file: 'opendyslexic-regular.woff2' },
        { family: 'OpenDyslexic', weight: '700', file: 'opendyslexic-bold.woff2' },
    ],
    jetbrainsMono: subsets('JetBrains Mono', 'jetbrains-mono', '400 800'),
};

export const UI_FONTS = ['inter', 'jetbrainsMono'];
export const READER_FONTS = ['inter', 'literata', 'comfortaa', 'opendyslexic'];

// Absolute, because the book's sections are blob: documents that resolve
// relative URLs against the blob, and against the app's own URL because the
// app may be served under a sub-path.
const fontUrl = (file) => new URL(`fonts/${file}`, document.baseURI).href;

export const fontFaceCss = (keys, display) => keys
    .flatMap((key) => FACES[key] || [])
    .map((f) => `@font-face {
  font-family: '${f.family}';
  font-style: normal;
  font-weight: ${f.weight};
  font-display: ${display};
  src: url('${fontUrl(f.file)}') format('woff2');${f.unicodeRange ? `
  unicode-range: ${f.unicodeRange};` : ''}
}`)
    .join('\n');

// A section's @font-face only starts loading once its text is laid out, so the
// first layout -- the one epub.js paginates and finds the reading position in
// -- would be in a fallback font, and the text would reflow under the reader
// when the real one arrived. Instead the reader fetches the selected font up
// front (loadFont) and hands each section the bytes as FontFace objects
// (installFont), which the browser decodes on the spot.
const pending = new Map(); // file -> Promise<ArrayBuffer>
const loaded = new Map(); // file -> ArrayBuffer

export const loadFont = (key) => Promise.all((FACES[key] || []).map((f) => {
    if (!pending.has(f.file)) {
        pending.set(f.file, fetch(fontUrl(f.file))
            .then((res) => {
                if (!res.ok) throw new Error(`${f.file}: HTTP ${res.status}`);
                return res.arrayBuffer();
            })
            .then((data) => {
                loaded.set(f.file, data);
                return data;
            })
            .catch((err) => {
                pending.delete(f.file); // try again next time
                throw err;
            }));
    }
    return pending.get(f.file);
}));

const installed = new WeakMap(); // Document -> Set of files

// Synchronous: a font that loadFont has not finished stays with the
// @font-face rules from fontFaceCss, which load it the normal way.
export const installFont = (doc, key) => {
    const FontFace = doc?.defaultView?.FontFace;
    if (!FontFace || !doc.fonts) return;
    let files = installed.get(doc);
    if (!files) installed.set(doc, files = new Set());
    for (const f of FACES[key] || []) {
        const data = loaded.get(f.file);
        if (!data || files.has(f.file)) continue;
        try {
            doc.fonts.add(new FontFace(f.family, data, {
                weight: f.weight,
                ...(f.unicodeRange && { unicodeRange: f.unicodeRange }),
            }));
            files.add(f.file);
        } catch (err) {
            console.warn(`Could not install ${f.file}:`, err);
        }
    }
};
