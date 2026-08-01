const {
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags
} = require('discord.js');
const { spotifyProfileCollection } = require('../../mongodb.js');
const { safeDeferReply, safeDeferUpdate, buildPaleCard, sanitizeTitle } = require('../../utils/responseHandler.js');
const { getEmoji, getButtonEmoji } = require('../../UI/emojis/emoji');
const { checkVoiceChannel } = require('../../utils/voiceChannelCheck.js');
const { getLavalinkManager } = require('../../lavalink.js');
const {
    PUBLIC_ONLY_MODE,
    PRIVATE_AND_PUBLIC_MODE,
    buildSpotifyAuthUrl,
    getModeLabel,
    getSpotifyRedirectUri,
    getLinkedSpotifyProfile,
    getAuthorizedSpotifyProfile,
    fetchSpotifyMe,
    fetchCurrentUserPlaylists,
    fetchPlaylistTracksForUser
} = require('../../utils/spotifyOAuth.js');
const { extractSpotifyUserId, getSpotifyProfilePageName } = require('../../utils/spotify.js');

const data = new SlashCommandBuilder()
    .setName('spotify')
    .setDescription('Link Spotify and browse your playlists')
    .addSubcommand(subcommand =>
        subcommand
            .setName('link')
            .setDescription('Link your Spotify profile manually')
            .addStringOption(option =>
                option
                    .setName('profilelink')
                    .setDescription('Spotify profile link')
                    .setRequired(true)
            )
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName('profile')
            .setDescription('View your linked Spotify profile')
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName('playlists')
            .setDescription('Browse playlists from your linked Spotify account')
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName('unlink')
            .setDescription('Remove your linked Spotify account')
    );

const MAX_SPOTIFY_PLAYLISTS = 25;
const MAX_SPOTIFY_TRACKS = 100;

function formatNumber(value) {
    return new Intl.NumberFormat('en-US').format(Number(value) || 0);
}

function trimText(value, maxLength = 220, fallback = 'No description provided.') {
    const text = String(value || '').trim();
    if (!text) return fallback;
    return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
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

function getButtonEmojiValue(key) {
    return getButtonEmoji(key) || undefined;
}

function modeLabel(mode) {
    return getModeLabel(mode || PUBLIC_ONLY_MODE);
}

function hasOAuthLink(record) {
    return Boolean(record?.accessToken || record?.refreshToken);
}

function isManualLink(record) {
    return Boolean(record?.manualLink) && !hasOAuthLink(record);
}

function makeSpotifyId(action, ownerId, extra = '') {
    return ['spotify', action, ownerId, extra].filter(Boolean).join(':');
}

function parseSpotifyId(customId) {
    const [prefix, action, ownerId, ...rest] = String(customId || '').split(':');
    if (prefix !== 'spotify' || !action || !ownerId) return null;
    return { action, ownerId, rest };
}

async function denyForeignAccess(interaction) {
    if (interaction.replied || interaction.deferred) {
        await interaction.followUp({
            content: 'Only the user who opened this Spotify panel can use these controls.',
            flags: MessageFlags.Ephemeral
        }).catch(() => {});
        return;
    }

    await interaction.reply({
        content: 'Only the user who opened this Spotify panel can use these controls.',
        flags: MessageFlags.Ephemeral
    }).catch(() => {});
}

async function sendPanel(interaction, payload) {
    if (interaction.isButton?.() || interaction.isStringSelectMenu?.()) {
        if (interaction.deferred || interaction.replied) {
            return interaction.editReply(payload);
        }
        return interaction.update(payload);
    }

    if (interaction.deferred || interaction.replied) {
        return interaction.editReply(payload);
    }

    return interaction.reply(payload);
}

function buildSpotifyNeedsConfigCard() {
    return buildPaleCard(
        `${getEmoji('error')} Spotify Redirect Missing`,
        [
            'Spotify OAuth needs a valid `spotifyRedirectUri` in the bot config.',
            'Add your public callback URL in `config.js`, then make sure the same URL is allowed in your Spotify app dashboard.'
        ]
    );
}

function buildNotLinkedCard() {
    return buildPaleCard(
        `${getEmoji('music')} Spotify Link Required`,
        [
            `### ${getEmoji('link')} Link Spotify Profile\nSave your Spotify profile with \`/spotify link profilelink:<your profile link>\`.`,
            `This manual link keeps profile details and unlink controls easy to use.`
        ]
    );
}

function buildLinkPanelCard(record, mode, note = '') {
    const oauthReady = hasOAuthLink(record);
    const manualOnly = isManualLink(record);
    const linkedName = record?.displayName || null;
    const statusLine = linkedName
        ? `**Linked Account:** ${sanitizeTitle(linkedName, 'Spotify User')}\n**Current Mode:** ${modeLabel(record?.accessMode || mode)}\n**Authorization:** ${oauthReady ? 'Connected' : manualOnly ? 'Manual Link Only' : 'Reconnect Required'}`
        : `**Linked Account:** Not linked yet\n**Selected Mode:** ${modeLabel(mode)}`;

    return buildPaleCard(
        `${getEmoji('music')} Spotify Connect`,
        [
            `### ${getEmoji('settings')} Spotify Link Mode\n` +
            `Right now this bot is using the normal manual profile-link method.\n` +
            `Use \`/spotify link profilelink:<your profile link>\` to save your Spotify profile again any time.`,
            statusLine,
            note || `After linking, use the buttons below to open your Spotify profile or unlink the saved profile.`
        ]
    );
}

function buildProfileCard(record, note = '') {
    const authLine = hasOAuthLink(record) ? 'OAuth Connected' : isManualLink(record) ? 'Manual Link Only' : 'Not Authorized';
    return buildPaleCard(
        `${getEmoji('music')} Spotify Profile`,
        [
            `### ${getEmoji('music')} ${sanitizeTitle(record.displayName || record.spotifyUserId, 'Spotify User')}\n` +
            `**Spotify Username:** \`${record.displayName || record.spotifyUserId}\`\n` +
            `**Profile ID:** \`${record.spotifyUserId}\``,
            `**Followers:** ${formatNumber(record.followers)}\n` +
            `**Access Mode:** ${modeLabel(record.accessMode)}\n` +
            `**Authorization:** ${authLine}\n` +
            `**Account Tier:** ${sanitizeTitle(record.product || 'Unknown', 'Unknown')}\n` +
            `**Profile Link:** [Click Here](${record.profileUrl || `https://open.spotify.com/user/${record.spotifyUserId}`})`,
            note || `Use the buttons below to open your playlists, change access mode, or unlink Spotify.`
        ]
    );
}

function buildManualLinkSavedCard(record) {
    return buildPaleCard(
        `${getEmoji('music')} Spotify Profile Linked`,
        [
            `### ${getEmoji('music')} ${sanitizeTitle(record.displayName || record.spotifyUserId, 'Spotify Profile')}\nYour Spotify profile has been linked to the bot.`,
            `**Spotify Username:** \`${record.displayName || record.spotifyUserId}\`\n` +
            `**Profile ID:** \`${record.spotifyUserId}\`\n` +
            `**Followers:** ${formatNumber(record.followers || 0)}\n` +
            `**Profile Link:** [Click Here](${record.profileUrl || `https://open.spotify.com/user/${record.spotifyUserId}`})`,
            `Use \`/spotify profile\` to view the saved profile again.`
        ]
    );
}

function buildManualPlaylistsBlockedCard(record) {
    return buildPaleCard(
        `${getEmoji('playlist')} Spotify Playlists Unavailable`,
        [
            `### ${getEmoji('music')} ${sanitizeTitle(record.displayName || record.spotifyUserId, 'Spotify Profile')}\nThis Spotify account is linked with the normal manual method only.`,
            `Profile linking works, but playlist browsing still needs Spotify OAuth and a public callback URL on your host.`,
            `You can still use the buttons below for profile and unlink.`
        ]
    );
}

function buildNoPlaylistsCard(record) {
    const modeText = record?.accessMode === PRIVATE_AND_PUBLIC_MODE ? 'private or public' : 'public';
    return buildPaleCard(
        `${getEmoji('playlist')} No Playlists Found`,
        [
            `### ${getEmoji('music')} ${sanitizeTitle(record?.displayName || 'Spotify User', 'Spotify User')}\n` +
            `I could not find any ${modeText} playlists available for this linked Spotify account.`,
            `Try switching access mode with the settings button if you want the bot to ask for more playlist access.`
        ]
    );
}

function buildPlaylistBrowserCard(record, playlists, index, note = '') {
    const current = playlists[index];
    return buildPaleCard(
        `${getEmoji('playlist')} Spotify Playlists`,
        [
            `### ${getEmoji('music')} ${sanitizeTitle(record.displayName || record.spotifyUserId, 'Spotify User')}\n` +
            `**Access Mode:** ${modeLabel(record.accessMode)}\n` +
            `**Playlists Available:** ${formatNumber(playlists.length)}\n` +
            `**Selected:** ${index + 1}/${playlists.length}`,
            `### ${getEmoji('playlist')} ${sanitizeTitle(current.name, 'Playlist')}\n` +
            `${trimText(current.description, 240, 'No description provided.')}`,
            `**Tracks:** ${formatNumber(current.tracks)}\n` +
            `**Owner:** ${sanitizeTitle(current.owner, 'Spotify User')}\n` +
            `**Visibility:** ${current.public ? 'Public' : 'Private'}${current.collaborative ? ' • Collaborative' : ''}`,
            note || `Use the buttons below to browse playlists, queue one for playback, or open your Spotify profile.`
        ]
    );
}

function buildLinkRows(ownerId, mode, record) {
    const oauthReady = hasOAuthLink(record);
    const authUrl = buildSpotifyAuthUrl(ownerId, mode);
    const publicButton = new ButtonBuilder()
        .setCustomId(makeSpotifyId('mode', ownerId, PUBLIC_ONLY_MODE))
        .setLabel('Public Only')
        .setStyle(mode === PUBLIC_ONLY_MODE ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setEmoji(getButtonEmojiValue('playlist'))
        .setDisabled(true);

    const allButton = new ButtonBuilder()
        .setCustomId(makeSpotifyId('mode', ownerId, PRIVATE_AND_PUBLIC_MODE))
        .setLabel('Private + Public')
        .setStyle(mode === PRIVATE_AND_PUBLIC_MODE ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setEmoji(getButtonEmojiValue('settings'))
        .setDisabled(true);

    const connectButton = authUrl
        ? new ButtonBuilder()
            .setLabel('Connect Spotify')
            .setStyle(ButtonStyle.Link)
            .setURL(authUrl)
            .setEmoji(getButtonEmojiValue('link'))
            .setDisabled(true)
        : new ButtonBuilder()
            .setCustomId(makeSpotifyId('missingcfg', ownerId))
            .setLabel('Connect Spotify')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(getButtonEmojiValue('link'))
            .setDisabled(true);

    const profileButton = new ButtonBuilder()
        .setCustomId(makeSpotifyId('profile', ownerId))
        .setLabel('Profile')
        .setStyle(ButtonStyle.Primary)
        .setEmoji(getButtonEmojiValue('info'))
        .setDisabled(!oauthReady);

    const playlistsButton = new ButtonBuilder()
        .setCustomId(makeSpotifyId('playlists', ownerId, '0'))
        .setLabel('Playlists')
        .setStyle(ButtonStyle.Primary)
        .setEmoji(getButtonEmojiValue('queue'))
        .setDisabled(!oauthReady);

    const unlinkButton = new ButtonBuilder()
        .setCustomId(makeSpotifyId('unlink', ownerId))
        .setLabel('Unlink')
        .setStyle(ButtonStyle.Danger)
        .setEmoji(getButtonEmojiValue('stop'))
        .setDisabled(!record);

    return [
        new ActionRowBuilder().addComponents(publicButton, allButton, connectButton),
        new ActionRowBuilder().addComponents(profileButton, playlistsButton, unlinkButton)
    ];
}

function buildProfileRows(ownerId, record) {
    const playlistsButton = new ButtonBuilder()
        .setCustomId(makeSpotifyId('playlists', ownerId, '0'))
        .setLabel('Playlists')
        .setStyle(ButtonStyle.Primary)
        .setEmoji(getButtonEmojiValue('queue'));

    const settingsButton = new ButtonBuilder()
        .setCustomId(makeSpotifyId('settings', ownerId, record?.accessMode || PUBLIC_ONLY_MODE))
        .setLabel('Settings')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getButtonEmojiValue('settings'));

    const unlinkButton = new ButtonBuilder()
        .setCustomId(makeSpotifyId('unlink', ownerId))
        .setLabel('Unlink')
        .setStyle(ButtonStyle.Danger)
        .setEmoji(getButtonEmojiValue('stop'));

    const openButton = new ButtonBuilder()
        .setLabel('Open Spotify')
        .setStyle(ButtonStyle.Link)
        .setURL(record.profileUrl || `https://open.spotify.com/user/${record.spotifyUserId}`)
        .setEmoji(getButtonEmojiValue('link'));

    return [
        new ActionRowBuilder().addComponents(playlistsButton, settingsButton, unlinkButton),
        new ActionRowBuilder().addComponents(openButton)
    ];
}

function buildPlaylistRows(ownerId, playlists, index, record) {
    const current = playlists[index];
    const previousButton = new ButtonBuilder()
        .setCustomId(makeSpotifyId('playlists', ownerId, `${Math.max(0, index - 1)}`))
        .setLabel('Previous')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getButtonEmojiValue('back'))
        .setDisabled(index <= 0);

    const nextButton = new ButtonBuilder()
        .setCustomId(makeSpotifyId('playlists', ownerId, `${Math.min(playlists.length - 1, index + 1)}`))
        .setLabel('Next')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getButtonEmojiValue('next'))
        .setDisabled(index >= playlists.length - 1);

    const playNowButton = new ButtonBuilder()
        .setCustomId(makeSpotifyId('playnow', ownerId, `${index}`))
        .setLabel('Play Now')
        .setStyle(ButtonStyle.Success)
        .setEmoji(getButtonEmojiValue('play'));

    const addQueueButton = new ButtonBuilder()
        .setCustomId(makeSpotifyId('addqueue', ownerId, `${index}`))
        .setLabel('Add Queue')
        .setStyle(ButtonStyle.Primary)
        .setEmoji(getButtonEmojiValue('queue'));

    const refreshButton = new ButtonBuilder()
        .setCustomId(makeSpotifyId('refreshplaylists', ownerId, `${index}`))
        .setLabel('Refresh')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getButtonEmojiValue('search'));

    const profileButton = new ButtonBuilder()
        .setCustomId(makeSpotifyId('profile', ownerId))
        .setLabel('Profile')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getButtonEmojiValue('info'));

    const settingsButton = new ButtonBuilder()
        .setCustomId(makeSpotifyId('settings', ownerId, record?.accessMode || PUBLIC_ONLY_MODE))
        .setLabel('Settings')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getButtonEmojiValue('settings'));

    const unlinkButton = new ButtonBuilder()
        .setCustomId(makeSpotifyId('unlink', ownerId))
        .setLabel('Unlink')
        .setStyle(ButtonStyle.Danger)
        .setEmoji(getButtonEmojiValue('stop'));

    const openButton = new ButtonBuilder()
        .setLabel('Open Playlist')
        .setStyle(ButtonStyle.Link)
        .setURL(current.url || 'https://open.spotify.com/')
        .setEmoji(getButtonEmojiValue('link'));

    return [
        new ActionRowBuilder().addComponents(previousButton, nextButton, playNowButton, addQueueButton, refreshButton),
        new ActionRowBuilder().addComponents(profileButton, settingsButton, unlinkButton, openButton)
    ];
}

async function ensureSpotifyPlayer(client, interaction, mode) {
    const existingPlayer = client.riffy.players.get(interaction.guildId);
    const voiceCheck = await checkVoiceChannel(interaction, existingPlayer);
    if (!voiceCheck.allowed) {
        return { errorResponse: voiceCheck.response };
    }

    const nodeManager = getLavalinkManager();
    if (!nodeManager) {
        return {
            errorCard: buildPaleCard(`${getEmoji('error')} Spotify Playback Unavailable`, [
                'The Lavalink music manager is not available right now. Please try again later.'
            ])
        };
    }

    try {
        await nodeManager.ensureNodeAvailable();
    } catch (_) {
        return {
            errorCard: buildPaleCard(`${getEmoji('error')} No Music Nodes Available`, [
                'No Lavalink nodes are currently available, so I cannot load this Spotify playlist yet.'
            ])
        };
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
        } catch (_) {}
    }

    let player = client.riffy.players.get(interaction.guildId);
    if (!player || player.destroyed) {
        player = client.riffy.createConnection({
            guildId: interaction.guildId,
            voiceChannel: userVoiceChannel,
            textChannel: interaction.channelId,
            deaf: true
        });
    }

    if (mode === 'play') {
        player.queue.clear();
    }

    return { player, nodeManager };
}

async function queueSpotifyPlaylist(client, interaction, record, playlist, mode) {
    const loadingCard = buildPaleCard(
        `${getEmoji('music')} Loading Spotify Playlist`,
        [
            `### ${getEmoji('playlist')} ${sanitizeTitle(playlist.name, 'Spotify Playlist')}\nFetching tracks from your linked Spotify account.`
        ]
    );

    await interaction.editReply({
        components: [loadingCard],
        flags: MessageFlags.IsComponentsV2
    });

    const freshRecord = await getAuthorizedSpotifyProfile(record.userId);
    if (!freshRecord?.accessToken) {
        await interaction.editReply({
            components: [buildNotLinkedCard(), ...buildLinkRows(record.userId, record.accessMode || PUBLIC_ONLY_MODE, null)],
            flags: MessageFlags.IsComponentsV2
        });
        return;
    }

    let tracks;
    try {
        tracks = await fetchPlaylistTracksForUser(freshRecord.accessToken, playlist.id, { maxItems: MAX_SPOTIFY_TRACKS });
    } catch (error) {
        await interaction.editReply({
            components: [
                buildPaleCard(`${getEmoji('error')} Spotify Playlist Error`, [
                    `Spotify could not read this playlist with the current access mode.\nDetails: ${String(error?.response?.data?.error?.message || error?.message || 'Unknown Spotify error')}`
                ])
            ],
            flags: MessageFlags.IsComponentsV2
        });
        return;
    }

    if (!tracks.length) {
        await interaction.editReply({
            components: [buildPaleCard(`${getEmoji('warning')} Empty Playlist`, ['This Spotify playlist has no playable tracks for the bot right now.'])],
            flags: MessageFlags.IsComponentsV2
        });
        return;
    }

    const playerResult = await ensureSpotifyPlayer(client, interaction, mode);
    if (playerResult.errorResponse) {
        await interaction.editReply(playerResult.errorResponse);
        return;
    }

    if (playerResult.errorCard) {
        await interaction.editReply({
            components: [playerResult.errorCard],
            flags: MessageFlags.IsComponentsV2
        });
        return;
    }

    const { player, nodeManager } = playerResult;
    let added = 0;

    for (const entry of tracks) {
        const query = [entry.name, entry.artist].filter(Boolean).join(' - ');
        if (!query) continue;

        const searchQuery = cleanSearchQuery(query);
        let resolved;
        try {
            resolved = await client.riffy.resolve({ query: searchQuery, requester: interaction.user.username });
        } catch (resolveError) {
            const message = resolveError?.message || '';
            if (message.includes('fetch failed') || message.includes('No nodes are available') || resolveError?.cause?.code === 'ECONNREFUSED') {
                await nodeManager.reconnectNodesNow?.(5000).catch(() => {});
                await nodeManager.ensureNodeAvailable().catch(() => {});
                resolved = await client.riffy.resolve({ query: searchQuery, requester: interaction.user.username });
            } else {
                continue;
            }
        }

        const track = resolved?.tracks?.[0];
        if (!track) continue;

        track.info.requester = interaction.user.username;
        player.queue.add(track);
        added += 1;
    }

    if (!added) {
        await interaction.editReply({
            components: [buildPaleCard(`${getEmoji('error')} Playback Error`, ['None of the Spotify tracks could be resolved into playable songs right now.'])],
            flags: MessageFlags.IsComponentsV2
        });
        return;
    }

    if (mode === 'play') {
        if (player.playing || player.paused) {
            player.stop();
        } else if (player.queue.length > 0) {
            player.play().catch(() => {});
        }
    } else if (!player.playing && !player.paused && player.queue.length > 0) {
        player.play().catch(() => {});
    }

    await interaction.editReply({
        components: [
            buildPaleCard(`${getEmoji('success')} Spotify Playlist Ready`, [
                `### ${getEmoji('playlist')} ${sanitizeTitle(playlist.name, 'Spotify Playlist')}\n${mode === 'play' ? 'Started playback from your Spotify playlist.' : 'Added your Spotify playlist to the queue.'}`,
                `**Tracks queued:** ${formatNumber(added)}\n**Profile Mode:** ${modeLabel(record.accessMode)}\n**Spotify Link:** [Open Playlist](${playlist.url || 'https://open.spotify.com/'})`
            ])
        ],
        flags: MessageFlags.IsComponentsV2
    });
}

async function showLinkPanel(interaction, ownerId, mode = PUBLIC_ONLY_MODE, note = '') {
    const record = await getLinkedSpotifyProfile(ownerId);
    return sendPanel(interaction, {
        components: [buildLinkPanelCard(record, mode, note), ...buildLinkRows(ownerId, mode, record)],
        flags: MessageFlags.IsComponentsV2
    });
}

async function showProfilePanel(interaction, ownerId, note = '') {
    let record = await getAuthorizedSpotifyProfile(ownerId);
    if (!record?.accessToken) {
        record = await getLinkedSpotifyProfile(ownerId);
    }
    if (!record) {
        return showLinkPanel(interaction, ownerId, PUBLIC_ONLY_MODE, 'Spotify is not linked yet. Use `/spotify link profilelink:<your profile link>` first.');
    }

    try {
        const freshProfile = await fetchSpotifyMe(record.accessToken);
        record = {
            ...record,
            ...freshProfile
        };
        await spotifyProfileCollection?.updateOne(
            { userId: ownerId },
            {
                $set: {
                    spotifyUserId: freshProfile.spotifyUserId,
                    displayName: freshProfile.displayName,
                    followers: freshProfile.followers,
                    avatar: freshProfile.avatar,
                    profileUrl: freshProfile.profileUrl,
                    product: freshProfile.product,
                    updatedAt: new Date()
                }
            }
        );
    } catch (_) {}

    return sendPanel(interaction, {
        components: [buildProfileCard(record, note), ...buildProfileRows(ownerId, record)],
        flags: MessageFlags.IsComponentsV2
    });
}

async function showPlaylistsPanel(interaction, ownerId, requestedIndex = 0, note = '') {
    const record = await getAuthorizedSpotifyProfile(ownerId);
    if (!record?.accessToken) {
        const linked = await getLinkedSpotifyProfile(ownerId);
        if (linked) {
            return sendPanel(interaction, {
                components: [buildManualPlaylistsBlockedCard(linked), ...buildProfileRows(ownerId, linked)],
                flags: MessageFlags.IsComponentsV2
            });
        }
        return showLinkPanel(interaction, ownerId, PUBLIC_ONLY_MODE, 'Spotify is not linked yet. Use `/spotify link profilelink:<your profile link>` first.');
    }

    let playlists;
    try {
        playlists = await fetchCurrentUserPlaylists(record.accessToken, record.accessMode || PUBLIC_ONLY_MODE, {
            limit: 25,
            maxItems: MAX_SPOTIFY_PLAYLISTS
        });
    } catch (error) {
        return sendPanel(interaction, {
            components: [
                buildPaleCard(`${getEmoji('error')} Spotify Playlist Error`, [
                    `Spotify could not load playlists for this account.\nDetails: ${String(error?.response?.data?.error?.message || error?.message || 'Unknown Spotify error')}`
                ]),
                ...buildProfileRows(ownerId, record)
            ],
            flags: MessageFlags.IsComponentsV2
        });
    }

    if (!playlists.length) {
        return sendPanel(interaction, {
            components: [buildNoPlaylistsCard(record), ...buildProfileRows(ownerId, record)],
            flags: MessageFlags.IsComponentsV2
        });
    }

    const index = Math.min(Math.max(Number.parseInt(`${requestedIndex || 0}`, 10) || 0, 0), playlists.length - 1);
    return sendPanel(interaction, {
        components: [buildPlaylistBrowserCard(record, playlists, index, note), ...buildPlaylistRows(ownerId, playlists, index, record)],
        flags: MessageFlags.IsComponentsV2
    });
}

async function unlinkSpotify(interaction, ownerId, note = '') {
    const record = await getLinkedSpotifyProfile(ownerId);
    if (!record) {
        return showLinkPanel(interaction, ownerId, PUBLIC_ONLY_MODE, 'There is no Spotify account linked to this Discord user right now.');
    }

    await spotifyProfileCollection?.deleteOne({ userId: ownerId });
    return sendPanel(interaction, {
        components: [
            buildPaleCard(`${getEmoji('warning')} Spotify Unlinked`, [
                `### ${getEmoji('warning')} ${sanitizeTitle(record.displayName || record.spotifyUserId, 'Spotify User')}\nYour Spotify account has been unlinked from the bot.`,
                note || 'Run `/spotify link` any time if you want to connect Spotify again.'
            ]),
            ...buildLinkRows(ownerId, PUBLIC_ONLY_MODE, null)
        ],
        flags: MessageFlags.IsComponentsV2
    });
}

module.exports = {
    data,
    run: async (_client, interaction) => {
        const deferred = await safeDeferReply(interaction);
        if (!deferred && !interaction.deferred && !interaction.replied) return;

        if (!spotifyProfileCollection) {
            await interaction.editReply({
                components: [buildPaleCard(`${getEmoji('error')} Database Required`, ['Spotify account linking needs MongoDB. Add your MongoDB URI first, then restart the bot.'])],
                flags: MessageFlags.IsComponentsV2
            });
            return;
        }

        const subcommand = interaction.options.getSubcommand();
        if (subcommand === 'link') {
            const rawProfileLink = interaction.options.getString('profilelink', true)?.trim();
            const spotifyUserId = await extractSpotifyUserId(rawProfileLink);
            if (!spotifyUserId) {
                await interaction.editReply({
                    components: [buildPaleCard(`${getEmoji('error')} Invalid Spotify Profile`, ['Please provide a valid Spotify profile link. Example: `https://open.spotify.com/user/spotify`'])],
                    flags: MessageFlags.IsComponentsV2
                });
                return;
            }

            const displayName = await getSpotifyProfilePageName(rawProfileLink) || spotifyUserId;
            const record = {
                userId: interaction.user.id,
                spotifyUserId,
                displayName,
                profileUrl: rawProfileLink,
                followers: 0,
                accessMode: PUBLIC_ONLY_MODE,
                product: 'Unknown',
                manualLink: true,
                linkedAt: new Date(),
                updatedAt: new Date()
            };

            await spotifyProfileCollection?.updateOne(
                { userId: interaction.user.id },
                {
                    $set: {
                        ...record,
                        accessToken: null,
                        refreshToken: null,
                        tokenType: null,
                        expiresAt: null,
                        scopes: []
                    }
                },
                { upsert: true }
            );

            await interaction.editReply({
                components: [buildManualLinkSavedCard(record), ...buildProfileRows(interaction.user.id, record)],
                flags: MessageFlags.IsComponentsV2
            });
            return;
        }

        if (subcommand === 'profile') {
            await showProfilePanel(interaction, interaction.user.id);
            return;
        }

        if (subcommand === 'playlists') {
            await showPlaylistsPanel(interaction, interaction.user.id, 0);
            return;
        }

        if (subcommand === 'unlink') {
            await unlinkSpotify(interaction, interaction.user.id);
        }
    },
    helpers: {
        handleComponent: async (client, interaction) => {
            const parsed = parseSpotifyId(interaction.customId);
            if (!parsed) return;

            if (interaction.user.id !== parsed.ownerId) {
                await denyForeignAccess(interaction);
                return;
            }

            if (parsed.action === 'missingcfg') {
                await interaction.reply({
                    content: 'Spotify OAuth is not configured yet. Add `spotifyRedirectUri` in `config.js` and your Spotify app dashboard first.',
                    flags: MessageFlags.Ephemeral
                }).catch(() => {});
                return;
            }

            await safeDeferUpdate(interaction);

            if (parsed.action === 'mode') {
                const mode = parsed.rest[0] === PRIVATE_AND_PUBLIC_MODE ? PRIVATE_AND_PUBLIC_MODE : PUBLIC_ONLY_MODE;
                await showLinkPanel(interaction, parsed.ownerId, mode, `Selected access mode: **${modeLabel(mode)}**. Press **Connect Spotify** to continue.`);
                return;
            }

            if (parsed.action === 'settings') {
                const mode = parsed.rest[0] === PRIVATE_AND_PUBLIC_MODE ? PRIVATE_AND_PUBLIC_MODE : PUBLIC_ONLY_MODE;
                await showLinkPanel(interaction, parsed.ownerId, mode, 'Change the access mode here, then reconnect Spotify to apply it.');
                return;
            }

            if (parsed.action === 'profile') {
                await showProfilePanel(interaction, parsed.ownerId);
                return;
            }

            if (parsed.action === 'playlists') {
                const index = Number.parseInt(parsed.rest[0] || '0', 10) || 0;
                await showPlaylistsPanel(interaction, parsed.ownerId, index);
                return;
            }

            if (parsed.action === 'refreshplaylists') {
                const index = Number.parseInt(parsed.rest[0] || '0', 10) || 0;
                await showPlaylistsPanel(interaction, parsed.ownerId, index, 'Spotify playlists refreshed from your linked account.');
                return;
            }

            if (parsed.action === 'unlink') {
                await unlinkSpotify(interaction, parsed.ownerId);
                return;
            }

            if (parsed.action === 'playnow' || parsed.action === 'addqueue') {
                const index = Number.parseInt(parsed.rest[0] || '0', 10) || 0;
                const record = await getAuthorizedSpotifyProfile(parsed.ownerId);
                if (!record?.accessToken) {
                    await showLinkPanel(interaction, parsed.ownerId, PUBLIC_ONLY_MODE, 'Spotify link expired. Connect Spotify again to continue.');
                    return;
                }

                let playlists;
                try {
                    playlists = await fetchCurrentUserPlaylists(record.accessToken, record.accessMode || PUBLIC_ONLY_MODE, {
                        limit: 25,
                        maxItems: MAX_SPOTIFY_PLAYLISTS
                    });
                } catch (error) {
                    await interaction.editReply({
                        components: [buildPaleCard(`${getEmoji('error')} Spotify Playlist Error`, [`Spotify could not load playlists right now.\nDetails: ${String(error?.response?.data?.error?.message || error?.message || 'Unknown Spotify error')}`])],
                        flags: MessageFlags.IsComponentsV2
                    });
                    return;
                }

                if (!playlists.length) {
                    await interaction.editReply({
                        components: [buildNoPlaylistsCard(record), ...buildProfileRows(parsed.ownerId, record)],
                        flags: MessageFlags.IsComponentsV2
                    });
                    return;
                }

                const playlist = playlists[Math.min(Math.max(index, 0), playlists.length - 1)];
                await queueSpotifyPlaylist(client, interaction, record, playlist, parsed.action === 'playnow' ? 'play' : 'queue');
            }
        }
    }
};
