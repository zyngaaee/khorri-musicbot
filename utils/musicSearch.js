const SEARCH_PREFIX_PATTERN = /^(?:ytmsearch|ytsearch|scsearch|spsearch|ytm|yt|sc|sp):\s*/i;

function normalizeSearchQuery(query) {
    if (!query || typeof query !== 'string') return '';

    let normalized = query.trim();
    if (!normalized) return '';

    if (/^https?:\/\//i.test(normalized)) {
        return normalized;
    }

    let previous;
    do {
        previous = normalized;
        normalized = normalized.replace(SEARCH_PREFIX_PATTERN, '');
    } while (normalized !== previous);

    return normalized
        .replace(/\s*-\s*Unknown\s*Artist/gi, '')
        .replace(/\s*-\s*Unknown/gi, '')
        .replace(/\bUnknown\s*Artist\b/gi, '')
        .replace(/\bUnknown\b/gi, '')
        .replace(/-/g, ' ')
        .replace(/,/g, ' ')
        .replace(/[()""']/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function isValidSpotifyId(value) {
    return /^[A-Za-z0-9]{22}$/.test(String(value || '').trim());
}

function extractSpotifyResource(input) {
    const value = String(input || '').trim();
    if (!value) return null;

    const match = value.match(/spotify\.com\/(playlist|track|album)\/([^/?#]+)/i);
    if (!match) return null;

    return {
        type: match[1].toLowerCase(),
        id: match[2].trim()
    };
}

function getSpotifySearchFallbackText(input) {
    const value = String(input || '').trim();
    if (!value) return '';

    const match = value.match(/spotify\.com\/(?:playlist|track|album)\/([^/?#]+)(?:[?#].*)?$/i);
    if (match) {
        return normalizeSearchQuery(match[1]);
    }

    return normalizeSearchQuery(value);
}

module.exports = {
    normalizeSearchQuery,
    isValidSpotifyId,
    extractSpotifyResource,
    getSpotifySearchFallbackText
};
