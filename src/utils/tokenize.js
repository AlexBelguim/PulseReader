// Titles that belong with the name after them. Mr, Mrs and the like are also
// written without the dot, the British way ("Mr Dursley"); the rest only count
// with it, since "Gen", "Col" or "St" alone are usually something else.
const TITLE = /^[^\p{L}\p{N}]*(?:(?:Mrs?|Ms|Mx|Dr|Mme|Mlle)\.?|(?:Prof|Capt|Col|Gen|Lt|Sgt|Maj|Rev|St)\.)$/u;

// A capital, after any opening quote or bracket.
const CAPITALISED = /^[^\p{L}\p{N}]*\p{Lu}/u;

// Not something to read: a dash set off by spaces, a "* * *" scene break. The
// symbols listed are said aloud, so "Tom & Jerry" keeps its "&".
const NOT_A_WORD = /^[^\p{L}\p{N}&+=%$#@]+$/u;

/**
 * Whether a word is a title such as "Mr." rather than the end of a sentence.
 *
 * @param {string} word
 * @returns {boolean}
 */
export function isTitle(word) {
    return TITLE.test(word);
}

/**
 * What to put on screen for a word from tokenizeWithOffsets: whitespace
 * collapsed, and without the punctuation it carries only for its pause.
 *
 * @param {string} word
 * @returns {string}
 */
export function displayWord(word) {
    const parts = word.split(/\s+/);
    while (parts.length > 1 && NOT_A_WORD.test(parts[parts.length - 1])) parts.pop();
    return parts.join(' ');
}

/**
 * Split raw text-node content into words that remember where they came from.
 *
 * Offsets are relative to the RAW string rather than a trimmed copy, so they
 * can be handed straight to Range.setStart on the same text node. Trimming
 * first would shift every offset past the leading whitespace.
 *
 * This exists so nothing has to recover a word's position by searching for it.
 * indexOf(word) returns the FIRST occurrence in the node, so in a sentence like
 * "the cat sat on the mat" the second "the" resolved to the first one, and the
 * position saved on leaving RSVP jumped backwards to earlier in the paragraph.
 *
 * The word sequence is raw.trim().split(/\s+/) on non-empty input, except that
 * a title stays with the capitalised word after it: "Mr. Dursley" is one word,
 * "Mr. and Mrs. Dursley" is "Mr.", "and", "Mrs. Dursley". Punctuation standing
 * alone is never a word of its own: it stays on the word before it, which keeps
 * the pause it stands for, or is dropped if there is no word before it. A joined
 * word's text is the raw slice, whitespace included, so a word is always exactly
 * what sits at its offset. displayWord turns that into what to show.
 *
 * @param {string} raw text node content, unmodified
 * @returns {Array<{ text: string, offset: number }>}
 */
export function tokenizeWithOffsets(raw) {
    const out = [];
    if (!raw) return out;

    const pattern = /\S+/g;
    let previous = '';
    let match;
    while ((match = pattern.exec(raw)) !== null) {
        const word = match[0];
        const last = out[out.length - 1];
        const lone = NOT_A_WORD.test(word);
        if (last && (lone || (isTitle(previous) && CAPITALISED.test(word)))) {
            last.text = raw.slice(last.offset, match.index + word.length);
        } else if (!lone) {
            out.push({ text: word, offset: match.index });
        }
        previous = word;
    }
    return out;
}
