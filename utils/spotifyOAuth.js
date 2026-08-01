const crypto = require('crypto');
const axios = require('axios');
const config = require('../config.js');
const { spotifyProfileCollection } = require('../mongodb.js');

const AUTH_BASE_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_BASE_URL = 'https://api.spotify.com/v1';
const STATE_TTL_MS = 15 * 60 * 1000;
const PUBLIC_ONLY_MODE = 'public_only';
const PRIVATE_AND_PUBLIC_MODE = 'private_and_public';
const pendingStates = new Map();

function getSpotifyRedirectUri() {
    return String(config.spotifyRedirectUri || '').trim();
}

function getModeScopes(mode) {
    if (mode === PRIVATE_AND_PUBLIC_MODE) {
        return ['user-read-private', 'playlist-read-private', 'playlist-read-collaborative'];
    }

    return ['user-read-private'];
}

function cleanupExpiredStates() {
    const now = Date.now();
    for (const [state, value] of pendingStates.entries()) {
        if ((value.createdAt || 0) + STATE_TTL_MS < now) {
            pendingStates.delete(state);
        }
    }
}

function createSpotifyAuthState(discordUserId, mode = PUBLIC_ONLY_MODE) {
    cleanupExpiredStates();
    const state = crypto.randomBytes(24).toString('hex');
    pendingStates.set(state, {
        discordUserId,
        mode,
        createdAt: Date.now()
    });
    return state;
}

function buildSpotifyAuthUrl(discordUserId, mode = PUBLIC_ONLY_MODE) {
    const redirectUri = getSpotifyRedirectUri();
    if (!redirectUri) return null;

    const state = createSpotifyAuthState(discordUserId, mode);
    const scopes = getModeScopes(mode);
    const params = new URLSearchParams({
        client_id: config.spotifyClientId || '',
        response_type: 'code',
        redirect_uri: redirectUri,
        state
    });

    if (scopes.length) {
        params.set('scope', scopes.join(' '));
    }

    return `${AUTH_BASE_URL}?${params.toString()}`;
}

function buildSpotifyTokenHeaders() {
    return {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${config.spotifyClientId}:${config.spotifyClientSecret}`).toString('base64')
    };
}

async function exchangeCodeForTokens(code) {
    const redirectUri = getSpotifyRedirectUri();
    const response = await axios.post(
        TOKEN_URL,
        new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri
        }).toString(),
        { headers: buildSpotifyTokenHeaders() }
    );

    return response.data;
}

async function refreshSpotifyAccessToken(refreshToken) {
    const response = await axios.post(
        TOKEN_URL,
        new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken
        }).toString(),
        { headers: buildSpotifyTokenHeaders() }
    );

    return response.data;
}

async function fetchSpotifyMe(accessToken) {
    const response = await axios.get(`${API_BASE_URL}/me`, {
        headers: { Authorization: `Bearer ${accessToken}` }
    });

    const user = response.data;
    return {
        spotifyUserId: user.id,
        displayName: user.display_name || user.id,
        followers: user.followers?.total || 0,
        avatar: user.images?.[0]?.url || null,
        profileUrl: user.external_urls?.spotify || `https://open.spotify.com/user/${user.id}`,
        product: user.product || 'unknown'
    };
}

async function getLinkedSpotifyProfile(discordUserId) {
    return spotifyProfileCollection?.findOne({ userId: discordUserId }) || null;
}

async function storeLinkedSpotifyProfile(discordUserId, mode, tokenData, me) {
    const expiresAt = new Date(Date.now() + ((tokenData.expires_in || 3600) * 1000));
    await spotifyProfileCollection?.updateOne(
        { userId: discordUserId },
        {
            $set: {
                userId: discordUserId,
                spotifyUserId: me.spotifyUserId,
                profileUrl: me.profileUrl,
                displayName: me.displayName,
                avatar: me.avatar,
                followers: me.followers,
                product: me.product,
                accessMode: mode,
                scopes: getModeScopes(mode),
                accessToken: tokenData.access_token,
                refreshToken: tokenData.refresh_token,
                tokenType: tokenData.token_type || 'Bearer',
                expiresAt,
                linkedAt: new Date(),
                updatedAt: new Date()
            }
        },
        { upsert: true }
    );
}

async function ensureFreshSpotifyToken(record) {
    if (!record) return null;

    const expiresAt = record.expiresAt ? new Date(record.expiresAt).getTime() : 0;
    if (record.accessToken && expiresAt > Date.now() + 60 * 1000) {
        return { ...record, accessToken: record.accessToken };
    }

    if (!record.refreshToken) {
        return record;
    }

    const refreshed = await refreshSpotifyAccessToken(record.refreshToken);
    const nextAccessToken = refreshed.access_token;
    const nextRefreshToken = refreshed.refresh_token || record.refreshToken;
    const nextExpiresAt = new Date(Date.now() + ((refreshed.expires_in || 3600) * 1000));

    await spotifyProfileCollection?.updateOne(
        { userId: record.userId },
        {
            $set: {
                accessToken: nextAccessToken,
                refreshToken: nextRefreshToken,
                tokenType: refreshed.token_type || record.tokenType || 'Bearer',
                expiresAt: nextExpiresAt,
                updatedAt: new Date()
            }
        }
    );

    return {
        ...record,
        accessToken: nextAccessToken,
        refreshToken: nextRefreshToken,
        tokenType: refreshed.token_type || record.tokenType || 'Bearer',
        expiresAt: nextExpiresAt
    };
}

async function getAuthorizedSpotifyProfile(discordUserId) {
    const record = await getLinkedSpotifyProfile(discordUserId);
    if (!record) return null;
    return ensureFreshSpotifyToken(record);
}

async function fetchCurrentUserPlaylists(accessToken, mode, options = {}) {
    const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.min(50, options.limit) : 25;
    let url = `${API_BASE_URL}/me/playlists?limit=${limit}`;
    const playlists = [];

    while (url && playlists.length < (options.maxItems || 50)) {
        const response = await axios.get(url, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        const items = Array.isArray(response.data?.items) ? response.data.items : [];
        for (const playlist of items) {
            const mapped = {
                id: playlist.id,
                name: playlist.name,
                description: decodeSpotifyText(playlist.description),
                tracks: playlist.tracks?.total || 0,
                image: playlist.images?.[0]?.url || null,
                url: playlist.external_urls?.spotify || null,
                owner: playlist.owner?.display_name || playlist.owner?.id || 'Spotify User',
                public: playlist.public !== false,
                collaborative: Boolean(playlist.collaborative)
            };

            if (mode === PUBLIC_ONLY_MODE && !mapped.public) {
                continue;
            }

            playlists.push(mapped);
            if (playlists.length >= (options.maxItems || 50)) {
                break;
            }
        }

        url = response.data?.next;
    }

    return playlists;
}

async function fetchPlaylistTracksForUser(accessToken, playlistId, options = {}) {
    const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.min(100, options.limit) : 100;
    let url = `${API_BASE_URL}/playlists/${playlistId}/tracks?limit=${limit}`;
    const tracks = [];
    const seenIds = new Set();

    while (url && tracks.length < (options.maxItems || 100)) {
        const response = await axios.get(url, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        const items = Array.isArray(response.data?.items) ? response.data.items : [];
        for (const item of items) {
            if (!item?.track?.name) continue;
            if (item.is_local || item.track.is_local || item.track.type !== 'track' || !item.track.id || item.track.uri?.includes('local')) {
                continue;
            }
            if (seenIds.has(item.track.id)) {
                continue;
            }
            seenIds.add(item.track.id);

            tracks.push({
                name: item.track.name,
                artist: item.track.artists?.map(artist => artist.name).filter(Boolean).join(', ') || 'Unknown Artist',
                url: item.track.external_urls?.spotify || null
            });
            if (tracks.length >= (options.maxItems || 100)) {
                break;
            }
        }

        url = response.data?.next;
    }

    return tracks;
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

function getModeLabel(mode) {
    return mode === PRIVATE_AND_PUBLIC_MODE ? 'Private + Public' : 'Public Only';
}

function buildCallbackHtml(title, body, tone = '#1db954') {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    body { margin:0; font-family:Segoe UI, Arial, sans-serif; background:linear-gradient(135deg,#0f172a,#111827 60%,#14532d); color:#f8fafc; min-height:100vh; display:grid; place-items:center; }
    .card { width:min(92vw,560px); background:rgba(15,23,42,.88); border:1px solid rgba(255,255,255,.12); border-radius:24px; padding:32px; box-shadow:0 24px 60px rgba(0,0,0,.35); }
    h1 { margin:0 0 14px; font-size:1.8rem; }
    p { margin:10px 0; line-height:1.6; color:#dbe4ee; }
    .accent { color:${tone}; font-weight:700; }
  </style>
</head>
<body>
  <main class="card">
    <h1>${title}</h1>
    ${body}
  </main>
</body>
</html>`;
}

function registerSpotifyAuthRoutes(app) {
    const redirectUri = getSpotifyRedirectUri();
    if (!redirectUri) return;

    let routePath = '/spotify/callback';
    try {
        routePath = new URL(redirectUri).pathname || routePath;
    } catch (_) {}

    app.get(routePath, async (req, res) => {
        const { code, state, error } = req.query || {};

        if (error) {
            res.status(400).send(buildCallbackHtml(
                'Spotify Link Cancelled',
                `<p class="accent">Spotify returned: ${String(error)}</p><p>You can close this page and run the command again in Discord.</p>`,
                '#f59e0b'
            ));
            return;
        }

        if (!code || !state || !pendingStates.has(state)) {
            res.status(400).send(buildCallbackHtml(
                'Spotify Link Failed',
                '<p class="accent">This Spotify authorization session is missing or expired.</p><p>Go back to Discord and run the Spotify link command again.</p>',
                '#ef4444'
            ));
            return;
        }

        const stateData = pendingStates.get(state);
        pendingStates.delete(state);

        try {
            const tokenData = await exchangeCodeForTokens(String(code));
            const me = await fetchSpotifyMe(tokenData.access_token);
            await storeLinkedSpotifyProfile(stateData.discordUserId, stateData.mode, tokenData, me);

            res.send(buildCallbackHtml(
                'Spotify Linked',
                `<p class="accent">${me.displayName}</p><p>Your Spotify account is now linked with <strong>${getModeLabel(stateData.mode)}</strong> access.</p><p>You can close this page and return to Discord.</p>`,
                '#22c55e'
            ));
        } catch (routeError) {
            res.status(500).send(buildCallbackHtml(
                'Spotify Link Failed',
                `<p class="accent">Spotify could not finish the authorization.</p><p>${String(routeError?.response?.data?.error_description || routeError?.message || 'Unknown Spotify error')}</p>`,
                '#ef4444'
            ));
        }
    });
}

module.exports = {
    PUBLIC_ONLY_MODE,
    PRIVATE_AND_PUBLIC_MODE,
    buildSpotifyAuthUrl,
    getModeLabel,
    getModeScopes,
    getSpotifyRedirectUri,
    getLinkedSpotifyProfile,
    getAuthorizedSpotifyProfile,
    fetchSpotifyMe,
    fetchCurrentUserPlaylists,
    fetchPlaylistTracksForUser,
    registerSpotifyAuthRoutes
};
