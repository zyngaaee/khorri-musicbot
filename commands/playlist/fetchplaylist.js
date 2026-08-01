const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } = require('discord.js');
const axios = require('axios');
const { requesters } = require('../music/play');

// Spotify token management
let spotifyToken = null;
let tokenExpiry = null;

async function getSpotifyToken() {
    const config = require('../../config.js');
    
    if (spotifyToken && tokenExpiry && Date.now() < tokenExpiry) {
        return spotifyToken;
    }
    
    if (!config.spotifyClientId || !config.spotifyClientSecret) {
        console.error('Spotify credentials missing in config.js');
        return null;
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
        console.log('✅ Spotify token obtained');
        return spotifyToken;
    } catch (error) {
        console.error('❌ Spotify token error:', error.response?.data || error.message);
        return null;
    }
}

function cleanSearchQuery(query) {
    if (!query || typeof query !== 'string') return '';
    if (query.startsWith('http://') || query.startsWith('https://')) return query;

    return query
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

function extractPlaylistId(url) {
    // Match Spotify playlist URL patterns
    const patterns = [
        /playlist\/([a-zA-Z0-9]+)/,
        /spotify\.com\/playlist\/([a-zA-Z0-9]+)/,
        /open\.spotify\.com\/playlist\/([a-zA-Z0-9]+)/
    ];
    
    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) return match[1];
    }
    
    // If just the ID is provided (22 characters)
    if (url.match(/^[a-zA-Z0-9]{22}$/)) return url;
    
    return null;
}

async function getPlaylistInfo(playlistId) {
    const token = await getSpotifyToken();
    if (!token) {
        return getPlaylistInfoFallback(playlistId);
    }
    
    try {
        const response = await axios.get(`https://api.spotify.com/v1/playlists/${playlistId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        return {
            id: response.data.id,
            name: response.data.name,
            description: response.data.description || 'No description',
            trackCount: response.data.tracks.total,
            image: response.data.images[0]?.url,
            url: response.data.external_urls.spotify,
            owner: response.data.owner.display_name
        };
    } catch (error) {
        console.error('Get playlist error:', error.response?.status, error.response?.data);
        return getPlaylistInfoFallback(playlistId);
    }
}

async function getPlaylistInfoFallback(playlistId) {
    try {
        const { getData } = require('spotify-url-info')(require('node-fetch'));
        const playlistUrl = `https://open.spotify.com/playlist/${playlistId}`;
        const data = await getData(playlistUrl);
        console.log('✅ (Fallback) Fetched playlist info via spotify-url-info');
        return {
            id: playlistId,
            name: data.title || data.name || 'Spotify Playlist',
            description: data.subtitle || 'No description',
            trackCount: data.trackList?.length || 0,
            image: data.coverArt?.sources?.[0]?.url || null,
            url: playlistUrl,
            owner: data.subtitle || 'Spotify User'
        };
    } catch (err) {
        console.error('Fallback get playlist error:', err.message);
        return null;
    }
}

async function getPlaylistTracks(playlistId) {
    const token = await getSpotifyToken();
    if (!token) {
        return getPlaylistTracksFallback(playlistId);
    }
    
    const tracks = [];
    let nextUrl = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100`;
    const seenIds = new Set();
    
    try {
        while (nextUrl) {
            const response = await axios.get(nextUrl, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            
            const items = Array.isArray(response.data?.items) ? response.data.items : [];
            for (const item of response.data.items) {
                if (item && item.track && item.track.name) {
                    if (item.is_local || item.track.is_local || item.track.type !== 'track' || !item.track.id || item.track.uri?.includes('local')) {
                        continue;
                    }
                    if (seenIds.has(item.track.id)) {
                        continue;
                    }
                    seenIds.add(item.track.id);

                    tracks.push({
                        name: item.track.name,
                        artist: item.track.artists[0]?.name || 'Unknown Artist',
                        uri: item.track.uri
                    });
                }
            }
            
            nextUrl = response.data.next;
        }
        
        console.log(`✅ Fetched ${tracks.length} tracks from playlist`);
        return tracks;
    } catch (error) {
        console.error('❌ Fetch tracks error:', error.message);
        return getPlaylistTracksFallback(playlistId);
    }
}

async function getPlaylistTracksFallback(playlistId) {
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
                tracks.push({
                    name: item.title || item.name || 'Unknown',
                    artist: item.artist || item.subtitle || (item.artists && item.artists[0]?.name) || 'Unknown Artist',
                    uri: item.uri
                });
            }
        }
        console.log(`✅ (Fallback) Fetched ${tracks.length} tracks from playlist`);
        return tracks;
    } catch (err) {
        console.error('Fallback fetch tracks error:', err.message);
        return [];
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('fetchplaylist')
        .setDescription('Load a Spotify playlist into the queue')
        .addStringOption(option => option
            .setName('url')
            .setDescription('Spotify playlist URL')
            .setRequired(true)
        ),
    
    run: async (client, interaction) => {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        
        const url = interaction.options.getString('url');
        const playlistId = extractPlaylistId(url);
        
        if (!playlistId) {
            return interaction.editReply({ 
                content: '❌ Invalid Spotify playlist URL.\n\n✅ Valid format: `https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M`' 
            });
        }
        
        // Note: Spotify credentials are optional since we have a fallback via spotify-url-info
        
        await interaction.editReply({ content: '🔍 Fetching playlist from Spotify...' });
        
        const playlist = await getPlaylistInfo(playlistId);
        
        if (!playlist) {
            return interaction.editReply({ 
                content: '❌ Playlist not found or is private. Make sure the playlist is public.' 
            });
        }
        
        // Show playlist info
        const embed = new EmbedBuilder()
            .setTitle(`📋 ${playlist.name}`)
            .setDescription(playlist.description.substring(0, 200))
            .addFields(
                { name: '👤 Owner', value: playlist.owner, inline: true },
                { name: '🎵 Tracks', value: `${playlist.trackCount} songs`, inline: true }
            )
            .setColor(0x1DB954);
        
        if (playlist.image) {
            embed.setThumbnail(playlist.image);
        }
        
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('confirm_load')
                    .setLabel('✅ Load & Play')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('cancel_load')
                    .setLabel('❌ Cancel')
                    .setStyle(ButtonStyle.Danger)
            );
        
        await interaction.editReply({
            embeds: [embed],
            components: [row]
        });
        
        const filter = i => i.user.id === interaction.user.id;
        const collector = interaction.channel.createMessageComponentCollector({ filter, time: 60000, max: 1 });
        
        collector.on('collect', async i => {
            if (i.customId === 'cancel_load') {
                await i.update({ content: '❌ Cancelled.', components: [], embeds: [] });
                return;
            }
            
            if (i.customId === 'confirm_load') {
                await i.deferUpdate();
                
                // Check voice channel
                const voiceChannel = interaction.member.voice.channel;
                if (!voiceChannel) {
                    await interaction.editReply({ content: '❌ You need to be in a voice channel to play music!', components: [], embeds: [] });
                    return;
                }
                
                await interaction.editReply({ 
                    content: `🔄 Loading **${playlist.name}** (${playlist.trackCount} tracks)... This may take a moment.`,
                    components: [], 
                    embeds: [] 
                });
                
                // Get all tracks
                const tracks = await getPlaylistTracks(playlistId);
                
                if (tracks.length === 0) {
                    await interaction.editReply({ content: `❌ No tracks found in "${playlist.name}".` });
                    return;
                }
                
                // Get or create player
                let player = client.riffy.players.get(interaction.guildId);
                if (player && player.voiceChannel !== voiceChannel.id) {
                    try {
                        const { cleanupTrackMessages } = require('../../player.js');
                        await cleanupTrackMessages(client, player);
                        player.queue.clear();
                        player.stop();
                        await new Promise(resolve => setTimeout(resolve, 300));
                        player.destroy();
                        await new Promise(resolve => setTimeout(resolve, 500));
                    } catch (_) {}
                    player = null;
                }
                
                if (!player || player.destroyed) {
                    player = client.riffy.createConnection({
                        guildId: interaction.guildId,
                        voiceChannel: voiceChannel.id,
                        textChannel: interaction.channelId,
                        deaf: true
                    });
                }
                
                // Fast-start: Resolve the first playable track candidate immediately
                let firstTrackResolved = null;
                let firstTrackIndex = -1;
                
                for (let i = 0; i < tracks.length; i++) {
                    const track = tracks[i];
                    let searchQuery = cleanSearchQuery(`${track.name} ${track.artist}`);
                        
                    try {
                        const result = await client.riffy.resolve({
                            query: searchQuery,
                            requester: interaction.user.username
                        });
                        
                        if (result && result.tracks && result.tracks.length) {
                            firstTrackResolved = result.tracks[0];
                            firstTrackResolved.info.requester = interaction.user.username;
                            player.queue.add(firstTrackResolved);
                            requesters.set(firstTrackResolved.info.uri, interaction.user.username);
                            firstTrackIndex = i;
                            break;
                        }
                    } catch (e) {
                        console.warn(`Failed to resolve track candidate at index ${i}:`, e.message || e);
                    }
                }
                
                if (!firstTrackResolved) {
                    await interaction.editReply({ content: `❌ Could not resolve any tracks from "${playlist.name}" on YouTube.` });
                    return;
                }
                
                // Play instantly
                if (!player.playing && !player.paused && player.queue.length > 0) {
                    await player.play().catch(() => {});
                }
                
                await interaction.editReply({ 
                    content: `🎵 Started playing **${playlist.name}**!\n⏳ Loading remaining tracks in the background...` 
                });
                
                const publicMsg = await interaction.channel.send(`🎵 Added **${playlist.name}** to the queue! Starting playback...`);
                setTimeout(() => publicMsg.delete().catch(() => {}), 10000);

                // Background loading loop, preserving sequential order
                (async () => {
                    const remainingTracks = tracks.filter((_, idx) => idx !== firstTrackIndex);
                    const batchSize = 5;
                    let added = 1; 
                    let failed = 0;
                    
                    for (let i = 0; i < remainingTracks.length; i += batchSize) {
                        const currentPlayer = client.riffy.players.get(interaction.guildId);
                        if (!currentPlayer || currentPlayer.destroyed || currentPlayer !== player) break;
                        
                        const batch = remainingTracks.slice(i, i + batchSize);
                        
                        // Resolve the batch in parallel but preserve relative array ordering
                        const resolvedBatch = await Promise.all(batch.map(async (track) => {
                            let searchQuery = cleanSearchQuery(`${track.name} ${track.artist}`);
                                
                            try {
                                const result = await client.riffy.resolve({
                                    query: searchQuery,
                                    requester: interaction.user.username
                                });
                                
                                if (result && result.tracks && result.tracks.length) {
                                    const trackToAdd = result.tracks[0];
                                    trackToAdd.info.requester = interaction.user.username;
                                    return trackToAdd;
                                } else {
                                    failed++;
                                }
                            } catch (e) {
                                failed++;
                            }
                            return null;
                        }));
                        
                        // Add resolved tracks to queue in correct order
                        const checkPlayer = client.riffy.players.get(interaction.guildId);
                        if (checkPlayer && !checkPlayer.destroyed && checkPlayer === player) {
                            for (const trackToAdd of resolvedBatch) {
                                if (trackToAdd) {
                                    player.queue.add(trackToAdd);
                                    requesters.set(trackToAdd.info.uri, interaction.user.username);
                                    added++;
                                }
                            }
                            const { refreshNowPlayingPanel } = require('../../player.js');
                            await refreshNowPlayingPanel(client, interaction.guildId).catch(() => {});
                        }
                        
                        await interaction.editReply({ 
                            content: `🎵 Loading **${playlist.name}**: ${added} added, ${failed} failed (${added + failed}/${tracks.length})` 
                        }).catch(() => {});
                        
                        await new Promise(resolve => setTimeout(resolve, 250));
                    }
                    
                    await interaction.editReply({ 
                        content: `✅ Loaded **${added}** tracks from **${playlist.name}** to queue!${failed > 0 ? `\n⚠️ ${failed} tracks could not be resolved.` : ''}` 
                    }).catch(() => {});
                })();
            }
        });
        
        collector.on('end', () => {});
    }
};