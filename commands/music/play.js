const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const config = require('../../config.js');
const SpotifyWebApi = require('spotify-web-api-node');
const { getData } = require('spotify-url-info')(require('node-fetch'));
const fetch = require('node-fetch');
const { sendErrorResponse, handleCommandError, safeDeferReply, buildPaleCard, sanitizeTitle, stripLeadingIcons } = require('../../utils/responseHandler.js');
const { checkVoiceChannel: checkVC } = require('../../utils/voiceChannelCheck.js');
const { getLavalinkManager } = require('../../lavalink.js');
const { getLang } = require('../../utils/languageLoader');
const { getEmoji } = require('../../UI/emojis/emoji');
const { normalizeSearchQuery, isValidSpotifyId, extractSpotifyResource, getSpotifySearchFallbackText } = require('../../utils/musicSearch.js');
const requesters = new Map();
const inFlightSearches = new Map();
const recentSearchFailures = new Map();
const SEARCH_FAILURE_COOLDOWN_MS = 15000;

function formatDuration(ms) {
    const seconds = Math.floor((ms / 1000) % 60);
    const minutes = Math.floor((ms / (1000 * 60)) % 60);
    const hours = Math.floor((ms / (1000 * 60 * 60)) % 24);

    return [
        hours > 0 ? `${hours}h` : null,
        minutes > 0 ? `${minutes}m` : null,
        `${seconds}s`,
    ]
        .filter(Boolean)
        .join(' ');
}

function cleanSearchQuery(query) {
    return normalizeSearchQuery(query);
}

async function resolvePlayableTrack(client, query, requester) {
    const searchQuery = cleanSearchQuery(query);
    if (!searchQuery) return null;

    const cacheKey = searchQuery.toLowerCase();
    const recentFailureAt = recentSearchFailures.get(cacheKey);
    if (recentFailureAt && Date.now() - recentFailureAt < SEARCH_FAILURE_COOLDOWN_MS) {
        console.warn(`[ PLAY ] Skipping repeated resolve for "${searchQuery}" due to recent failure`);
        return null;
    }

    if (inFlightSearches.has(cacheKey)) {
        return inFlightSearches.get(cacheKey);
    }

    const task = (async () => {
        const isUrl = /^https?:\/\//i.test(searchQuery);

        if (isUrl) {
            try {
                const urlResult = await client.riffy.resolve({ query: searchQuery, requester });
                if (urlResult && urlResult.tracks && urlResult.tracks.length > 0) {
                    return urlResult;
                }
            } catch (e) {
                console.warn(`[ PLAY ] Direct URL resolve error for ${searchQuery}: ${e.message || e}`);
            }
        }

        try {
            const result = await client.riffy.resolve({ query: searchQuery, requester });
            if (result && result.tracks && result.tracks.length > 0) {
                return result;
            }
        } catch (e) {
            console.warn(`[ PLAY ] Default resolve error for ${searchQuery}: ${e.message || e}`);
        }

        try {
            const scResult = await client.riffy.resolve({ query: searchQuery, source: 'scsearch', requester });
            if (scResult && scResult.tracks && scResult.tracks.length > 0) {
                return scResult;
            }
        } catch (e) {
            console.warn(`[ PLAY ] SoundCloud fallback resolve error for ${searchQuery}: ${e.message || e}`);
        }

        return null;
    })();

    inFlightSearches.set(cacheKey, task);

    try {
        const result = await task;
        if (result && Array.isArray(result.tracks) && result.tracks.length > 0) {
            recentSearchFailures.delete(cacheKey);
            return result;
        }
        recentSearchFailures.set(cacheKey, Date.now());
        return result;
    } catch (e) {
        recentSearchFailures.set(cacheKey, Date.now());
        throw e;
    } finally {
        inFlightSearches.delete(cacheKey);
    }
}

const data = new SlashCommandBuilder()
  .setName("play")
  .setDescription("Play a song from a name or link")
  .addStringOption(option =>
    option.setName("name")
      .setDescription("Enter song name / link or playlist")
      .setRequired(true)
      .setAutocomplete(true)
  );

const spotifyApi = new SpotifyWebApi({
    clientId: config.spotifyClientId, 
    clientSecret: config.spotifyClientSecret,
});

async function waitForPlayerConnection(player, timeoutMs = 7000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (player?.connected) {
            // Wait for the actual voice handshake data from Discord (not just the connected flag)
            const voice = player?.connection?.voice;
            if (voice && voice.sessionId && voice.token && voice.endpoint) {
                // Give Lavalink a moment to process the voice data
                await new Promise((resolve) => setTimeout(resolve, 300));
                return true;
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    // Fallback: if connected flag is set but voice data is incomplete, still try
    return !!player?.connected;
}

async function getSpotifyPlaylistTracks(playlistId) {
    try {
        const data = await spotifyApi.clientCredentialsGrant();
        spotifyApi.setAccessToken(data.body.access_token);

        let tracks = [];
        let offset = 0;
        let limit = 100;
        let total = 0;
        const seenIds = new Set();

        do {
            const response = await spotifyApi.getPlaylistTracks(playlistId, { limit, offset });
            total = response.body.total;
            offset += limit;

            for (const item of response.body.items) {
                if (item && item.track && item.track.name) {
                    if (item.is_local || item.track.is_local || item.track.type !== 'track' || !item.track.id || item.track.uri?.includes('local')) {
                        continue;
                    }
                    if (seenIds.has(item.track.id)) {
                        continue;
                    }
                    seenIds.add(item.track.id);

                    const mainArtist = item.track.artists?.[0]?.name || '';
                    const trackName = `${item.track.name} ${mainArtist}`.trim();
                    tracks.push(trackName);
                }
            }
        } while (offset < total);

        return tracks;
    } catch (error) {
        console.error("Error fetching Spotify playlist tracks via API, trying fallback:", error.message || error);
        return getSpotifyPlaylistTracksFallback(playlistId);
    }
}

async function getSpotifyPlaylistTracksFallback(playlistId) {
    try {
        const { getTracks } = require('spotify-url-info')(require('node-fetch'));
        const playlistUrl = `https://open.spotify.com/playlist/${playlistId}`;
        const items = await getTracks(playlistUrl);
        const tracks = [];
        const seenIds = new Set();
        for (const item of items) {
            if (item) {
                if (item.uri && (item.uri.includes('local') || seenIds.has(item.uri))) {
                    continue;
                }
                if (item.uri) {
                    seenIds.add(item.uri);
                }
                const name = item.name || item.title || 'Unknown';
                const mainArtist = item.artist || (item.artists && item.artists[0]?.name) || item.subtitle || '';
                const trackName = `${name} ${mainArtist}`.trim();
                tracks.push(trackName);
            }
        }
        console.log(`✅ (Fallback) Fetched ${tracks.length} Spotify playlist tracks via spotify-url-info`);
        return tracks;
    } catch (err) {
        console.error("Fallback Spotify playlist tracks error:", err.message);
        return [];
    }
}

async function getSpotifyAlbumTracks(albumId) {
    try {
        const data = await spotifyApi.clientCredentialsGrant();
        spotifyApi.setAccessToken(data.body.access_token);

        let tracks = [];
        let offset = 0;
        let limit = 100;
        let total = 0;

        do {
            const response = await spotifyApi.getAlbumTracks(albumId, { limit, offset });
            total = response.body.total;
            offset += limit;

            for (const item of response.body.items) {
                if (item && item.name) {
                    const mainArtist = item.artists?.[0]?.name || '';
                    const trackName = `${item.name} ${mainArtist}`.trim();
                    tracks.push(trackName);
                }
            }
        } while (offset < total);

        return tracks;
    } catch (error) {
        console.error("Error fetching Spotify album tracks via API, trying fallback:", error.message || error);
        return getSpotifyAlbumTracksFallback(albumId);
    }
}

async function getSpotifyAlbumTracksFallback(albumId) {
    try {
        const { getTracks } = require('spotify-url-info')(require('node-fetch'));
        const albumUrl = `https://open.spotify.com/album/${albumId}`;
        const items = await getTracks(albumUrl);
        const tracks = [];
        for (const item of items) {
            if (item) {
                const name = item.name || item.title || 'Unknown';
                const mainArtist = item.artist || (item.artists && item.artists[0]?.name) || item.subtitle || '';
                const trackName = `${name} ${mainArtist}`.trim();
                tracks.push(trackName);
            }
        }
        console.log(`✅ (Fallback) Fetched ${tracks.length} Spotify album tracks via spotify-url-info`);
        return tracks;
    } catch (err) {
        console.error("Fallback Spotify album tracks error:", err.message);
        return [];
    }
}

async function getSpotifyTrack(trackId) {
    if (!isValidSpotifyId(trackId)) {
        return null;
    }

    try {
        const data = await spotifyApi.clientCredentialsGrant();
        spotifyApi.setAccessToken(data.body.access_token);
        const response = await spotifyApi.getTrack(trackId);
        const track = response.body;
        const mainArtist = track.artists?.[0]?.name || '';
        return `${track.name} ${mainArtist}`.trim();
    } catch (error) {
        console.error("Error fetching Spotify track via API, trying fallback:", error.message || error);
        return getSpotifyTrackFallback(trackId);
    }
}

async function getSpotifyTrackFallback(trackId) {
    if (!isValidSpotifyId(trackId)) {
        return null;
    }

    const trackUrl = `https://open.spotify.com/track/${trackId}`;
    try {
        const { getPreview } = require('spotify-url-info')(require('node-fetch'));
        const preview = await getPreview(trackUrl);
        const name = preview.title || 'Unknown';
        const artist = preview.artist || '';
        return `${name} ${artist}`.trim();
    } catch (err) {
        // spotify-url-info's embed request can fail on newer Node versions.
        // Spotify's public oEmbed endpoint still provides a searchable title
        // without requiring a user Spotify login or a Lavalink Spotify plugin.
        try {
            const response = await fetch(
                `https://open.spotify.com/oembed?url=${encodeURIComponent(trackUrl)}`,
                { timeout: 8000 }
            );
            const data = await response.json();
            return typeof data?.title === 'string' && data.title.trim() ? data.title.trim() : null;
        } catch (oembedError) {
            console.error("Fallback Spotify track error:", oembedError.message || err.message);
            return null;
        }
    }
}


module.exports = {
    data: data,
    run: async (client, interaction) => {
        try {
            // Handle autocomplete
            if (interaction.isAutocomplete()) {
                const focusedOption = interaction.options.getFocused(true);
                if (focusedOption.name === 'name') {
                    const query = focusedOption.value;
                    if (query.length < 2) {
                        return interaction.respond([]);
                    }

                    // Avoid autocomplete override for URLs (YouTube, Spotify, SoundCloud, etc.)
                    const isUrl = query.startsWith('http://') || 
                                  query.startsWith('https://') || 
                                  query.includes('spotify.com') || 
                                  query.includes('youtube.com') || 
                                  query.includes('youtu.be') || 
                                  query.includes('soundcloud.com');
                    if (isUrl) {
                        return interaction.respond([]);
                    }

                    try {
                        const nodeManager = getLavalinkManager();
                        if (!nodeManager) {
                            return interaction.respond([]);
                        }

                        await nodeManager.ensureNodeAvailable();
                        const cleanQuery = cleanSearchQuery(query);
                        const resolve = await resolvePlayableTrack(client, cleanQuery, interaction.user.username);

                        if (resolve && resolve.tracks && resolve.tracks.length > 0) {
                            const choices = resolve.tracks.slice(0, 25).map(track => {
                                const info = track.info;
                                const duration = formatDuration(info.length);
                                const display = `${info.title} - ${info.author} (${duration})`;
                                // Autocomplete values are submitted to /play again. Use a
                                // stable search phrase instead of a provider URL: URL
                                // variants (music.youtube.com, playlist parameters, etc.)
                                // can resolve differently from the original suggestion.
                                const selectedQuery = `${info.title} ${info.author || ''}`.trim();
                                return {
                                    name: display.length > 100 ? display.substring(0, 97) + '...' : display,
                                    value: selectedQuery.length > 100 ? selectedQuery.substring(0, 100) : selectedQuery
                                };
                            });
                            return interaction.respond(choices);
                        } else {
                            return interaction.respond([]);
                        }
                    } catch (error) {
                        console.error('Autocomplete error:', error);
                        return interaction.respond([]);
                    }
                }
            }

            // Acknowledge before any database/network work. Discord invalidates
            // an interaction after three seconds, while getLang() may need a
            // MongoDB round trip on a cold connection.
            const deferred = await safeDeferReply(interaction);
            if (!deferred && !interaction.deferred && !interaction.replied) return;

            const lang = await getLang(interaction.guildId);
            const t = lang.music.play;
            let query = interaction.options.getString('name');
            const existingPlayer = client.riffy.players.get(interaction.guildId);
            const voiceCheck = await checkVC(interaction, existingPlayer);
            if (!voiceCheck.allowed) {
                const reply = await interaction.editReply(voiceCheck.response);
                setTimeout(() => reply.delete().catch(() => {}), 5000);
                return reply;
            }

            const nodeManager = getLavalinkManager();
            if (!nodeManager) {
                return sendErrorResponse(
                    interaction,
                    t.lavalinkManagerError.title + '\n\n' +
                    t.lavalinkManagerError.message + '\n' +
                    t.lavalinkManagerError.note,
                    5000
                );
            }
            
            try {
                await nodeManager.ensureNodeAvailable();
            } catch (error) {
                const nodeCount = nodeManager.getNodeCount();
                const totalCount = nodeManager.getTotalNodeCount();
                return sendErrorResponse(
                    interaction,
                    t.noNodes.title + '\n\n' +
                    t.noNodes.message
                        .replace('{connected}', nodeCount)
                        .replace('{total}', totalCount) + '\n' +
                    t.noNodes.note,
                    5000
                );
            }

            const userVoiceChannel = interaction.member.voice.channelId;
            
            if (existingPlayer && existingPlayer.voiceChannel !== userVoiceChannel) {
                try {
                    const { cleanupTrackMessages } = require('../../player.js');
                    await cleanupTrackMessages(client, existingPlayer);
                    existingPlayer.queue.clear();
                    existingPlayer.stop();
                    await new Promise(resolve => setTimeout(resolve, 300));
                    existingPlayer.destroy();
                    await new Promise(resolve => setTimeout(resolve, 500));
                } catch (error) {
                    console.error('Error destroying old player:', error);
                    try {
                        if (!existingPlayer.destroyed) {
                            existingPlayer.destroy();
                            await new Promise(resolve => setTimeout(resolve, 500));
                        }
                    } catch (e) {}
                }
            }

            await nodeManager.checkAllNodesHealth().catch(() => {});
            await nodeManager.forceConnectAllNodes().catch(() => {});
            await new Promise(res => setTimeout(res, 400));
            let player;
            let attempts = 0;
            const maxAttempts = 3;
            while (attempts < maxAttempts) {
                await nodeManager.ensureNodeAvailable();
                try {
                    player = client.riffy.createConnection({
                        guildId: interaction.guildId,
                        voiceChannel: userVoiceChannel,
                        textChannel: interaction.channelId,
                        deaf: true
                    });
                    break;
                } catch (err) {
                    attempts++;
                    const msg = err?.message || '';
                    if (attempts < maxAttempts && (msg.includes('No nodes are available') || msg.includes('fetch failed'))) {
                        await nodeManager.reconnectNodesNow?.(5000).catch(() => {});
                        await nodeManager.ensureNodeAvailable();
                        await new Promise(res => setTimeout(res, 700));
                        continue;
                    }
                    if (attempts >= maxAttempts) {
                        await nodeManager.refreshRiffy?.();
                        await nodeManager.ensureNodeAvailable();
                        player = client.riffy.createConnection({
                            guildId: interaction.guildId,
                            voiceChannel: userVoiceChannel,
                            textChannel: interaction.channelId,
                            deaf: true
                        });
                        break;
                    }
                    throw err;
                }
            }

            let tracksToQueue = [];
            let isPlaylist = false;

            const spotifyResource = extractSpotifyResource(query);
            const isSpotifyUrl = query.includes('spotify.com');
            if (isSpotifyUrl && spotifyResource && isValidSpotifyId(spotifyResource.id)) {
                try {
                    let spotifyType = spotifyResource.type;
                    let spotifyId = spotifyResource.id;

                    if (!spotifyType || !spotifyId) {
                        const spotifyData = await getData(query);
                        spotifyType = spotifyData.type;
                        spotifyId = spotifyData.id || query.split(`/${spotifyType}/`)[1]?.split('?')[0];
                    }

                    if (!isValidSpotifyId(spotifyId)) {
                        throw new Error('Invalid Spotify identifier');
                    }

                    if (spotifyType === 'track') {
                        // Fetch track name (tries API first, falls back to spotify-url-info getPreview)
                        const trackName = await getSpotifyTrack(spotifyId);
                        if (trackName) {
                            tracksToQueue.push(trackName);
                        } else {
                            throw new Error("Could not resolve Spotify track info");
                        }
                    } else if (spotifyType === 'playlist') {
                        isPlaylist = true;
                        tracksToQueue = await getSpotifyPlaylistTracks(spotifyId);
                    } else if (spotifyType === 'album') {
                        isPlaylist = true;
                        tracksToQueue = await getSpotifyAlbumTracks(spotifyId);
                    } else {
                        throw new Error(`Unsupported Spotify type: ${spotifyType}`);
                    }
                } catch (err) {
                    console.warn('[ PLAY ] Spotify lookup failed, falling back to text search:', err.message || err);
                    query = getSpotifySearchFallbackText(query);
                }
            } else if (isSpotifyUrl) {
                query = getSpotifySearchFallbackText(query);
            }

            if (!query.includes('spotify.com') || !tracksToQueue.length) {
                let resolve;
                const searchQuery = cleanSearchQuery(query);
                try {
                    resolve = await resolvePlayableTrack(client, searchQuery, interaction.user.username);
                } catch (err) {
                    const msg = err?.message || '';
                    if (msg.includes('fetch failed') || msg.includes('No nodes are available') || (err.cause && err.cause.code === 'ECONNREFUSED')) {
                        await nodeManager.reconnectNodesNow?.(5000).catch(() => {});
                        await nodeManager.ensureNodeAvailable();
                        resolve = await resolvePlayableTrack(client, searchQuery, interaction.user.username);
                    } else {
                        throw err;
                    }
                }

                console.log(`[ PLAY ] Resolved query="${searchQuery}" loadType=${resolve?.loadType || 'none'} tracks=${Array.isArray(resolve?.tracks) ? resolve.tracks.length : 0}`);

                if (!resolve || typeof resolve !== 'object' || !Array.isArray(resolve.tracks)) {
                    return sendErrorResponse(
                        interaction,
                        t.invalidResponse.title + '\n\n' +
                        t.invalidResponse.message + '\n' +
                        t.invalidResponse.note,
                        5000
                    );
                }

                if (resolve.loadType === 'playlist') {
                    isPlaylist = true;
                    for (const track of resolve.tracks) {
                        track.info.requester = interaction.user.username;
                        player.queue.add(track);
                        requesters.set(track.info.uri, interaction.user.username);
                    }
                } else if (resolve.loadType === 'search' || resolve.loadType === 'track') {
                    const track = resolve.tracks.shift();
                    track.info.requester = interaction.user.username;
                    player.queue.add(track);
                    requesters.set(track.info.uri, interaction.user.username);
                } else {
                    return sendErrorResponse(
                        interaction,
                        t.noResults.title + '\n\n' +
                        t.noResults.message + '\n' +
                        t.noResults.note,
                        5000
                    );
                }

                // Establish connection and start playback for non-Spotify tracks
                const connected = await waitForPlayerConnection(player);
                if (!connected) {
                    throw new Error('Voice connection was not established. The bot did not join the voice channel.');
                }

                if (!player.playing && !player.paused && player.queue.length > 0) {
                    player.play().catch(err => console.error('[ PLAY ] Error starting playback:', err.message));
                }

                const isPlaylistResolve = resolve.loadType === 'playlist';
                const successTitle = isPlaylistResolve ? t.success.titlePlaylist : t.success.titleTrack;
                const titleIcon = isPlaylistResolve ? (getEmoji('playlist') || '📚') : (getEmoji('music') || '🎵');
                const addedIcon = isPlaylistResolve ? (getEmoji('playlist') || '📚') : (getEmoji('success') || '✅');
                const statusIcon = player.playing ? (getEmoji('play') || '▶️') : (getEmoji('pause') || '⏸️');
                const statusText = stripLeadingIcons(player.playing ? t.success.nowPlaying : t.success.queueReady);
                
                const addedMessage = isPlaylistResolve 
                    ? t.success.playlistAdded.replace('{count}', resolve.tracks.length)
                    : t.success.trackAdded;

                const successContainer = buildPaleCard(
                    `${titleIcon} ${sanitizeTitle(successTitle, 'Play')}`,
                    [
                        `### ${addedIcon} Added` + '\n' +
                        addedMessage,
                        `### ${statusIcon} Status` + '\n' +
                        statusText
                    ]
                );

                const message = await interaction.editReply({ 
                    components: [successContainer],
                    flags: MessageFlags.IsComponentsV2,
                    fetchReply: true
                });

                setTimeout(() => {
                    message.delete().catch(() => {}); 
                }, isPlaylistResolve ? 5000 : 3000);

                return;
            }

            let queuedTracks = 0;
            const maxTracks = 200;
            const tracksList = tracksToQueue.slice(0, maxTracks);

            if (isPlaylist && tracksList.length > 0) {
                // Fast-start: Resolve the first playable track candidate immediately
                let firstTrackResolved = null;
                let firstTrackIndex = -1;

                for (let i = 0; i < tracksList.length; i++) {
                    let trackQuery = tracksList[i];
                    try {
                        const cleanQuery = cleanSearchQuery(trackQuery);
                        const resolve = await resolvePlayableTrack(client, cleanQuery, interaction.user.username);
                        if (resolve && resolve.tracks && resolve.tracks.length > 0) {
                            firstTrackResolved = resolve.tracks[0];
                            firstTrackResolved.info.requester = interaction.user.username;
                            player.queue.add(firstTrackResolved);
                            requesters.set(firstTrackResolved.info.uri, interaction.user.username);
                            firstTrackIndex = i;
                            queuedTracks = 1;
                            break;
                        }
                    } catch (error) {
                        console.error(`Error resolving first track candidate:`, error);
                    }
                }

                if (!firstTrackResolved) {
                    return sendErrorResponse(
                        interaction,
                        t.noResults.title + '\n\n' +
                        t.noResults.message + '\n' +
                        t.noResults.note,
                        5000
                    );
                }

                const connected = await waitForPlayerConnection(player);
                if (!connected) {
                    throw new Error('Voice connection was not established. The bot did not join the voice channel.');
                }

                if (!player.playing && !player.paused && player.queue.length > 0) {
                    player.play().catch(err => console.error('[ PLAY ] Error starting playlist playback:', err.message));
                }

                const successTitle = t.success.titlePlaylist;
                const titleIcon = getEmoji('playlist') || '📚';
                const addedIcon = getEmoji('playlist') || '📚';
                const statusIcon = player.playing ? (getEmoji('play') || '▶️') : (getEmoji('pause') || '⏸️');
                const statusText = stripLeadingIcons(player.playing ? t.success.nowPlaying : t.success.queueReady);
                
                const successContainer = buildPaleCard(
                    `${titleIcon} ${sanitizeTitle(successTitle, 'Play')}`,
                    [
                        `### ${addedIcon} Added` + '\n' +
                        t.success.playlistAdded.replace('{count}', tracksList.length),
                        `### ${statusIcon} Status` + '\n' +
                        statusText + ` (Loading tracks in background...)`
                    ]
                );

                const message = await interaction.editReply({ 
                    components: [successContainer],
                    flags: MessageFlags.IsComponentsV2,
                    fetchReply: true
                });

                setTimeout(() => {
                    message.delete().catch(() => {}); 
                }, 5000);

                // Background loading loop, preserving queue order
                (async () => {
                    const remainingTracks = tracksList.filter((_, idx) => idx !== firstTrackIndex);
                    const batchSize = 5;
                    for (let i = 0; i < remainingTracks.length; i += batchSize) {
                        const currentPlayer = client.riffy.players.get(interaction.guildId);
                        if (!currentPlayer || currentPlayer.destroyed || currentPlayer !== player) break;

                        const batch = remainingTracks.slice(i, i + batchSize);
                        
                        // Resolve the batch in parallel but preserve sequential array ordering
                        const resolvedBatch = await Promise.all(batch.map(async (trackQuery) => {
                            const cleanQuery = cleanSearchQuery(trackQuery);
                            try {
                                const resolve = await resolvePlayableTrack(client, cleanQuery, interaction.user.username);
                                if (resolve && resolve.tracks && resolve.tracks.length > 0) {
                                    const trackInfo = resolve.tracks[0];
                                    trackInfo.info.requester = interaction.user.username;
                                    return trackInfo;
                                }
                            } catch (error) {
                                console.error(`Error resolving background track ${cleanQuery}:`, error.message || error);
                            }
                            return null;
                        }));

                        // Push resolved tracks in correct order
                        const checkPlayer = client.riffy.players.get(interaction.guildId);
                        if (checkPlayer && !checkPlayer.destroyed && checkPlayer === player) {
                            for (const trackInfo of resolvedBatch) {
                                if (trackInfo) {
                                    player.queue.add(trackInfo);
                                    requesters.set(trackInfo.info.uri, interaction.user.username);
                                    queuedTracks++;
                                }
                            }
                            const { refreshNowPlayingPanel } = require('../../player.js');
                            await refreshNowPlayingPanel(client, interaction.guildId).catch(() => {});
                        }

                        await new Promise(resolve => setTimeout(resolve, 250));
                    }
                })();

            } else {
                // Single track case
                for (let i = 0; i < tracksList.length; i++) {
                    const trackQuery = tracksList[i];
                    try {
                        const cleanQuery = cleanSearchQuery(trackQuery);
                        const resolve = await resolvePlayableTrack(client, cleanQuery, interaction.user.username);
                        if (resolve && resolve.tracks && resolve.tracks.length > 0) {
                            const trackInfo = resolve.tracks[0];
                            player.queue.add(trackInfo);
                            requesters.set(trackInfo.info.uri, interaction.user.username);
                            queuedTracks++;
                        }
                    } catch (error) {
                        console.error(`Error resolving track ${trackQuery}:`, error);
                    }
                }

                if (queuedTracks === 0) {
                    return sendErrorResponse(
                        interaction,
                        t.noResults.title + '\n\n' +
                        t.noResults.message + '\n' +
                        t.noResults.note,
                        5000
                    );
                }

                const connected = await waitForPlayerConnection(player);
                if (!connected) {
                    throw new Error('Voice connection was not established. The bot did not join the voice channel.');
                }

                if (!player.playing && !player.paused && player.queue.length > 0) {
                    player.play().catch(err => console.error('[ PLAY ] Error starting track playback:', err.message));
                }

                const successTitle = t.success.titleTrack;
                const titleIcon = getEmoji('music') || '🎵';
                const addedIcon = getEmoji('success') || '✅';
                const statusIcon = player.playing ? (getEmoji('play') || '▶️') : (getEmoji('pause') || '⏸️');
                const statusText = stripLeadingIcons(player.playing ? t.success.nowPlaying : t.success.queueReady);
                
                const successContainer = buildPaleCard(
                    `${titleIcon} ${sanitizeTitle(successTitle, 'Play')}`,
                    [
                        `### ${addedIcon} Added` + '\n' +
                        t.success.trackAdded,
                        `### ${statusIcon} Status` + '\n' +
                        statusText
                    ]
                );

                const message = await interaction.editReply({ 
                    components: [successContainer],
                    flags: MessageFlags.IsComponentsV2,
                    fetchReply: true
                });

                setTimeout(() => {
                    message.delete().catch(() => {}); 
                }, 3000);
            }

        } catch (error) {
            const lang = await getLang(interaction.guildId).catch(() => ({ music: { play: { errors: {} } } }));
            const t = lang.music?.play?.errors || {};
            
            return handleCommandError(
                interaction,
                error,
                'play',
                (t.title || '## ❌ Error') + '\n\n' + (t.message || 'An error occurred while processing the request.\nPlease try again later.')
            );
        }
    },
    requesters: requesters,
};
