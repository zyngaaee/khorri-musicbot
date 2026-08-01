const axios = require('axios');

let spotifyToken = null;
let tokenExpiry = null;

function createSpotifyError(code, message, cause = null) {
    const error = new Error(message);
    error.code = code;
    if (cause) {
        error.cause = cause;
    }
    return error;
}

function getSpotifyApiMessage(error, fallback) {
    const directMessage = error?.response?.data?.error?.message;
    if (directMessage) return directMessage;

    const description = error?.response?.data?.error_description;
    if (description) return description;

    const rawBody = error?.response?.data;
    if (typeof rawBody === 'string' && rawBody.trim()) {
        return rawBody.trim();
    }

    const details = error?.response?.statusText;
    if (details) return details;

    return error?.message || fallback;
}

function decodeSpotifyText(value) {
    return String(value || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();
}

async function getSpotifyToken() {
    const config = require('../config.js');
    
    if (spotifyToken && tokenExpiry && Date.now() < tokenExpiry) {
        return spotifyToken;
    }
    
    try {
        const response = await axios.post('https://accounts.spotify.com/api/token', 
            'grant_type=client_credentials', 
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': 'Basic ' + Buffer.from(`${config.spotifyClientId}:${config.spotifyClientSecret}`).toString('base64')
                }
            }
        );
        
        spotifyToken = response.data.access_token;
        tokenExpiry = Date.now() + (response.data.expires_in * 1000);
        return spotifyToken;
    } catch (error) {
        const errorMessage = getSpotifyApiMessage(error, 'Failed to get Spotify token');
        console.error('Spotify token error:', errorMessage);
        throw createSpotifyError('SPOTIFY_TOKEN_ERROR', errorMessage, error);
    }
}

async function extractSpotifyUserId(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;

    try {
        const parsed = new URL(raw);
        if (/spotify\.com$/i.test(parsed.hostname)) {
            const segments = parsed.pathname
                .split('/')
                .map(segment => decodeURIComponent(segment).trim())
                .filter(Boolean);

            const anchorIndex = segments.findIndex(segment =>
                /^(user|profile)$/i.test(segment) || /^intl-[a-z-]+$/i.test(segment)
            );

            if (anchorIndex >= 0) {
                if (/^intl-[a-z-]+$/i.test(segments[anchorIndex])) {
                    const scopedType = segments[anchorIndex + 1];
                    const scopedId = segments[anchorIndex + 2];
                    if (/^(user|profile)$/i.test(scopedType) && scopedId) {
                        return scopedId;
                    }
                }

                const type = segments[anchorIndex];
                const next = segments[anchorIndex + 1];
                if (/^(user|profile)$/i.test(type) && next) {
                    return next;
                }
            }
        }
    } catch (_) {}

    const urlMatch = raw.match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:user|profile)\/([^/?#]+)/i);
    if (urlMatch) return decodeURIComponent(urlMatch[1]);

    const uriMatch = raw.match(/^spotify:user:([a-zA-Z0-9._-]+)$/i);
    if (uriMatch) return uriMatch[1];

    if (/^[a-zA-Z0-9._-]{3,}$/i.test(raw) && !raw.includes('/')) {
        return raw;
    }

    return null;
}

async function getSpotifyUserProfile(userId) {
    const token = await getSpotifyToken();
    if (!token || !userId) return null;

    try {
        const response = await axios.get(`https://api.spotify.com/v1/users/${userId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const user = response.data;
        return {
            id: user.id,
            displayName: user.display_name || user.id,
            followers: user.followers?.total || 0,
            avatar: user.images?.[0]?.url || null,
            url: user.external_urls?.spotify || `https://open.spotify.com/user/${user.id}`
        };
    } catch (error) {
        const apiMessage = getSpotifyApiMessage(error, 'Failed to fetch Spotify profile');
        console.error('Fetch Spotify profile error:', apiMessage);
        if (error?.response?.status === 403 && /premium subscription required/i.test(apiMessage)) {
            throw createSpotifyError('SPOTIFY_PREMIUM_REQUIRED', apiMessage, error);
        }
        if (error?.response?.status === 404) {
            return null;
        }
        throw createSpotifyError('SPOTIFY_PROFILE_ERROR', apiMessage, error);
    }
}

async function getSpotifyProfilePageName(profileUrl) {
    const url = String(profileUrl || '').trim();
    if (!url) return null;

    try {
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });

        const html = String(response.data || '');
        const ogTitleMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
        const twitterTitleMatch = html.match(/<meta\s+name=["']twitter:title["']\s+content=["']([^"']+)["']/i);
        const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
        const rawTitle = ogTitleMatch?.[1] || twitterTitleMatch?.[1] || titleMatch?.[1];
        if (!rawTitle) return null;

        return decodeSpotifyText(rawTitle).replace(/\s+on Spotify$/i, '').trim() || null;
    } catch (error) {
        return null;
    }
}

async function getUserPlaylists(userId, options = {}) {
    const token = await getSpotifyToken();
    if (!token) return [];

    try {
        const playlists = [];
        const maxItems = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : 50;
        let url = `https://api.spotify.com/v1/users/${userId}/playlists?limit=${Math.min(50, maxItems)}`;

        while (url && playlists.length < maxItems) {
            const response = await axios.get(url, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            const items = Array.isArray(response.data?.items) ? response.data.items : [];
            playlists.push(...items.map(playlist => ({
                id: playlist.id,
                name: playlist.name,
                description: decodeSpotifyText(playlist.description),
                tracks: playlist.tracks?.total || 0,
                image: playlist.images?.[0]?.url || null,
                url: playlist.external_urls?.spotify || null,
                owner: playlist.owner?.display_name || playlist.owner?.id || userId,
                public: playlist.public !== false
            })));

            url = response.data?.next;
        }

        return playlists.slice(0, maxItems);
    } catch (error) {
        const apiMessage = getSpotifyApiMessage(error, 'Failed to fetch Spotify playlists');
        console.error('Fetch playlists error:', apiMessage);
        if (error?.response?.status === 403 && /premium subscription required/i.test(apiMessage)) {
            throw createSpotifyError('SPOTIFY_PREMIUM_REQUIRED', apiMessage, error);
        }
        throw createSpotifyError('SPOTIFY_PLAYLISTS_ERROR', apiMessage, error);
    }
}

async function getPlaylistTracks(playlistId, options = {}) {
    const token = await getSpotifyToken();
    if (!token) return [];

    try {
        let tracks = [];
        const maxItems = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : 100;
        let url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=${Math.min(100, maxItems)}`;

        while (url && tracks.length < maxItems) {
            const response = await axios.get(url, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            const items = Array.isArray(response.data?.items) ? response.data.items : [];
            tracks.push(...items
                .filter(item => item?.track?.name)
                .map(item => ({
                    name: item.track.name,
                    artist: item.track.artists?.map(artist => artist.name).filter(Boolean).join(', ') || 'Unknown Artist',
                    url: item.track.external_urls?.spotify || null
                })));

            url = response.data.next;
        }

        return tracks.slice(0, maxItems);
    } catch (error) {
        const apiMessage = getSpotifyApiMessage(error, 'Failed to fetch Spotify tracks');
        console.error('Fetch tracks error:', apiMessage);
        if (error?.response?.status === 403 && /premium subscription required/i.test(apiMessage)) {
            throw createSpotifyError('SPOTIFY_PREMIUM_REQUIRED', apiMessage, error);
        }
        throw createSpotifyError('SPOTIFY_TRACKS_ERROR', apiMessage, error);
    }
}

module.exports = {
    getSpotifyToken,
    extractSpotifyUserId,
    getSpotifyUserProfile,
    getSpotifyProfilePageName,
    getUserPlaylists,
    getPlaylistTracks,
    decodeSpotifyText
};
