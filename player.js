const { Riffy, Player } = require("riffy");
const { ContainerBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder, PermissionsBitField, MessageFlags, MediaGalleryBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder } = require("discord.js");
const { requesters } = require("./commands/music/play");
const { EnhancedMusicCard } = require("./utils/musicCard");
const config = require("./config.js");
const { getEmoji, getButtonEmoji } = require('./UI/emojis/emoji');
const colors = require('./UI/colors/colors');
const axios = require('axios');
const { autoplayCollection, playlistCollection } = require('./mongodb.js');
const { initializeLavalinkManager, getLavalinkManager } = require('./lavalink.js');
const { cardFromMessage, safeDeferUpdate, stripLeadingIcons, buildPaleCard } = require('./utils/responseHandler.js');
const { normalizeSearchQuery } = require('./utils/musicSearch.js');

let getLangSync, getLang;
try {
    const langLoader = require('./utils/languageLoader.js');
    getLangSync = langLoader.getLangSync;
    getLang = langLoader.getLang;
} catch (e) {
    getLangSync = () => ({ console: {} });
    getLang = async () => ({ player: {} });
}
const guildTrackMessages = new Map();
const nowPlayingMessages = new Map();
const progressUpdateIntervals = new Map();
const guildActiveFilter = new Map();
const guildTrackMediaCache = new Map();
const autoplayFallbackCooldowns = new Map();
const AUTOPLAY_FALLBACK_COOLDOWN_MS = 30000;
const musicCard = new EnhancedMusicCard();
const useGeneratedSongCard = config.generateSongCard !== false;
const enableVoiceChannelIdPatch = config.enableVoiceChannelIdPatch === true;
const voiceDebug = config.voiceDebug === true;
const COMMAND_MENTION_CACHE_TTL_MS = 5 * 60 * 1000;
let commandMentionCache = {
    expiresAt: 0,
    map: new Map()
};

async function getCommandMentionMap(client) {
    const now = Date.now();
    if (commandMentionCache.expiresAt > now && commandMentionCache.map.size) {
        return commandMentionCache.map;
    }

    const map = new Map();
    try {
        const fetched = await client.application.commands.fetch();
        fetched.forEach((cmd) => {
            if (cmd?.name && cmd?.id) map.set(cmd.name, cmd.id);
        });
    } catch (_) {
        // Fallback to plain /command text when mentions cannot be fetched.
    }

    commandMentionCache = {
        expiresAt: now + COMMAND_MENTION_CACHE_TTL_MS,
        map
    };

    return map;
}

function getCommandRef(name, mentionMap) {
    const id = mentionMap?.get?.(name);
    return id ? `</${name}:${id}>` : `/${name}`;
}

function buildRandomTryHint(mentionMap) {
    const searchIcon = getEmoji('search') || '🔎';
    const pool = ['play', 'queue', 'search', 'history', 'filters', 'trackinfo', 'stats', 'support'];
    const picks = [];

    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    for (const cmd of shuffled) {
        if (picks.length >= 3) break;
        picks.push(cmd);
    }

    const refs = [getCommandRef('help', mentionMap), ...picks.map((cmd) => getCommandRef(cmd, mentionMap))];
    return `${searchIcon} Try: ${refs.join(' • ')}`;
}

const PLAYER_FAVORITES_NAME = 'AutoFavourites';
const LEGACY_PLAYER_FAVORITES_NAME = '__FAVORITES__';
const PLAYER_FILTER_OPTIONS = [
    { label: 'Karaoke', value: 'karaoke' },
    { label: 'Timescale', value: 'timescale' },
    { label: 'Tremolo', value: 'tremolo' },
    { label: 'Vibrato', value: 'vibrato' },
    { label: '3D', value: 'rotation' },
    { label: 'Distortion', value: 'distortion' },
    { label: 'Channel Mix', value: 'channelmix' },
    { label: 'Low Pass', value: 'lowpass' },
    { label: 'Bassboost', value: 'bassboost' },
    { label: 'Nightcore', value: 'nightcore' },
    { label: 'Daycore', value: 'daycore' }
];

function createAddSongModal() {
    const modal = new ModalBuilder()
        .setCustomId('player_modal_addsong')
        .setTitle('Add Song to Queue');

    const input = new TextInputBuilder()
        .setCustomId('query')
        .setLabel('Song Name or URL')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. Adele Skyfall or https://...')
        .setRequired(true)
        .setMaxLength(200);

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return modal;
}

function createVolumeModal(currentVolume = 100) {
    const modal = new ModalBuilder()
        .setCustomId('player_modal_volume')
        .setTitle('Set Volume');

    const input = new TextInputBuilder()
        .setCustomId('volume')
        .setLabel('Volume (1-100)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder(String(Math.min(100, Math.max(1, currentVolume || 100))))
        .setRequired(true)
        .setMaxLength(3);

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return modal;
}

function createSaveSongModal() {
    const modal = new ModalBuilder()
        .setCustomId('player_modal_save_song')
        .setTitle('Save Song to Playlist');

    const input = new TextInputBuilder()
        .setCustomId('playlistName')
        .setLabel('Playlist Name')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('My Favorites')
        .setRequired(true)
        .setMaxLength(80);

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return modal;
}

function patchVoiceChannelIdSupport(player) {
    const connection = player?.connection;
    if (!connection || connection.__voiceChannelIdPatchApplied) return;

    connection.__voiceChannelIdPatchApplied = true;
    connection.voice = connection.voice || {};

    if (!connection.voice.channelId && player.voiceChannel) {
        connection.voice.channelId = player.voiceChannel;
    }

    if (typeof connection.setStateUpdate === "function") {
        const originalSetStateUpdate = connection.setStateUpdate.bind(connection);
        connection.setStateUpdate = (data) => {
            originalSetStateUpdate(data);
            const channelId = data?.channel_id || connection.voiceChannel || player.voiceChannel || null;
            if (channelId) {
                connection.voice.channelId = channelId;
            }
            if (voiceDebug) {
                console.log(`[ VOICE DEBUG ] stateUpdate guild=${player.guildId} channelId=${channelId || 'null'} sessionId=${data?.session_id ? 'yes' : 'no'}`);
            }
        };
    }

    if (typeof connection.updatePlayerVoiceData === "function") {
        const originalUpdatePlayerVoiceData = connection.updatePlayerVoiceData.bind(connection);
        connection.updatePlayerVoiceData = () => {
            if (!connection.voice.channelId) {
                connection.voice.channelId = connection.voiceChannel || player.voiceChannel || null;
            }
            if (voiceDebug) {
                const v = connection.voice || {};
                console.log(`[ VOICE DEBUG ] updatePlayerVoiceData guild=${player.guildId} channelId=${v.channelId || 'null'} sessionId=${v.sessionId ? 'yes' : 'no'} token=${v.token ? 'yes' : 'no'} endpoint=${v.endpoint ? 'yes' : 'no'}`);
            }
            originalUpdatePlayerVoiceData();
        };
    }
}

function stripMediaGallery(components = []) {
    return components.filter((component) => !(component instanceof MediaGalleryBuilder));
}

function formatSourceName(sourceName) {
    const raw = String(sourceName || 'Unknown').toLowerCase();
    if (raw === 'youtube') return 'YouTube';
    if (raw === 'soundcloud') return 'SoundCloud';
    if (raw === 'spotify') return 'Spotify';
    if (raw === 'applemusic') return 'Apple Music';
    return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function setTrackMediaCache(guildId, trackUri, mediaUrl = null, cardBuffer = null) {
    if (!guildId || !trackUri) return;
    guildTrackMediaCache.set(guildId, { trackUri, mediaUrl, cardBuffer });
}

function getTrackMediaCache(guildId, trackUri) {
    const cached = guildTrackMediaCache.get(guildId);
    if (!cached || cached.trackUri !== trackUri) return null;
    return cached;
}

function clearTrackMediaCache(guildId) {
    guildTrackMediaCache.delete(guildId);
}

function clearProgressUpdates(guildId) {
    const intervalId = progressUpdateIntervals.get(guildId);
    if (intervalId) {
        clearInterval(intervalId);
        progressUpdateIntervals.delete(guildId);
    }
}

function buildNowPlayingContainer(track, requesterName, t, progressBar, progressPercent, mediaUrl, actionRows = {}, playerState = {}) {
    const musicIcon = getEmoji('music') || '🎵';
    const titleIcon = getEmoji('music') || '🎧';
    const infoIcon = getEmoji('info') || 'ℹ️';
    const timeIcon = getEmoji('uptime') || '⏱️';
    const queueIcon = getEmoji('queue') || '📄';
    const userIcon = getEmoji('users') || '👤';
    const sourceIcon = getEmoji('servers') || '🌐';
    const playIcon = getEmoji('play') || '▶️';
    const pauseIcon = getEmoji('pause') || '⏸️';
    const loopIcon = getEmoji('settings') || '🔁';
    const controlsIcon = getEmoji('settings') || '⚙️';
    const manageIcon = getEmoji('owner') || '👑';
    const filterIcon = getEmoji('servers') || '🌐';
    const byText = t.trackInfo?.by || 'by';
    const isPaused = playerState.paused === true;
    const loopMode = playerState.loop || 'none';
    const isLoopOn = loopMode !== 'none';
    const sourceName = formatSourceName(track.info?.sourceName);
    const stateLabel = isPaused ? (t.playerState?.paused || 'Paused') : (t.playerState?.playing || 'Playing');
    const loopStateLabel = isLoopOn ? (t.playerState?.loopOn || 'Loop On') : (t.playerState?.loopOff || 'Loop Off');
    const infoLine = `${timeIcon} ${formatDuration(track.info.length)} • ${userIcon} ${requesterName || (t.trackInfo?.unknown || 'Unknown')} • ${sourceIcon} ${sourceName}`;
    const stateLine1 = `${isPaused ? pauseIcon : playIcon} ${stateLabel}`;
    const stateLine2 = `${loopIcon} ${loopStateLabel}`;
    const durationLine = `${timeIcon} ${formatDuration(track.info.length)}`;
    const requesterLine = `${userIcon} ${requesterName || (t.trackInfo?.unknown || 'Unknown')}`;
    const sourceLine = `${sourceIcon} ${sourceName}`;
    const queueHint = `${queueIcon} ${playerState.queueLength || 0} ${playerState.queueLength === 1 ? 'song' : 'songs'} in queue`;
    const tryHint = buildRandomTryHint(playerState.commandMentionMap);
    const showTitleBlock = !mediaUrl;

    const container = new ContainerBuilder();

    if (mediaUrl) {
        const mediaGallery = new MediaGalleryBuilder().addItems(
            (mediaItem) => mediaItem
                .setURL(mediaUrl)
                .setDescription(`${track.info?.title || 'Unknown Title'} - ${track.info?.author || 'Unknown Artist'}`)
        );

        container
            .addSeparatorComponents((separator) => separator)
            .addMediaGalleryComponents(mediaGallery);
    }

    if (showTitleBlock) {
        container.addTextDisplayComponents(
            (textDisplay) => textDisplay.setContent(
                `### ${titleIcon} ${track.info.title || 'Unknown Title'}\n` +
                `${byText} ${track.info.author || (t.trackInfo?.unknownArtist || 'Unknown Artist')}`
            )
        );
    }

    const showSongDetails = !mediaUrl || config.metadataTag === true;
    if (showSongDetails) {
        container
            .addSeparatorComponents((separator) => separator)
            .addTextDisplayComponents(
                (textDisplay) => textDisplay.setContent(
                    `### ${infoIcon} ${t.songDetailsTitle || 'Song Details'}\n` +
                    `${stateLine1}\n` +
                    `${stateLine2}\n` +
                    `${durationLine}\n` +
                    `${requesterLine}\n` +
                    `${sourceLine}\n` +
                    `${queueHint}`
                )
            );
    }

    if (actionRows?.playbackRow) {
        container
            .addSeparatorComponents((separator) => separator)
            .addTextDisplayComponents((textDisplay) => textDisplay.setContent(`### ${controlsIcon} Playback`))
            .addActionRowComponents(actionRows.playbackRow);
    }

    if (actionRows?.manageRow) {
        container
            .addSeparatorComponents((separator) => separator)
            .addTextDisplayComponents((textDisplay) => textDisplay.setContent(`### ${manageIcon} Library`))
            .addActionRowComponents(actionRows.manageRow);
    }

    container
        .addSeparatorComponents((separator) => separator)
        .addTextDisplayComponents((textDisplay) => textDisplay.setContent(tryHint));

    return container;
}

async function sendMessageWithPermissionsCheck(channel, components, attachment) {
    try {
        const permissions = channel.permissionsFor(channel.guild.members.me);
        const needsAttachPermission = !!attachment;
        if (!permissions.has(PermissionsBitField.Flags.SendMessages)) {
            const lang = getLangSync();
            console.error(lang.console?.player?.lacksPermissions || "Bot lacks necessary permissions to send messages in this channel.");
            return;
        }

        let safeComponents = components;
        let safeAttachment = attachment;
        if (needsAttachPermission && !permissions.has(PermissionsBitField.Flags.AttachFiles)) {
            safeComponents = stripMediaGallery(components);
            safeAttachment = null;
        }

        const messageOptions = {
            components: safeComponents,
            flags: MessageFlags.IsComponentsV2
        };
        
        if (safeAttachment) {
            messageOptions.files = [safeAttachment];
        }
        
        try {
            const message = await channel.send(messageOptions);
            return message;
        } catch (sendError) {
            const fallbackComponents = stripMediaGallery(components);
            const fallbackOptions = {
                components: fallbackComponents,
                flags: MessageFlags.IsComponentsV2
            };
            try {
                const message = await channel.send(fallbackOptions);
                return message;
            } catch (_) {
                const minimalOptions = {
                    components: fallbackComponents,
                    flags: MessageFlags.IsComponentsV2
                };
                const message = await channel.send(minimalOptions);
                return message;
            }
        }
    } catch (error) {
        const langSync = getLangSync();
        console.error(langSync.console?.player?.errorSendingMessage?.replace('{message}', error.message) || "Error sending message:", error.message);
        const lang = await getLang(channel.guildId).catch(() => ({ console: { player: {} } }));
        const t = lang.console?.player || {};
        const errorContainer = cardFromMessage(
            `${t.unableToSendMessage?.title || '## ⚠️ Unable to Send Message'}\n\n` +
            `${t.unableToSendMessage?.message || 'Unable to send message. Check bot permissions.'}`,
            'Unable to Send Message'
        );
        await channel.send({ 
            components: [errorContainer],
            flags: MessageFlags.IsComponentsV2
        }).catch(() => {});
    }
}

async function sendTransientCard(channel, message, deleteMs = 5000, fallbackTitle = 'Notice') {
    const container = cardFromMessage(message, fallbackTitle);
    const sent = await channel.send({
        components: [container],
        flags: MessageFlags.IsComponentsV2
    }).catch(e => null);
    
    if (sent) {
        setTimeout(() => sent.delete().catch(() => {}), deleteMs);
    }
    return sent;
}

async function initializePlayer(client) {
    const nodeManager = await initializeLavalinkManager(client);
    client.riffy = nodeManager.riffy;
    client.lavalinkManager = nodeManager;
    client.nodeManager = nodeManager;

    client.riffy.on("playerCreate", (player) => {
        if (enableVoiceChannelIdPatch) {
            patchVoiceChannelIdSupport(player);
        }
        if (voiceDebug) {
            console.log(`[ VOICE DEBUG ] playerCreate guild=${player.guildId} voiceChannel=${player.voiceChannel || 'null'} patch=${enableVoiceChannelIdPatch ? 'on' : 'off'}`);
        }
    });

    // Riffy emits `trackError` with `(player, track, payload)`.  Listening to
    // Lavalink's event name (`trackException`) means these failures were never
    // reported by the bot, making a load failure look like a silent skip.
    client.riffy.on("trackError", async (player, track, payload) => {
        const langSync = getLangSync();
        const errorMsg = payload?.exception?.message || payload?.exception?.cause || payload?.message || 'Unknown error';
        const isTimeout = errorMsg.includes('timeout') || errorMsg.includes('Read timed out') || errorMsg.includes('SocketTimeoutException');
        
        if (isTimeout) {
            console.warn(`${colors.cyan}[ LAVALINK ]${colors.reset} ${colors.yellow}Track timeout for guild ${player?.guildId || 'unknown'}: ${errorMsg}${colors.reset}`);
        } else {
            console.error(`${colors.cyan}[ LAVALINK ]${colors.reset} ${colors.red}${langSync.console?.player?.trackException?.replace('{guildId}', player?.guildId || 'unknown').replace('{message}', errorMsg) || `Track Exception for guild ${player?.guildId || 'unknown'}: ${errorMsg}`}${colors.reset}`);
        }

    });

    client.riffy.on("trackStuck", (player, track, payload) => {
        const lang = getLangSync();
        const errorMsg = payload?.thresholdMs ? `stuck for ${payload.thresholdMs}ms` : 'Unknown error';
        
        if (errorMsg.includes('Connect Timeout') || errorMsg.includes('fetch failed') || errorMsg.includes('timeout')) {
            console.warn(`${colors.cyan}[ LAVALINK ]${colors.reset} ${colors.yellow}Track stuck due to connection timeout for guild ${player?.guildId || 'unknown'} - will retry${colors.reset}`);
        } else {
            console.error(`${colors.cyan}[ LAVALINK ]${colors.reset} ${colors.red}${lang.console?.player?.trackStuck?.replace('{guildId}', player?.guildId || 'unknown').replace('{message}', errorMsg) || `Track Stuck for guild ${player?.guildId || 'unknown'}: ${errorMsg}`}${colors.reset}`);
        }
        
        if (player && !player.destroyed) {
            try {
                player.stop();
            } catch (stopError) {}
        }
    });

    client.riffy.on("trackStart", async (player, track) => {
        if (!track || !track.info) {
            const lang = getLangSync();
            console.error(`[ LAVALINK ] ${lang.console?.player?.trackNull?.replace('{guildId}', player.guildId) || `Track is null or missing info for guild ${player.guildId} - ignoring event`}`);
            return;
        }

        await new Promise(resolve => setTimeout(resolve, 200));

        const currentPlayer = client.riffy.players.get(player.guildId);
        if (!currentPlayer || currentPlayer !== player || player.destroyed) {
            const lang = getLangSync();
            console.error(`[ LAVALINK ] ${lang.console?.player?.playerInvalid?.replace('{guildId}', player.guildId) || `Player invalid or destroyed for guild ${player.guildId} - ignoring event`}`);
            return;
        }

        if (client.statusManager && track.info.title) {
            await client.statusManager.onTrackStart(player.guildId).catch(() => {});
        }

        const channel = client.channels.cache.get(player.textChannel);
        if (!channel) {
            const lang = getLangSync();
            console.error(`[ LAVALINK ] ${lang.console?.player?.channelNotFound?.replace('{guildId}', player.guildId) || `Channel not found for guild ${player.guildId}`}`);
            return;
        }

        const guildId = player.guildId;
        const trackUri = track.info.uri;
        const requester = requesters.get(trackUri);
        const lang = await getLang(guildId).catch(() => {
            const langSync = getLangSync();
            console.error(`[ PLAYER ] Failed to load language for guild ${guildId}, using default: ${langSync.console ? 'loaded' : 'failed'}`);
            return langSync;
        });
        const t = lang.console?.player || {};
        
        if (!t.trackInfo && !t.controls) {
            const langSync = getLangSync();
            console.warn(`[ PLAYER ] Language object missing player keys for guild ${guildId}. Using sync fallback.`);
            if (langSync.console?.player) {
                Object.assign(t, langSync.console.player);
            }
        }

        try {
            await playlistCollection.updateOne(
                { guildId, name: '__HISTORY__' },
                { 
                    $push: { 
                        songs: { 
                            $each: [trackUri], 
                            $slice: -100 
                        } 
                    } 
                },
                { upsert: true }
            );
        } catch (error) {
            const lang = getLangSync();
            console.error(lang.console?.player?.errorSavingHistory || "Error saving to history:", error);
        }

        try {
            const nodeManager = getLavalinkManager();
            if (nodeManager && track.info.title) {
                await nodeManager.updateVoiceChannelStatus(guildId, track.info.title, track.info.author);
            }
            
            await new Promise(resolve => setTimeout(resolve, 500));
            const canAttachFiles = channel.permissionsFor(channel.guild.members.me)?.has(PermissionsBitField.Flags.AttachFiles);
            
            let attachment = null;
            let cardBufferForCache = null;

            if (useGeneratedSongCard) {
                let thumbnailURL = track.info.thumbnail || '';
                const trackUri = track.info.uri || '';
                
                if ((!thumbnailURL || !thumbnailURL.startsWith('http')) && trackUri) {
                    thumbnailURL = trackUri;
                }
                
                try {
                    const cardBuffer = await musicCard.generateCard({
                        thumbnailURL: thumbnailURL,
                        trackURI: trackUri,
                        songTitle: track.info.title,
                        songArtist: track.info.author || 'Unknown Artist',
                        trackRequester: requester,
                        isPlaying: true,
                        showVisualizer: config.showVisualizer !== false,
                        currentPositionMs: 0,
                        totalDurationMs: track.info.length || 0,
                    });
                    if (cardBuffer && cardBuffer.length > 0) {
                        cardBufferForCache = cardBuffer;
                        attachment = new AttachmentBuilder(cardBuffer, { name: 'song-banner.png' });
                    }
                } catch (error) {
                    const langSync = getLangSync();
                    console.warn(langSync.console?.player?.errorMusicCard?.replace('{message}', error.message) || `Music card render failed, sending embed without card: ${error.message}`);
                }
            }

            const commandMentionMap = await getCommandMentionMap(client);
            const actionRows = buildPlayerActionRows(player.paused, player.loop, guildActiveFilter.get(guildId) || null);
            const nowPlayingContainer = buildNowPlayingContainer(
                track,
                requester,
                t,
                config.showProgressBar !== false ? createProgressBar(0, track.info.length) : null,
                0,
                attachment && canAttachFiles ? 'attachment://song-banner.png' : null,
                actionRows,
                { paused: player.paused, loop: player.loop, currentPosition: 0, queueLength: player.queue.length, commandMentionMap }
            );
            const components = [nowPlayingContainer];

            let message = null;
            const existingMessageData = nowPlayingMessages.get(guildId);
            if (existingMessageData) {
                clearProgressUpdates(guildId);
                if (existingMessageData.collector && typeof existingMessageData.collector.stop === 'function') {
                    try {
                        existingMessageData.collector.stop();
                    } catch (_) {}
                }

                try {
                    const oldMsg = await channel.messages.fetch(existingMessageData.messageId).catch(() => null);
                    if (oldMsg) {
                        await oldMsg.delete().catch(() => {});
                    }
                } catch (deleteError) {
                    console.warn(`Failed to delete previous track message: ${deleteError.message}`);
                }
            }

            if (!message) {
                message = await sendMessageWithPermissionsCheck(channel, components, canAttachFiles ? attachment : null);
                
                if (!message) {
                    const langSync = getLangSync();
                    console.error(langSync.console?.player?.errorSendingEmbed?.replace('{guildId}', guildId) || `Failed to send embed for track ${track.info.title} in guild ${guildId}`);
                    return;
                }

                if (!guildTrackMessages.has(guildId)) {
                    guildTrackMessages.set(guildId, []);
                }
                guildTrackMessages.get(guildId).push({
                    messageId: message.id,
                    channelId: channel.id,
                    type: 'track'
                });
            }

            const sentMediaUrl = message.attachments?.first()?.url || null;
            if (sentMediaUrl || cardBufferForCache) {
                setTrackMediaCache(guildId, track.info.uri, sentMediaUrl, cardBufferForCache);
            } else {
                clearTrackMediaCache(guildId);
            }

            const intervalId = startProgressUpdates(client, guildId, message, player, track);
            if (intervalId) {
                progressUpdateIntervals.set(guildId, intervalId);
            }

            const collector = setupCollector(client, player, channel, message);

            nowPlayingMessages.set(guildId, {
                messageId: message.id,
                channelId: channel.id,
                player: player,
                trackUri: track.info.uri,
                collector: collector
            });

        } catch (error) {
            const langSync = getLangSync();
            console.error(langSync.console?.player?.errorMusicCard?.replace('{message}', error.message) || "Error creating or sending music card:", error.message);
            const lang = await getLang(guildId).catch(() => ({ console: { player: {} } }));
            const t = lang.console?.player || {};
            const loadCardError = cardFromMessage(
                `${t.unableToLoadCard?.title || '## ⚠️ Unable to Load Track Card'}\n\n` +
                `${t.unableToLoadCard?.message || 'Unable to load track card. Continuing playback...'}`,
                'Track Card Error'
            );
            await channel.send({ 
                components: [loadCardError],
                flags: MessageFlags.IsComponentsV2
            }).catch(() => {});
        }
    });

    client.riffy.on("trackEnd", async (player, track, payload) => {
        const guildId = player.guildId;
        console.log(`[ PLAYBACK ] Track ended guild=${guildId} track=${track?.info?.title || 'unknown'} reason=${payload?.reason || 'unknown'} queue=${player.queue.length}`);
        clearTrackMediaCache(guildId);
        
        if (client.statusManager) {
            await client.statusManager.onTrackEnd(guildId).catch(() => {});
        }
        
        clearProgressUpdates(guildId);
        
        const nodeManager = getLavalinkManager();
        if (nodeManager) {
            await nodeManager.resetVoiceChannelStatus(guildId, player.voiceChannel);
        }
        
        const channel = client.channels.cache.get(player.textChannel);
        if (channel) {
            const settings = await autoplayCollection.findOne({ guildId }).catch(() => null);
            const hasNextTrack = player.queue.length > 0 || player.loop === "queue" || player.loop === "track" || settings?.autoplay;
            
            if (!hasNextTrack) {
            } else {
                clearTrackMediaCache(guildId);
            }
        }
    });


    client.riffy.on("playerDisconnect", async (player) => {
        const guildId = player.guildId;
        clearTrackMediaCache(guildId);
        
        if (client.statusManager) {
            await client.statusManager.onPlayerDisconnect(guildId).catch(() => {});
        }
        
        clearProgressUpdates(guildId);
        
        const nodeManager = getLavalinkManager();
        if (nodeManager) {
            await nodeManager.resetVoiceChannelStatus(guildId, player.voiceChannel);
        }

        await cleanupTrackMessages(client, player).catch(() => {});
    });

    client.riffy.on("queueEnd", async (player) => {
        const channel = client.channels.cache.get(player.textChannel);
        const guildId = player.guildId;
        clearTrackMediaCache(guildId);
        
        const nodeManager = getLavalinkManager();
        if (nodeManager) {
            await nodeManager.resetVoiceChannelStatus(guildId, player.voiceChannel);
        }
    
        try {
            const settings = await autoplayCollection.findOne({ guildId });
            const is24_7 = settings?.twentyfourseven;
    
            if (settings?.autoplay) {
                let autoplaySuccess = false;
                
                try {
                    await player.autoplay(player);
                    if (player.queue.length > 0 || player.playing || player.current) {
                        autoplaySuccess = true;
                    }
                } catch (autoplayErr) {
                    console.warn(`[ AUTOPLAY ] Built-in autoplay attempt failed: ${autoplayErr.message || autoplayErr}`);
                }

                // Fallback autoplay search if built-in autoplay did not queue/start a track
                if (!autoplaySuccess && player.previous?.info) {
                    try {
                        const prev = player.previous.info;
                        const fallbackKey = `${guildId}:${normalizeSearchQuery(`${prev.title} ${prev.author}`).toLowerCase()}`;
                        const cooldownUntil = autoplayFallbackCooldowns.get(fallbackKey) || 0;
                        if (Date.now() >= cooldownUntil) {
                            autoplayFallbackCooldowns.set(fallbackKey, Date.now() + AUTOPLAY_FALLBACK_COOLDOWN_MS);

                            const queries = [
                                normalizeSearchQuery(`${prev.title} ${prev.author}`),
                                normalizeSearchQuery(prev.title)
                            ].filter(Boolean);

                            for (const q of queries) {
                                const res = await client.riffy.resolve({ query: q, requester: prev.requester || 'Autoplay' }).catch(() => null);
                                if (res && res.tracks && res.tracks.length > 0) {
                                    const candidate = res.tracks.find(tr => tr.info.identifier !== prev.identifier && tr.info.uri !== prev.uri) || res.tracks[0];
                                    if (candidate) {
                                        candidate.info.requester = prev.requester || 'Autoplay';
                                        player.queue.add(candidate);
                                        if (!player.playing && !player.paused) {
                                            await player.play().catch(() => {});
                                        }
                                        autoplaySuccess = true;
                                        console.log(`[ AUTOPLAY ] Successfully queued fallback autoplay track: ${candidate.info.title}`);
                                        break;
                                    }
                                }
                            }
                        } else {
                            console.warn(`[ AUTOPLAY ] Skipping fallback search for ${guildId} due to cooldown`);
                        }
                    } catch (fallbackErr) {
                        console.error('[ AUTOPLAY ] Fallback search error:', fallbackErr.message || fallbackErr);
                    }
                }

                if (!autoplaySuccess && player.queue.length === 0) {
                    const lang = await getLang(guildId).catch(() => ({ console: { player: {} } }));
                    const t = lang.console?.player || {};
                    if (!is24_7) {
                        player.destroy();
                        await cleanupTrackMessages(client, player).catch(() => {});
                        await sendTransientCard(channel, t.queueEnd?.noMoreAutoplay || "⚠️ **No more tracks to autoplay. Disconnecting...**", 5000, 'Autoplay Ended');
                    } else {
                        await sendTransientCard(channel, t.queueEnd?.twentyfoursevenEmpty || "🔄 **24/7 Mode: Bot will stay in voice channel. Queue is empty.**", 5000, 'Queue Empty');
                    }
                }
            } else {
                const lang = await getLang(guildId).catch(() => ({ player: {}, console: {} }));
                const t = lang.console?.player || {};
                const langSync = getLangSync();
                console.log(langSync.console?.player?.autoplayDisabled?.replace('{guildId}', guildId) || `Autoplay is disabled for guild: ${guildId}`);
                if (!is24_7) {
                    player.destroy();
                    await cleanupTrackMessages(client, player).catch(() => {});
                    await sendTransientCard(channel, t.queueEnd?.queueEndedAutoplayDisabled || "🎶 **Queue has ended. Autoplay is disabled.**", 5000, 'Queue Ended');
                } else {
                    await sendTransientCard(channel, t.queueEnd?.twentyfoursevenEmpty || "🔄 **24/7 Mode: Bot will stay in voice channel. Queue is empty.**", 5000, 'Queue Empty');
                }
            }
        } catch (error) {
            const langSync = getLangSync();
            console.error(langSync.console?.player?.errorQueueEnd || "Error handling queue end:", error);
            const settings = await autoplayCollection.findOne({ guildId });
            const lang = await getLang(guildId).catch(() => ({ console: { player: {} } }));
            const t = lang.console?.player || {};
            if (!settings?.twentyfourseven) {
                player.destroy();
                await cleanupTrackMessages(client, player).catch(() => {});
                await sendTransientCard(channel, t.queueEnd?.queueEmpty || "👾 **Queue Empty! Disconnecting...**", 5000, 'Queue Empty');
            }
        }
    });
}

async function cleanupPreviousTrackMessages(channel, guildId) {
    const messages = guildTrackMessages.get(guildId) || [];
    
    for (const messageInfo of messages) {
        try {
            const fetchChannel = channel.client.channels.cache.get(messageInfo.channelId);
            if (fetchChannel) {
                const message = await fetchChannel.messages.fetch(messageInfo.messageId).catch(() => null);
                if (message && messageInfo.type === 'track') {
                    await message.delete().catch(() => {});
                }
            }
        } catch (error) {
            const lang = getLangSync();
            console.error(lang.console?.player?.errorCleanupPrevious || "Error in cleanup:", error);
        }
    }

    guildTrackMessages.set(guildId, []);
}

async function cleanupTrackMessages(client, player) {
    const guildId = player.guildId;
    clearTrackMediaCache(guildId);
    clearProgressUpdates(guildId);
    
    const messages = guildTrackMessages.get(guildId) || [];
    
    for (const messageInfo of messages) {
        try {
            const channel = client.channels.cache.get(messageInfo.channelId);
            if (channel) {
                const message = await channel.messages.fetch(messageInfo.messageId).catch(() => null);
                if (message) {
                    await message.delete().catch(() => {});
                }
            }
        } catch (error) {
            const lang = getLangSync();
            console.error(lang.console?.player?.errorCleanupTrack || "Error in track cleanup:", error);
        }
    }

    guildTrackMessages.set(guildId, []);
    nowPlayingMessages.delete(guildId);
}

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

async function refreshNowPlayingPanel(client, guildId) {
    const stored = nowPlayingMessages.get(guildId);
    if (!stored) return;

    const player = client.riffy.players.get(guildId);
    if (!player || player.destroyed || !player.current) return;

    const channel = client.channels.cache.get(stored.channelId);
    if (!channel) return;

    const msg = await channel.messages.fetch(stored.messageId).catch(() => null);
    if (!msg) return;

    const track = player.current;
    const lang = await getLang(guildId).catch(() => ({ console: { player: {} } }));
    const t = lang.console?.player || {};
    const requester = requesters.get(track.info.uri) || (t.trackInfo?.unknown || 'Unknown');
    const commandMentionMap = await getCommandMentionMap(client);
    const progressBar = createProgressBar(player.position || 0, track.info.length || 1);
    const canAttachFiles = channel.permissionsFor(channel.guild.members.me)?.has(PermissionsBitField.Flags.AttachFiles);
    const cachedMedia = useGeneratedSongCard ? getTrackMediaCache(guildId, track.info.uri) : null;
    let mediaUrl = null;
    let mediaAttachment = null;
    if (useGeneratedSongCard) {
        if (cachedMedia?.cardBuffer && canAttachFiles) {
            mediaAttachment = new AttachmentBuilder(cachedMedia.cardBuffer, { name: 'song-banner.png' });
            mediaUrl = 'attachment://song-banner.png';
        } else if (cachedMedia?.mediaUrl) {
            mediaUrl = cachedMedia.mediaUrl;
        }
        if (!mediaUrl) {
            mediaUrl = msg.attachments?.first()?.url || null;
            if (mediaUrl) {
                setTrackMediaCache(guildId, track.info.uri, mediaUrl, cachedMedia?.cardBuffer || null);
            }
        }
    }
    const actionRows = buildPlayerActionRows(player.paused, player.loop, guildActiveFilter.get(guildId) || null);

    const container = buildNowPlayingContainer(
        track,
        requester,
        t,
        config.showProgressBar !== false ? progressBar : null,
        Math.min(100, Math.round(((player.position || 0) / (track.info.length || 1)) * 100)),
        mediaUrl,
        actionRows,
        {
            paused: player.paused,
            loop: player.loop,
            currentPosition: player.position || 0,
            queueLength: player.queue.length,
            commandMentionMap
        }
    );

    const editPayload = {
        components: [container],
        flags: MessageFlags.IsComponentsV2
    };
    if (mediaAttachment) {
        editPayload.files = [mediaAttachment];
    }

    await msg.edit(editPayload).catch(() => {});
}

function setupCollector(client, closedPlayer, channel, message) {
    const filter = i => [
        'loopToggle', 'skipTrack', 'stopTrack', 'togglePlayback',
        'player_favorite', 'player_add_song', 'player_volume', 'player_save_song',
        'player_queue', 'player_shuffle', 'player_playlist', 'player_filter_select', 'player_filter_clear',
        'player_play_favorites', 'player_play_fav_song'
    ].includes(i.customId);

    const collector = message.createMessageComponentCollector({ filter, time: 300000 });

    collector.on('collect', async i => {
        const player = client.riffy.players.get(i.guildId) || closedPlayer;
        const member = i.member;
        const voiceChannel = member.voice.channel;
        const playerChannel = player.voiceChannel;

        if (!voiceChannel || voiceChannel.id !== playerChannel) {
            const lang = await getLang(channel.guildId).catch(() => ({ console: { player: {} } }));
            const t = lang.console?.player || {};
            const vcContainer = cardFromMessage(
                `${t.voiceChannelRequired?.title || '## 🔒 Voice Channel Required'}\n\n` +
                `${t.voiceChannelRequired?.message || 'You need to be in the same voice channel to use the controls!'}`,
                'Voice Channel Required'
            );
            const sentMessage = await channel.send({ 
                components: [vcContainer],
                flags: MessageFlags.IsComponentsV2
            });
            setTimeout(() => sentMessage.delete().catch(console.error), config.embedTimeout * 1000);
            return;
        }

        // PLAYLIST BUTTON - Runs /playlist menu command
        if (i.customId === 'player_playlist') {
            try {
                const playlistCommand = client.commands.get('playlist menu');
                
                if (playlistCommand && playlistCommand.run) {
                    let replied = false;
                    let editReplied = false;
                    
                    const mockInteraction = {
                        ...i,
                        commandName: 'playlist menu',
                        commandId: 'playlist',
                        commandType: 1,
                        version: 1,
                        token: i.token,
                        id: i.id,
                        applicationId: client.user.id,
                        channelId: channel.id,
                        guildId: channel.guildId,
                        user: i.user,
                        member: i.member,
                        guild: channel.guild,
                        channel: channel,
                        client: client,
                        createdAt: new Date(),
                        createdTimestamp: Date.now(),
                        
                        options: {
                            getSubcommand: () => 'menu',
                            getSubcommandGroup: () => null,
                            getString: () => null,
                            getInteger: () => null,
                            getBoolean: () => null,
                            getUser: () => null,
                            getMember: () => null,
                            getRole: () => null,
                            getChannel: () => null,
                            getNumber: () => null,
                            getAttachment: () => null,
                            data: [{
                                name: 'menu',
                                type: 1,
                                options: []
                            }]
                        },
                        
                        deferReply: async () => {},
                        
                        editReply: async (content) => {
                            if (editReplied) return;
                            editReplied = true;
                            if (content && content.content) {
                                const sent = await channel.send({ content: content.content });
                                setTimeout(() => sent.delete().catch(() => {}), 30000);
                            } else if (content && content.embeds) {
                                const sent = await channel.send({ embeds: content.embeds, components: content.components || [] });
                                setTimeout(() => sent.delete().catch(() => {}), 60000);
                            }
                        },
                        
                        reply: async (options) => {
                            if (replied) return;
                            replied = true;
                            if (options && options.content) {
                                const sent = await channel.send({ content: options.content });
                                setTimeout(() => sent.delete().catch(() => {}), 30000);
                            } else if (options && options.embeds) {
                                const sent = await channel.send({ embeds: options.embeds, components: options.components || [] });
                                setTimeout(() => sent.delete().catch(() => {}), 60000);
                            }
                        },
                        
                        followUp: async (options) => {
                            if (options && options.content) {
                                const sent = await channel.send({ content: options.content });
                                setTimeout(() => sent.delete().catch(() => {}), 30000);
                            } else if (options && options.embeds) {
                                const sent = await channel.send({ embeds: options.embeds });
                                setTimeout(() => sent.delete().catch(() => {}), 60000);
                            }
                        },
                        
                        deleteReply: async () => {},
                        deferUpdate: async () => {},
                        isRepliable: () => true,
                        inGuild: () => true,
                        isCommand: () => true,
                        isButton: () => false,
                        isSelectMenu: () => false,
                        isModalSubmit: () => false,
                        memberPermissions: channel.guild.members.me?.permissions,
                        locale: 'en-US',
                        guildLocale: 'en-US'
                    };
                    
                    Object.defineProperty(mockInteraction, 'replied', {
                        get: () => replied,
                        enumerable: true
                    });
                    
                    Object.defineProperty(mockInteraction, 'deferred', {
                        get: () => false,
                        enumerable: true
                    });
                    
                    await playlistCommand.run(client, mockInteraction);
                    await i.deferUpdate().catch(() => {});
                } else {
                    // playlist command not found, show error
                    const errCard = cardFromMessage(`${getEmoji('error') || '❌'} **Playlist command not found.**`, 'Playlist');
                    const sent = await channel.send({ components: [errCard], flags: MessageFlags.IsComponentsV2 });
                    setTimeout(() => sent.delete().catch(() => {}), 6000);
                    await i.deferUpdate().catch(() => {});
                }
            } catch (error) {
                console.error('Playlist button error:', error);
                const errCard = cardFromMessage(`${getEmoji('error') || '❌'} **Could not open playlist menu.**`, 'Playlist');
                const sent = await channel.send({ components: [errCard], flags: MessageFlags.IsComponentsV2 });
                setTimeout(() => sent.delete().catch(() => {}), 6000);
                await i.deferUpdate().catch(() => {});
            }
            return;
        }

        if (i.customId === 'player_play_favorites') {
            try {
                const userId = i.user.id;
                const serverId = channel.guild.id;
                const playlistName = PLAYER_FAVORITES_NAME;
                const existing = await playlistCollection.findOne({ name: playlistName, userId, serverId });

                if (!existing || !Array.isArray(existing.songs) || existing.songs.length === 0) {
                    const errorContainer = cardFromMessage('❌ **Your favorites list is empty.**', 'Favorites');
                    const sent = await channel.send({
                        components: [errorContainer],
                        flags: MessageFlags.IsComponentsV2
                    });
                    setTimeout(() => sent.delete().catch(() => {}), 5000);
                    await i.deferUpdate().catch(() => {});
                    return;
                }

                const { StringSelectMenuBuilder, ActionRowBuilder } = require('discord.js');
                
                const selectMenu = new StringSelectMenuBuilder()
                    .setCustomId('player_play_fav_song')
                    .setPlaceholder('Select a song from your favorites to play')
                    .addOptions(
                        existing.songs.slice(0, 25).map((song, idx) => {
                            const label = song.name || song.url || `Song #${idx + 1}`;
                            return {
                                label: label.length > 100 ? label.substring(0, 97) + '...' : label,
                                value: song.url || song.name
                            };
                        })
                    );

                const menuRow = new ActionRowBuilder().addComponents(selectMenu);
                const favoritesCard = cardFromMessage(`⭐ **Your Favorites**\nChoose a song from the dropdown menu to play it.`, 'Favorites Menu');
                
                const sentMessage = await channel.send({
                    components: [favoritesCard, menuRow],
                    flags: MessageFlags.IsComponentsV2
                });
                
                setTimeout(() => sentMessage.delete().catch(() => {}), 120000);
                await i.deferUpdate().catch(() => {});
            } catch (err) {
                console.error('Error opening favorites menu:', err);
                await i.deferUpdate().catch(() => {});
            }
            return;
        }

        if (i.customId === 'player_play_fav_song') {
            try {
                const query = i.values[0];
                if (!query) {
                    await i.deferUpdate().catch(() => {});
                    return;
                }

                const cleanQuery = normalizeSearchQuery(query);
                const resolve = await client.riffy.resolve({ query: cleanQuery, requester: i.user.username });
                if (!resolve || !Array.isArray(resolve.tracks) || !resolve.tracks.length) {
                    const errCard = cardFromMessage('❌ **Could not resolve the selected favorite song.**', 'Play Error');
                    const sent = await channel.send({ components: [errCard], flags: MessageFlags.IsComponentsV2 });
                    setTimeout(() => sent.delete().catch(() => {}), 5000);
                    await i.deferUpdate().catch(() => {});
                    return;
                }

                const track = resolve.tracks.shift();
                track.info.requester = i.user.username;
                player.queue.add(track);
                requesters.set(track.info.uri, i.user.username);

                if (!player.playing && !player.paused && player.queue.length > 0) {
                    player.play().catch(() => {});
                }

                const successCard = cardFromMessage(`✅ **Added from Favorites to Queue:**\n${track.info.title}`, 'Track Added');
                const sent = await channel.send({ components: [successCard], flags: MessageFlags.IsComponentsV2 });
                setTimeout(() => sent.delete().catch(() => {}), 5000);

                await refreshNowPlayingPanel(client, player.guildId);

                if (i.message) {
                    await i.message.delete().catch(() => {});
                } else {
                    await i.deferUpdate().catch(() => {});
                }
            } catch (err) {
                console.error('Error playing favorite song:', err);
                await i.deferUpdate().catch(() => {});
            }
            return;
        }

        if (i.customId === 'player_add_song') {
            await i.showModal(createAddSongModal()).catch(() => {});
            const modal = await i.awaitModalSubmit({
                filter: (m) => m.customId === 'player_modal_addsong' && m.user.id === i.user.id,
                time: 60000
            }).catch(() => null);
            if (modal) {
                await handlePlayerModalSubmit(client, modal, player, channel);
            }
            return;
        }

        if (i.customId === 'player_volume') {
            await i.showModal(createVolumeModal(player.volume)).catch(() => {});
            const modal = await i.awaitModalSubmit({
                filter: (m) => m.customId === 'player_modal_volume' && m.user.id === i.user.id,
                time: 60000
            }).catch(() => null);
            if (modal) {
                await handlePlayerModalSubmit(client, modal, player, channel);
            }
            return;
        }

        if (i.customId === 'player_save_song') {
            await i.showModal(createSaveSongModal()).catch(() => {});
            const modal = await i.awaitModalSubmit({
                filter: (m) => m.customId === 'player_modal_save_song' && m.user.id === i.user.id,
                time: 60000
            }).catch(() => null);
            if (modal) {
                await handlePlayerModalSubmit(client, modal, player, channel);
            }
            return;
        }

        const deferred = await safeDeferUpdate(i);
        if (!deferred && !i.deferred && !i.replied) return;

        await handleInteraction(client, i, player, channel);
    });

    collector.on('end', () => {
    });

    return collector;
}

async function handleInteraction(client, i, player, channel) {
    const lang = await getLang(channel.guildId).catch(() => ({ console: { player: {} } }));
    const t = lang.console?.player || {};
    
    switch (i.customId) {
        case 'loopToggle':
            toggleLoop(player, channel, t);
            await refreshNowPlayingPanel(client, player.guildId);
            break;
        case 'skipTrack':
            const guildId = player.guildId;
            clearProgressUpdates(guildId);
            player.stop();
            await sendEmbed(channel, t.controls?.skip || "⏭️ **Skipping to next song...**");
            break;
        case 'disableLoop':
            disableLoop(player, channel, t);
            break;
        case 'showLyrics':
            showLyrics(channel, player);
            break;
        case 'clearQueue':
            player.queue.clear();
            await sendEmbed(channel, t.controls?.queueCleared || "🗑️ **Queue has been cleared!**");
            break;
        case 'stopTrack':
            const nodeManager = getLavalinkManager();
            if (nodeManager) {
                await nodeManager.resetVoiceChannelStatus(player.guildId, player.voiceChannel);
            }
            player.stop();
            player.destroy();
            await cleanupTrackMessages(client, player).catch(() => {});
            await sendEmbed(channel, t.controls?.playbackStopped || '⏹️ **Playback has been stopped and player destroyed!**');
            break;
        case 'togglePlayback':
            try {
                if (!player || player.destroyed) {
                    await sendEmbed(channel, t.controls?.playerDestroyed || '❌ **Player is not available!**');
                    return;
                }
                if (player.paused) {
                    player.pause(false);
                    await sendEmbed(channel, t.controls?.playbackResumed || '▶️ **Playback has been resumed!**');
                } else {
                    player.pause(true);
                    await sendEmbed(channel, t.controls?.playbackPaused || '⏸️ **Playback has been paused!**');
                }
                await refreshNowPlayingPanel(client, player.guildId);
            } catch (error) {
                const langSync = getLangSync();
                console.warn(`${colors.cyan}[ PLAYER ]${colors.reset} ${colors.yellow}Toggle playback error: ${error.message}${colors.reset}`);
                await sendEmbed(channel, t.controls?.resumeError || '⚠️ **Failed to change playback state. Please try again.**');
            }
            break;
        case 'player_queue': {
            if (!player.queue.length) {
                await sendEmbed(channel, '💭 **Queue is empty.**');
                return;
            }

            const queueLang = lang.music?.queue || {};
            const queueButtonsLang = queueLang.buttons || {};
            const prevLabel = stripLeadingIcons(queueButtonsLang.previous || 'Previous');
            const nextLabel = stripLeadingIcons(queueButtonsLang.next || 'Next');

            const songsPerPage = 10;
            const totalSongs = player.queue.length;
            const totalPages = Math.ceil(totalSongs / songsPerPage) || 1;
            let currentPage = 1;

            const generateQueuePageContent = (page) => {
                const queueStartIndex = (page - 1) * songsPerPage;
                const queueEndIndex = Math.min(queueStartIndex + songsPerPage, totalSongs);
                const paginatedQueue = player.queue.slice(queueStartIndex, queueEndIndex);
                
                const preview = paginatedQueue.map((item, index) => {
                    const position = queueStartIndex + index + 1;
                    return `${position}. ${item.info?.title || 'Unknown title'}`;
                }).join('\n');
                
                return preview || 'No songs in this page.';
            };

            const queueEmoji = getEmoji('queue') || '📋';

            if (totalPages === 1) {
                const messageText = generateQueuePageContent(1);
                const cardTitle = `${queueEmoji} Upcoming Queue (${totalSongs} song${totalSongs === 1 ? '' : 's'})`;
                const container = buildPaleCard(cardTitle, [messageText]);
                const sentMessage = await channel.send({
                    components: [container],
                    flags: MessageFlags.IsComponentsV2
                });
                setTimeout(() => sentMessage.delete().catch(() => {}), 30000);
                break;
            }

            const buildMessagePayload = (page) => {
                const messageText = generateQueuePageContent(page);
                const cardTitle = `${queueEmoji} Upcoming Queue (Page ${page}/${totalPages}) (${totalSongs} song${totalSongs === 1 ? '' : 's'})`;
                const container = buildPaleCard(cardTitle, [messageText]);

                const prevButton = new ButtonBuilder()
                    .setCustomId(`pqueue_prev_${i.id}`)
                    .setLabel(prevLabel)
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === 1);
                const prevEmoji = getButtonEmoji('back');
                if (prevEmoji) prevButton.setEmoji(prevEmoji);

                const nextButton = new ButtonBuilder()
                    .setCustomId(`pqueue_next_${i.id}`)
                    .setLabel(nextLabel)
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === totalPages);
                const nextEmoji = getButtonEmoji('next');
                if (nextEmoji) nextButton.setEmoji(nextEmoji);

                const row = new ActionRowBuilder().addComponents(prevButton, nextButton);
                return {
                    components: [container, row],
                    flags: MessageFlags.IsComponentsV2
                };
            };

            const sentMessage = await channel.send(buildMessagePayload(currentPage));

            const collector = sentMessage.createMessageComponentCollector({
                filter: (clickInteraction) => 
                    clickInteraction.user.id === i.user.id && 
                    (clickInteraction.customId === `pqueue_prev_${i.id}` || clickInteraction.customId === `pqueue_next_${i.id}`),
                time: 60000
            });

            collector.on('collect', async (clickInteraction) => {
                await clickInteraction.deferUpdate().catch(() => {});
                if (clickInteraction.customId === `pqueue_prev_${i.id}` && currentPage > 1) {
                    currentPage--;
                } else if (clickInteraction.customId === `pqueue_next_${i.id}` && currentPage < totalPages) {
                    currentPage++;
                }

                await sentMessage.edit(buildMessagePayload(currentPage)).catch(() => {});
            });

            collector.on('end', async () => {
                await sentMessage.delete().catch(() => {});
            });

            break;
        }
        case 'player_shuffle': {
            if (player.queue.length < 2) {
                await sendEmbed(channel, '🔀 **Need at least 2 songs in queue to shuffle.**');
                return;
            }
            player.queue.shuffle();
            await refreshNowPlayingPanel(client, player.guildId);
            await sendEmbed(channel, '🔀 **Queue shuffled.**', false);
            break;
        }
        case 'volumeUp':
            adjustVolume(player, channel, 10, t);
            await refreshNowPlayingPanel(client, player.guildId);
            break;
        case 'volumeDown':
            adjustVolume(player, channel, -10, t);
            await refreshNowPlayingPanel(client, player.guildId);
            break;
    }
}

async function handlePlayerModalSubmit(client, modal, player, channel) {
    await modal.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});

    try {
        if (modal.customId === 'player_modal_addsong') {
            const query = modal.fields.getTextInputValue('query')?.trim();
            if (!query) {
                await modal.editReply({ content: '❌ Please provide a valid song name or URL.' }).catch(() => {});
                return;
            }

            const cleanQuery = normalizeSearchQuery(query);
            const resolve = await client.riffy.resolve({ query: cleanQuery, requester: modal.user.username });
            if (!resolve || !Array.isArray(resolve.tracks) || !resolve.tracks.length) {
                await modal.editReply({ content: '❌ No results found for that query.' }).catch(() => {});
                return;
            }

            let added = 0;
            if (resolve.loadType === 'playlist') {
                for (const track of resolve.tracks) {
                    track.info.requester = modal.user.username;
                    player.queue.add(track);
                    requesters.set(track.info.uri, modal.user.username);
                    added++;
                }
            } else {
                const track = resolve.tracks[0];
                track.info.requester = modal.user.username;
                player.queue.add(track);
                requesters.set(track.info.uri, modal.user.username);
                added = 1;
            }

            if (!player.playing && !player.paused && !player.current && player.queue.length > 0) {
                player.play().catch(() => {});
            }

            await refreshNowPlayingPanel(client, player.guildId);
            await modal.editReply({ content: `✅ Added ${added} track${added === 1 ? '' : 's'} to queue.` }).catch(() => {});
            return;
        }

        if (modal.customId === 'player_modal_volume') {
            const raw = modal.fields.getTextInputValue('volume')?.trim();
            const volume = Number.parseInt(raw, 10);
            if (Number.isNaN(volume) || volume < 1 || volume > 100) {
                await modal.editReply({ content: '❌ Volume must be a number between 1 and 100.' }).catch(() => {});
                return;
            }

            player.setVolume(volume);
            await refreshNowPlayingPanel(client, player.guildId);
            await modal.editReply({ content: `🔊 Volume set to ${volume}%.` }).catch(() => {});
            return;
        }

        if (modal.customId === 'player_modal_save_song') {
            const current = player.current?.info;
            if (!current?.uri) {
                await modal.editReply({ content: '❌ No active song to save.' }).catch(() => {});
                return;
            }

            const rawPlaylistName = modal.fields.getTextInputValue('playlistName')?.trim();
            const playlistName = rawPlaylistName?.slice(0, 80);
            if (!playlistName) {
                await modal.editReply({ content: '❌ Playlist name is required.' }).catch(() => {});
                return;
            }

            const userId = modal.user.id;
            const serverId = channel.guild.id;
            const serverName = channel.guild.name;

            const existing = await playlistCollection.findOne({ name: playlistName, userId, serverId });
            if (!existing) {
                await playlistCollection.insertOne({
                    name: playlistName,
                    songs: [],
                    isPrivate: false,
                    userId,
                    serverId,
                    serverName
                });
            }

            await playlistCollection.updateOne(
                { name: playlistName, userId, serverId },
                { $addToSet: { songs: { url: current.uri } } }
            );

            await modal.editReply({ content: `💾 Saved current song to playlist: ${playlistName}` }).catch(() => {});
        }
    } catch (error) {
        await modal.editReply({ content: '⚠️ Failed to process modal action.' }).catch(() => {});
    }
}

async function sendEmbed(channel, message, deleteAfter = true) {
    const container = cardFromMessage(message, 'Player Update');
    const sentMessage = await channel.send({ 
        components: [container],
        flags: MessageFlags.IsComponentsV2
    });
    if (deleteAfter) {
        setTimeout(() => sentMessage.delete().catch(console.error), config.embedTimeout * 1000);
    }
}

async function adjustVolume(player, channel, amount, t = {}) {
    const newVolume = Math.min(100, Math.max(10, player.volume + amount));
    if (newVolume === player.volume) {
        await sendEmbed(channel, amount > 0 ? (t.controls?.volumeMax || '🔊 **Volume is already at maximum!**') : (t.controls?.volumeMin || '🔉 **Volume is already at minimum!**'));
    } else {
        player.setVolume(newVolume);
        await sendEmbed(channel, (t.controls?.volumeChanged || '🔊 **Volume changed to {volume}%!**').replace('{volume}', newVolume));
    }
}

async function toggleLoop(player, channel, t = {}) {
    const currentMode = player.loop || "none";
    const nextMode = currentMode === "none"
        ? "track"
        : currentMode === "track"
            ? "queue"
            : "none";

    player.setLoop(nextMode);

    if (nextMode === "track") {
        await sendEmbed(channel, t.controls?.trackLoopActivated || "🔁 **Track loop is activated!**");
    } else if (nextMode === "queue") {
        await sendEmbed(channel, t.controls?.queueLoopActivated || "🔁 **Queue loop is activated!**");
    } else {
        await sendEmbed(channel, t.controls?.loopDisabled || "❌ **Loop is disabled!**");
    }
}

async function disableLoop(player, channel, t = {}) {
    player.setLoop("none");
    await sendEmbed(channel, t.controls?.loopDisabled || "❌ **Loop is disabled!**");
}

async function getLyrics(trackName, artistName, duration) {
    try {
        trackName = trackName
            .replace(/\b(Official|Audio|Video|Lyrics|Theme|Soundtrack|Music|Full Version|HD|4K|Visualizer|Radio Edit|Live|Remix|Mix|Extended|Cover|Parody|Performance|Version|Unplugged|Reupload)\b/gi, "") 
            .replace(/\s*[-_/|]\s*/g, " ") 
            .replace(/\s+/g, " ") 
            .trim();

        artistName = artistName
            .replace(/\b(Topic|VEVO|Records|Label|Productions|Entertainment|Ltd|Inc|Band|DJ|Composer|Performer)\b/gi, "")
            .replace(/ x /gi, " & ") 
            .replace(/\s+/g, " ") 
            .trim();

        if (!trackName || !artistName) {
            return null;
        }

        let response = await axios.get(`https://lrclib.net/api/get`, {
            params: { track_name: trackName, artist_name: artistName, duration },
            timeout: 5000
        });

        if (response.data && (response.data.syncedLyrics || response.data.plainLyrics)) {
            return response.data.syncedLyrics || response.data.plainLyrics;
        }

        response = await axios.get(`https://lrclib.net/api/get`, {
            params: { track_name: trackName, artist_name: artistName },
            timeout: 5000
        });

        if (response.data && (response.data.syncedLyrics || response.data.plainLyrics)) {
            return response.data.syncedLyrics || response.data.plainLyrics;
        }

        return null;
    } catch (error) {
        console.error("Lyrics fetch error:", error.response?.data?.message || error.message);
        return null;
    }
}

async function showLyrics(channel, player) {
    const lang = await getLang(player.guildId).catch(() => ({ console: { player: {} } }));
    const t = lang.console?.player || {};
    
    if (!player || !player.current || !player.current.info) {
        await sendEmbed(channel, t.lyrics?.noSongPlaying || "🚫 **No song is currently playing.**");
        return;
    }

    const track = player.current.info;
    const lyrics = await getLyrics(track.title, track.author, Math.floor(track.length / 1000));

    if (!lyrics) {
        await sendEmbed(channel, t.lyrics?.notFound || "❌ **Lyrics not found!**");
        return;
    }

    const lines = lyrics.split('\n').map(line => line.trim()).filter(Boolean);
    const songDuration = Math.floor(track.length / 1000); 

    const components = [];

    const lyricsContainer = new ContainerBuilder()
        .addTextDisplayComponents(
            (textDisplay) => textDisplay.setContent(
                `${(t.lyrics?.liveTitle || '## 🎵 Live Lyrics: {title}').replace('{title}', track.title)}\n\n` +
                `${t.lyrics?.syncing || '🔄 Syncing lyrics...'}`
            )
        );
    components.push(lyricsContainer);

    const stopButton = new ButtonBuilder()
        .setCustomId("stopLyrics")
        .setLabel(t.lyrics?.stopButton || "Stop Lyrics")
        .setStyle(ButtonStyle.Danger);

    const fullButton = new ButtonBuilder()
        .setCustomId("fullLyrics")
        .setLabel(t.lyrics?.fullButton || "Full Lyrics")
        .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(fullButton, stopButton);
    
    const message = await channel.send({ 
        components: [...components, row],
        flags: MessageFlags.IsComponentsV2
    });

    const guildId = player.guildId;
    if (!guildTrackMessages.has(guildId)) {
        guildTrackMessages.set(guildId, []);
    }
    guildTrackMessages.get(guildId).push({
        messageId: message.id,
        channelId: channel.id,
        type: 'lyrics'
    });

    const updateLyrics = async () => {
        const currentTime = Math.floor(player.position / 1000); 
        const totalLines = lines.length;
        const linesPerSecond = totalLines / songDuration; 
        const currentLineIndex = Math.floor(currentTime * linesPerSecond); 
        const start = Math.max(0, currentLineIndex - 3);
        const end = Math.min(totalLines, currentLineIndex + 3);
        const visibleLines = lines.slice(start, end).join('\n');

        const lang = await getLang(player.guildId).catch(() => ({ console: { player: {} } }));
        const t = lang.console?.player || {};
        const updatedContainer = new ContainerBuilder()
            .addTextDisplayComponents(
                (textDisplay) => textDisplay.setContent(
                    `${(t.lyrics?.liveTitle || '## 🎵 Live Lyrics: {title}').replace('{title}', track.title)}\n\n` +
                    visibleLines
                )
            );
        await message.edit({ 
            components: [updatedContainer, row],
            flags: MessageFlags.IsComponentsV2
        });
    };

    const interval = setInterval(updateLyrics, 3000);
    updateLyrics(); 

    const collector = message.createMessageComponentCollector({ time: 300000 });

    collector.on('collect', async i => {
        const deferred = await safeDeferUpdate(i);
        if (!deferred && !i.deferred && !i.replied) return;
    
        if (i.customId === "stopLyrics") {
            clearInterval(interval);
            await message.delete();
        } else if (i.customId === "fullLyrics") {
            clearInterval(interval);
            const lang = await getLang(player.guildId).catch(() => ({ console: { player: {} } }));
            const t = lang.console?.player || {};
            const fullLyricsContainer = new ContainerBuilder()
                .addTextDisplayComponents(
                    (textDisplay) => textDisplay.setContent(
                        `${(t.lyrics?.fullTitle || '## 🎵 Full Lyrics: {title}').replace('{title}', track.title)}\n\n` +
                        lines.join('\n')
                    )
                );
    
            const deleteButton = new ButtonBuilder()
                .setCustomId("deleteLyrics")
                .setLabel(t.lyrics?.deleteButton || "Delete")
                .setStyle(ButtonStyle.Danger);
    
            const deleteRow = new ActionRowBuilder().addComponents(deleteButton);
    
            await message.edit({ 
                components: [fullLyricsContainer, deleteRow],
                flags: MessageFlags.IsComponentsV2
            });
        } else if (i.customId === "deleteLyrics") {
            await message.delete();
        }
    });

    collector.on('end', () => {
        clearInterval(interval);
        message.delete().catch(() => {});
    });
}

function createPlaybackActionRow(disabled, paused = false, loopMode = 'none') {
    const playEmoji = getButtonEmoji('play') || '▶️';
    const pauseEmoji = getButtonEmoji('pause') || '⏸️';
    const skipEmoji = getButtonEmoji('next') || '⏭️';
    const volumeEmoji = getButtonEmoji('volume') || '🔊';
    const stopEmoji = getButtonEmoji('stop') || '⏹️';
    const playbackEmoji = paused ? playEmoji : pauseEmoji;
    const playbackLabel = paused ? 'Play' : 'Pause';
    const playbackStyle = paused ? ButtonStyle.Success : ButtonStyle.Secondary;

    return new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder().setCustomId("togglePlayback").setEmoji(playbackEmoji).setLabel(playbackLabel).setStyle(playbackStyle).setDisabled(disabled),
            new ButtonBuilder().setCustomId("skipTrack").setEmoji(skipEmoji).setLabel("Skip").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
            new ButtonBuilder().setCustomId('player_volume').setEmoji(volumeEmoji).setLabel('Volume').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
            new ButtonBuilder().setCustomId("stopTrack").setEmoji(stopEmoji).setLabel("Stop").setStyle(ButtonStyle.Danger).setDisabled(disabled)
        );
}

function createManageSongActionRow(disabled, loopMode = 'none') {
    const addEmoji = getButtonEmoji('playlist') || '📋';
    const shuffleEmoji = getButtonEmoji('servers') || '🌐';
    const queueEmoji = getButtonEmoji('queue') || '📄';
    const loopEmoji = getButtonEmoji('settings') || '🔁';
    const loopEnabled = loopMode !== 'none';

    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('player_playlist').setEmoji(addEmoji).setLabel('Playlist').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
        new ButtonBuilder().setCustomId('player_shuffle').setEmoji(shuffleEmoji).setLabel('Shuffle').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
        new ButtonBuilder().setCustomId('player_queue').setEmoji(queueEmoji).setLabel('Queue').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
        new ButtonBuilder().setCustomId('loopToggle').setEmoji(loopEmoji).setLabel('Loop').setStyle(loopEnabled ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(disabled)
    );
}

function buildPlayerActionRows(paused, loopMode) {
    return {
        playbackRow: createPlaybackActionRow(false, paused, loopMode),
        manageRow: createManageSongActionRow(false, loopMode)
    };
}

async function applyFilterByKey(player, selectedFilter) {
    switch (selectedFilter) {
        case 'karaoke':
            player.filters.setKaraoke(true);
            break;
        case 'timescale':
            player.filters.setTimescale(true, { speed: 1.2, pitch: 1.2 });
            break;
        case 'tremolo':
            player.filters.setTremolo(true, { frequency: 4, depth: 0.75 });
            break;
        case 'vibrato':
            player.filters.setVibrato(true, { frequency: 4, depth: 0.75 });
            break;
        case 'rotation':
            player.filters.setRotation(true, { rotationHz: 0.2 });
            break;
        case 'distortion':
            player.filters.setDistortion(true, { sinScale: 1, cosScale: 1 });
            break;
        case 'channelmix':
            player.filters.setChannelMix(true, { leftToLeft: 0.5, leftToRight: 0.5, rightToLeft: 0.5, rightToRight: 0.5 });
            break;
        case 'lowpass':
            player.filters.setLowPass(true, { smoothing: 0.5 });
            break;
        case 'bassboost':
            player.filters.setBassboost(true, { value: 3 });
            break;
        case 'nightcore':
            player.filters.setTimescale(true, { speed: 1.25, pitch: 1.25, rate: 1.0 });
            break;
        case 'daycore':
            player.filters.setTimescale(true, { speed: 1.0, pitch: 0.8, rate: 1.0 });
            break;
        default:
            return false;
    }
    return true;
}

function createProgressBar(current, total, length = 20) {
    const progress = Math.round((current / total) * length);
    const emptyProgress = length - progress;
    const progressText = '▓'.repeat(progress);
    const emptyProgressText = '░'.repeat(emptyProgress);
    
    const currentTime = formatDuration(current);
    const totalTime = formatDuration(total);
    
    return `\`${currentTime}\` ${progressText}${emptyProgressText} \`${totalTime}\``;
}

async function startProgressUpdates(client, guildId, message, player, track) {
    if (config.lowMemoryMode === true) {
        return null;
    }

    const boundMessageId = message.id;
    const boundChannelId = message.channelId;
    const boundTrackUri = track.info.uri;
    let updateCount = 0;
    const updateInterval = setInterval(async () => {
        try {
            const currentPlayer = client.riffy.players.get(guildId);
            if (!currentPlayer || currentPlayer !== player) {
                clearInterval(updateInterval);
                progressUpdateIntervals.delete(guildId);
                return;
            }
            
            const stored = nowPlayingMessages.get(guildId);
            if (!stored || stored.messageId !== boundMessageId || stored.channelId !== boundChannelId) {
                clearInterval(updateInterval);
                progressUpdateIntervals.delete(guildId);
                return;
            }

            if (!player || !player.current || player.current.info.uri !== boundTrackUri) {
                clearInterval(updateInterval);
                progressUpdateIntervals.delete(guildId);
                return;
            }

            const currentPosition = player.position;
            const totalDuration = track.info.length;
            const progress = Math.min(100, Math.round((currentPosition / totalDuration) * 100));

            const progressBar = createProgressBar(currentPosition, totalDuration);
            const lang = await getLang(guildId).catch(() => ({ console: { player: {} } }));
            const t = lang.console?.player || {};
            const requester = requesters.get(track.info.uri) || (t.trackInfo?.unknown || 'Unknown');
            const commandMentionMap = await getCommandMentionMap(client);
            const actionRows = buildPlayerActionRows(player.paused, player.loop, guildActiveFilter.get(guildId) || null);

            const channel = client.channels.cache.get(stored.channelId);
            if (channel) {
                const msg = await channel.messages.fetch(stored.messageId).catch(() => null);
                if (msg) {
                    try {
                        const canAttachFiles = channel.permissionsFor(channel.guild.members.me)?.has(PermissionsBitField.Flags.AttachFiles);
                        const cachedMedia = useGeneratedSongCard ? getTrackMediaCache(guildId, track.info.uri) : null;
                        let mediaUrl = null;
                        let mediaAttachment = null;
                        if (useGeneratedSongCard) {
                            if (cachedMedia?.cardBuffer && canAttachFiles) {
                                mediaAttachment = new AttachmentBuilder(cachedMedia.cardBuffer, { name: 'song-banner.png' });
                                mediaUrl = 'attachment://song-banner.png';
                            } else if (cachedMedia?.mediaUrl) {
                                mediaUrl = cachedMedia.mediaUrl;
                            }
                            if (!mediaUrl) {
                                mediaUrl = msg.attachments?.first()?.url || null;
                                if (mediaUrl) {
                                    setTrackMediaCache(guildId, track.info.uri, mediaUrl, cachedMedia?.cardBuffer || null);
                                }
                            }
                        }

                        const nowPlayingContainer = buildNowPlayingContainer(
                            track,
                            requester,
                            t,
                            config.showProgressBar !== false ? progressBar : null,
                            progress,
                            mediaUrl,
                            actionRows,
                            { paused: player.paused, loop: player.loop, currentPosition, queueLength: player.queue.length, commandMentionMap }
                        );
                        const editPayload = {
                            components: [nowPlayingContainer],
                            flags: MessageFlags.IsComponentsV2
                        };
                        if (mediaAttachment) {
                            editPayload.files = [mediaAttachment];
                        }
                        await msg.edit(editPayload);
                        updateCount++;
                    } catch (cardError) {
                        try {
                            let fallbackMediaUrl = null;
                            if (useGeneratedSongCard) {
                                const fallbackCached = getTrackMediaCache(guildId, track.info.uri);
                                fallbackMediaUrl = fallbackCached?.mediaUrl || msg.attachments?.first()?.url || null;
                            }
                            const fallbackContainer = buildNowPlayingContainer(
                                track,
                                requester,
                                t,
                                config.showProgressBar !== false ? progressBar : null,
                                progress,
                                fallbackMediaUrl,
                                actionRows,
                                { paused: player.paused, loop: player.loop, currentPosition, queueLength: player.queue.length, commandMentionMap }
                            );
                            await msg.edit({
                                components: [fallbackContainer],
                                flags: MessageFlags.IsComponentsV2
                            });
                        } catch (_) {
                            const bareContainer = buildNowPlayingContainer(
                                track,
                                requester,
                                t,
                                config.showProgressBar !== false ? progressBar : null,
                                progress,
                                null,
                                actionRows,
                                { paused: player.paused, loop: player.loop, currentPosition, queueLength: player.queue.length, commandMentionMap }
                            );
                            await msg.edit({
                                components: [bareContainer],
                                flags: MessageFlags.IsComponentsV2
                            }).catch(() => {});
                        }
                    }
                }
            }
        } catch (error) {
            clearInterval(updateInterval);
            progressUpdateIntervals.delete(guildId);
        }
    }, 15000);
    
    return updateInterval;
}

module.exports = { initializePlayer, cleanupTrackMessages, refreshNowPlayingPanel };
