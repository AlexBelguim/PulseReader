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
 * The word sequence is identical to raw.trim().split(/\s+/) on non-empty input;
 * only the positions are new.
 *
 * @param {string} raw text node content, unmodified
 * @returns {Array<{ text: string, offset: number }>}
 */
export function tokenizeWithOffsets(raw) {
    const out = [];
    if (!raw) return out;

    const pattern = /\S+/g;
    let match;
    while ((match = pattern.exec(raw)) !== null) {
        out.push({ text: match[0], offset: match.index });
    }
    return out;
}
