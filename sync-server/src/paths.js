import path from 'path';

/**
 * Turn a user-supplied name (series, upload filename) into a single safe path
 * segment. Series names arrive straight from request bodies and are joined
 * onto the books directory, so "../../etc" or "a/b" must never reach
 * path.join as-is.
 */
export function safeSegment(name, fallback = 'Uncategorized') {
    const cleaned = String(name ?? '')
        // separators, Windows-reserved characters and control characters
        // eslint-disable-next-line no-control-regex
        .replace(/[/\\:*?"<>|\u0000-\u001f]/g, ' ')
        .replace(/\s+/g, ' ')
        // leading/trailing dots and spaces: "..", hidden folders, and names
        // Windows would silently strip
        .replace(/^[.\s]+|[.\s]+$/g, '')
        .slice(0, 150);
    return cleaned || fallback;
}

/**
 * Resolve `rel` under `root` and refuse anything that escapes it. Use for
 * every path built from database or request data before touching the disk.
 */
export function resolveInside(root, ...rel) {
    const base = path.resolve(root);
    const full = path.resolve(base, ...rel);
    if (full !== base && !full.startsWith(base + path.sep)) {
        throw new Error('Path escapes the books directory');
    }
    return full;
}
