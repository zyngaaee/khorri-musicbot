const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } = require('discord.js');
const { ObjectId } = require('mongodb');
const { playlistCollection } = require('../../mongodb.js');
const { getEmoji, getButtonEmoji } = require('../../UI/emojis/emoji');
const { sendErrorResponse, sendSuccessResponse, handleCommandError, safeDeferReply, safeDeferUpdate, buildPaleCard, sanitizeTitle } = require('../../utils/responseHandler.js');
const { getLang } = require('../../utils/languageLoader.js');
const { checkVoiceChannel } = require('../../utils/voiceChannelCheck.js');
const { getLavalinkManager } = require('../../lavalink.js');

const data = new SlashCommandBuilder()
  .setName('playlist')
  .setDescription('Open the playlist menu')
  .addSubcommand(sub =>
    sub.setName('menu')
      .setDescription('Open the playlist menu')
  );

const PLAYLISTS_PER_PAGE = 10;
const SONGS_PER_PAGE = 10;
const PLAYLIST_FILTERS = [
  { key: 'num', labelKey: 'filterNumbersLabel', fallback: '0-9' },
  { key: 'af', labelKey: 'filterAFLabel', fallback: 'A-F' },
  { key: 'gl', labelKey: 'filterGLLabel', fallback: 'G-L' },
  { key: 'mr', labelKey: 'filterMRLabel', fallback: 'M-R' },
  { key: 'sz', labelKey: 'filterSZLabel', fallback: 'S-Z' }
];
const URL_REGEX = /^(https?:\/\/[^\s$.?#].[^\s]*)$/i;
async function waitForPlayerConnection(player, timeoutMs = 7000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (player?.connected) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}
function getEmojiForButton(key) {
  const emoji = getButtonEmoji(key);
  if (!emoji) return undefined;
  return emoji;
}

function truncateLabel(value, maxLength = 80) {
  if (!value) return 'Unknown';
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function toSafePage(pageValue, fallback = 1) {
  const page = Number.parseInt(`${pageValue || ''}`, 10);
  if (Number.isNaN(page) || page < 1) return fallback;
  return page;
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

function matchesPlaylistFilter(name, filterKey) {
  if (!name || filterKey === 'all') return true;

  const first = String(name).trim().charAt(0).toUpperCase();
  if (!first) return false;

  if (filterKey === 'num') {
    return /[0-9]/.test(first);
  }

  if (filterKey === 'af') {
    return first >= 'A' && first <= 'F';
  }

  if (filterKey === 'gl') {
    return first >= 'G' && first <= 'L';
  }

  if (filterKey === 'mr') {
    return first >= 'M' && first <= 'R';
  }

  if (filterKey === 'sz') {
    return first >= 'S' && first <= 'Z';
  }

  return true;
}

function filterPlaylists(playlists, filterKey) {
  if (filterKey === 'all') return playlists;
  return playlists.filter((playlist) => matchesPlaylistFilter(playlist?.name, filterKey));
}

function paginate(items, page, pageSize) {
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const currentPage = Math.min(Math.max(toSafePage(page), 1), totalPages);
  const startIndex = (currentPage - 1) * pageSize;
  const chunk = items.slice(startIndex, startIndex + pageSize);

  return {
    items: chunk,
    page: currentPage,
    totalPages,
    totalItems,
    startIndex
  };
}

function getPlaylistTexts(lang) {
  const playlistLang = lang?.playlist?.playlist || {};
  return {
    title: playlistLang.title || 'Playlist Menu',
    description: playlistLang.description || 'Manage your playlists with the buttons below.',
    createLabel: playlistLang.createLabel || 'Create Playlist',
    createDescription: playlistLang.createDescription || 'Open a name modal and save a new playlist.',
    addLabel: playlistLang.addLabel || 'Add Songs',
    addDescription: playlistLang.addDescription || 'Add comma-separated songs or URLs to one of your playlists.',
    playLabel: playlistLang.playLabel || playlistLang.viewLabel || 'Play Playlist',
    playDescription: playlistLang.playDescription || playlistLang.viewDescription || 'Play a saved playlist instantly.',
    viewSongsLabel: playlistLang.viewSongsLabel || 'View Playlist Songs',
    viewSongsDescription: playlistLang.viewSongsDescription || 'Browse songs inside one of your playlists.',
    deleteLabel: playlistLang.deleteLabel || 'Delete Playlist',
    deleteDescription: playlistLang.deleteDescription || 'Remove a playlist from your personal library.',
    backLabel: playlistLang.backLabel || 'Back to Menu',
    addHeading: playlistLang.addHeading || 'Add Songs',
    playHeading: playlistLang.playHeading || playlistLang.viewHeading || 'Play Playlist',
    songsHeading: playlistLang.songsHeading || 'View Playlist Songs',
    deleteHeading: playlistLang.deleteHeading || 'Delete Playlists',
    deleteNote: playlistLang.deleteNote || 'Click a playlist button to delete it permanently.',
    noPlaylistsTitle: playlistLang.noPlaylistsTitle || '## ❌ No playlists found',
    noPlaylistsMessage: playlistLang.noPlaylistsMessage || "You don't have any playlists yet. Create one first with **Create Playlist**.",
    noPlaylistsNote: playlistLang.noPlaylistsNote || 'Use the Create Playlist button to get started.',
    addPrompt: playlistLang.addPrompt || 'Choose a playlist to add songs into.',
    playPrompt: playlistLang.playPrompt || 'Choose a playlist to play.',
    songsPrompt: playlistLang.songsPrompt || 'Choose a playlist to view its songs.',
    deletePrompt: playlistLang.deletePrompt || 'Choose a playlist to delete.',
    listStatus: playlistLang.listStatus || 'Showing {shown} of {filtered} filtered playlists ({total} total).',
    pageStatus: playlistLang.pageStatus || 'Page {current}/{total}',
    noFilteredPlaylists: playlistLang.noFilteredPlaylists || 'No playlists match this filter. Try another range or choose All.',
    allFilterLabel: playlistLang.allFilterLabel || 'All',
    filterNumbersLabel: playlistLang.filterNumbersLabel || '0-9',
    filterAFLabel: playlistLang.filterAFLabel || 'A-F',
    filterGLLabel: playlistLang.filterGLLabel || 'G-L',
    filterMRLabel: playlistLang.filterMRLabel || 'M-R',
    filterSZLabel: playlistLang.filterSZLabel || 'S-Z',
    processingTitle: playlistLang.processingTitle || 'Processing Playlist',
    processingMessage: playlistLang.processingMessage || 'Preparing playlist **{name}** and resolving tracks. Please wait...',
    createModalTitle: playlistLang.createModalTitle || 'Create Playlist',
    playlistNameLabel: playlistLang.playlistNameLabel || 'Playlist Name',
    playlistNamePlaceholder: playlistLang.playlistNamePlaceholder || 'My favorite tracks',
    addSongsModalTitle: playlistLang.addSongsModalTitle || 'Add Songs to {name}',
    songsInputLabel: playlistLang.songsInputLabel || 'Songs or URLs (comma separated)',
    songsInputPlaceholder: playlistLang.songsInputPlaceholder || 'track 1, track 2, https://youtu.be/xyz',
    invalidPlaylistNameTitle: playlistLang.invalidPlaylistNameTitle || '## ❌ Invalid playlist name',
    invalidPlaylistNameMessage: playlistLang.invalidPlaylistNameMessage || 'Please enter a valid playlist name.',
    playlistExistsTitle: playlistLang.playlistExistsTitle || '## ❌ Playlist already exists',
    playlistExistsMessage: playlistLang.playlistExistsMessage || 'A playlist called **"{name}"** already exists in your library.',
    playlistCreatedTitle: playlistLang.playlistCreatedTitle || '## ✅ Playlist Created',
    playlistCreatedMessage: playlistLang.playlistCreatedMessage || 'Your playlist **"{name}"** has been created successfully.',
    noSongsFoundTitle: playlistLang.noSongsFoundTitle || '## ❌ No songs found',
    noSongsFoundMessage: playlistLang.noSongsFoundMessage || 'Please add one or more song names or URLs separated by commas.',
    playlistNotFoundTitle: playlistLang.playlistNotFoundTitle || '## ❌ Playlist not found',
    playlistNotFoundMessage: playlistLang.playlistNotFoundMessage || 'That playlist could not be found or may have been deleted.',
    songsAddedTitle: playlistLang.songsAddedTitle || '## ✅ Songs Added',
    songsAddedMessage: playlistLang.songsAddedMessage || 'Added **{count}** song(s) to **"{name}"**.',
    emptyPlaylistTitle: playlistLang.emptyPlaylistTitle || '## ❌ Empty Playlist',
    emptyPlaylistMessage: playlistLang.emptyPlaylistMessage || 'The playlist **"{name}"** has no songs yet. Add songs first.',
    songsViewTitle: playlistLang.songsViewTitle || 'Playlist Songs',
    songsViewStatus: playlistLang.songsViewStatus || 'Showing songs {start}-{end} of {total}.',
    songsEmptyTitle: playlistLang.songsEmptyTitle || '## ❌ No songs in playlist',
    songsEmptyMessage: playlistLang.songsEmptyMessage || 'The playlist **"{name}"** has no songs yet.',
    viewOnlyNote: playlistLang.viewOnlyNote || 'You can view this playlist, but only the owner can edit songs.',
    removeSongsLabel: playlistLang.removeSongsLabel || 'Remove Songs',
    removeSongsModalTitle: playlistLang.removeSongsModalTitle || 'Remove Songs by Index',
    removeSongsInputLabel: playlistLang.removeSongsInputLabel || 'Song Indexes (comma separated)',
    removeSongsInputPlaceholder: playlistLang.removeSongsInputPlaceholder || '1, 3, 5',
    removeSongsInvalidTitle: playlistLang.removeSongsInvalidTitle || '## ❌ Invalid indexes',
    removeSongsInvalidMessage: playlistLang.removeSongsInvalidMessage || 'Enter one or more valid song indexes separated by commas.',
    removeSongsOutOfRangeTitle: playlistLang.removeSongsOutOfRangeTitle || '## ❌ Index out of range',
    removeSongsOutOfRangeMessage: playlistLang.removeSongsOutOfRangeMessage || 'None of the provided indexes match songs in this playlist.',
    removeSongsDeniedTitle: playlistLang.removeSongsDeniedTitle || '## ❌ Access denied',
    removeSongsDeniedMessage: playlistLang.removeSongsDeniedMessage || 'You can only remove songs from your own playlists.',
    removeSongsSuccessTitle: playlistLang.removeSongsSuccessTitle || '## ✅ Songs Removed',
    removeSongsSuccessMessage: playlistLang.removeSongsSuccessMessage || 'Removed **{count}** song(s) from **"{name}"**.',
    backToPlaylistsLabel: playlistLang.backToPlaylistsLabel || 'Back to Playlists',
    voiceChannelErrorTitle: playlistLang.voiceChannelErrorTitle || '## ❌ Voice channel error',
    voiceChannelErrorMessage: playlistLang.voiceChannelErrorMessage || 'Unable to join your voice channel.',
    lavalinkUnavailableTitle: playlistLang.lavalinkUnavailableTitle || '## ❌ Lavalink unavailable',
    lavalinkUnavailableMessage: playlistLang.lavalinkUnavailableMessage || 'The music manager is not available right now. Please try again later.',
    nodesUnavailableTitle: playlistLang.nodesUnavailableTitle || '## ❌ Lavalink unavailable',
    nodesUnavailableMessage: playlistLang.nodesUnavailableMessage || 'No nodes are available to play music right now. Please try again later.',
    playbackErrorTitle: playlistLang.playbackErrorTitle || '## ❌ Playback error',
    playbackErrorMessage: playlistLang.playbackErrorMessage || 'One or more songs in the playlist could not be resolved. Please check the playlist contents.',
    playingPlaylistTitle: playlistLang.playingPlaylistTitle || 'Playing Playlist',
    playingPlaylistLineStatus: playlistLang.playingPlaylistLineStatus || 'Added **{count}** song(s) to the queue.'
  };
}

function buildMenuCard(lang) {
  const text = getPlaylistTexts(lang);
  return buildPaleCard(
    `${getEmoji('playlist')} ${text.title}`,
    [
      text.description,
      `**${getEmoji('play')} ${text.createLabel}** — ${text.createDescription}`,
      `**${getEmoji('music')} ${text.addLabel}** — ${text.addDescription}`,
      `**${getEmoji('queue')} ${text.playLabel}** — ${text.playDescription}`,
      `**${getEmoji('folder')} ${text.viewSongsLabel}** — ${text.viewSongsDescription}`,
      `**${getEmoji('stop')} ${text.deleteLabel}** — ${text.deleteDescription}`
    ]
  );
}

function buildMainMenuRows(text) {
  const createButton = new ButtonBuilder()
    .setCustomId('playlist_menu_create')
    .setLabel(text.createLabel)
    .setStyle(ButtonStyle.Success)
    .setEmoji(getEmojiForButton('playlist'));

  const addButton = new ButtonBuilder()
    .setCustomId('playlist_menu_add')
    .setLabel(text.addLabel)
    .setStyle(ButtonStyle.Primary)
    .setEmoji(getEmojiForButton('music'));

  const playButton = new ButtonBuilder()
    .setCustomId('playlist_menu_play')
    .setLabel(text.playLabel)
    .setStyle(ButtonStyle.Secondary)
    .setEmoji(getEmojiForButton('queue') || getEmojiForButton('play'));

  const songsButton = new ButtonBuilder()
    .setCustomId('playlist_menu_songs')
    .setLabel(text.viewSongsLabel)
    .setStyle(ButtonStyle.Secondary)
    .setEmoji(getEmojiForButton('folder'));

  const deleteButton = new ButtonBuilder()
    .setCustomId('playlist_menu_delete')
    .setLabel(text.deleteLabel)
    .setStyle(ButtonStyle.Danger)
    .setEmoji(getEmojiForButton('stop'));

  return [new ActionRowBuilder().addComponents(createButton, addButton, playButton, songsButton, deleteButton)];
}

function buildBackButtonRow(text) {
  const backButton = new ButtonBuilder()
    .setCustomId('playlist_menu_back')
    .setLabel(text.backLabel)
    .setStyle(ButtonStyle.Secondary)
    .setEmoji(getEmojiForButton('back'));

  return new ActionRowBuilder().addComponents(backButton);
}

function buildPlaylistButtonRows(playlists, mode, filterKey, page) {
  const buttons = playlists.map(playlist =>
    new ButtonBuilder()
      .setCustomId(`playlist_pick_${mode}_${playlist._id.toString()}_${filterKey}_${page}`)
      .setLabel(truncateLabel(playlist.name, 50))
      .setStyle(ButtonStyle.Primary)
      .setEmoji(getEmojiForButton('playlist'))
  );

  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
  }

  return rows;
}

function buildFilterRow(mode, activeFilter, text) {
  const filterButtons = PLAYLIST_FILTERS.map((filterDef) => {
    const isActive = activeFilter === filterDef.key;
    return new ButtonBuilder()
      .setCustomId(`playlist_filter_${mode}_${filterDef.key}`)
      .setLabel(text[filterDef.labelKey] || filterDef.fallback)
      .setStyle(isActive ? ButtonStyle.Primary : ButtonStyle.Secondary);
  });

  return new ActionRowBuilder().addComponents(filterButtons);
}

function buildSelectionNavigationRow(mode, currentPage, totalPages, activeFilter, text) {
  const prevButton = new ButtonBuilder()
    .setCustomId(`playlist_page_${mode}_${activeFilter}_${currentPage - 1}`)
    .setLabel('Prev')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(currentPage <= 1);

  const pageIndicator = new ButtonBuilder()
    .setCustomId(`playlist_page_info_${mode}_${currentPage}_${totalPages}`)
    .setLabel(text.pageStatus.replace('{current}', `${currentPage}`).replace('{total}', `${totalPages}`))
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(true);

  const nextButton = new ButtonBuilder()
    .setCustomId(`playlist_page_${mode}_${activeFilter}_${currentPage + 1}`)
    .setLabel('Next')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(currentPage >= totalPages);

  const allButton = new ButtonBuilder()
    .setCustomId(`playlist_filter_${mode}_all`)
    .setLabel(text.allFilterLabel)
    .setStyle(activeFilter === 'all' ? ButtonStyle.Primary : ButtonStyle.Secondary);

  const backButton = new ButtonBuilder()
    .setCustomId('playlist_menu_back')
    .setLabel(text.backLabel)
    .setStyle(ButtonStyle.Secondary)
    .setEmoji(getEmojiForButton('back'));

  return new ActionRowBuilder().addComponents(prevButton, pageIndicator, nextButton, allButton, backButton);
}

function getSelectionModeMeta(text, mode) {
  if (mode === 'add') {
    return { heading: text.addHeading, prompt: text.addPrompt };
  }

  if (mode === 'play') {
    return { heading: text.playHeading, prompt: text.playPrompt };
  }

  if (mode === 'songs') {
    return { heading: text.songsHeading, prompt: text.songsPrompt };
  }

  return { heading: text.deleteHeading, prompt: text.deletePrompt || text.deleteNote };
}

async function getUserPlaylists(userId, serverId) {
  return playlistCollection.find({ userId, serverId }).sort({ name: 1 }).toArray();
}

function isBrowsablePlaylist(playlist) {
  const name = String(playlist?.name || '').trim();
  if (!name) return false;
  if (name === '__HISTORY__') return false;
  if (name === '__FAVORITES__') return false;
  if (name.startsWith('__FAVORITES__')) return false;
  return true;
}

async function getPlaylistsForMode(userId, serverId, mode) {
  if (mode === 'play' || mode === 'songs') {
    const serverPlaylists = await playlistCollection.find({ serverId }).sort({ name: 1 }).toArray();
    return serverPlaylists.filter(isBrowsablePlaylist);
  }

  const ownPlaylists = await getUserPlaylists(userId, serverId);
  return ownPlaylists.filter(isBrowsablePlaylist);
}

async function showMenu(interaction, lang) {
  const text = getPlaylistTexts(lang);
  const card = buildMenuCard(lang);
  card.addActionRowComponents(buildMainMenuRows(text));

  return interaction.editReply({
    components: [card],
    flags: MessageFlags.IsComponentsV2,
    fetchReply: true
  });
}

async function showPlaylistSelection(interaction, lang, mode, options = {}) {
  const text = getPlaylistTexts(lang);
  const allPlaylists = await getPlaylistsForMode(interaction.user.id, interaction.guild.id, mode);

  if (!allPlaylists.length) {
    return sendErrorResponse(
      interaction,
      `${text.noPlaylistsTitle}\n\n${text.noPlaylistsMessage}\n\n${text.noPlaylistsNote}`,
      5000
    );
  }

  const filterKey = ['all', 'num', 'af', 'gl', 'mr', 'sz'].includes(options.filterKey)
    ? options.filterKey
    : 'all';
  const filteredPlaylists = filterPlaylists(allPlaylists, filterKey);
  const paged = paginate(filteredPlaylists, options.page || 1, PLAYLISTS_PER_PAGE);
  const modeMeta = getSelectionModeMeta(text, mode);
  const shownCount = paged.items.length;

  const sections = [
    modeMeta.prompt,
    text.listStatus
      .replace('{shown}', `${shownCount}`)
      .replace('{filtered}', `${filteredPlaylists.length}`)
      .replace('{total}', `${allPlaylists.length}`)
  ];

  if (!filteredPlaylists.length) {
    sections.push(text.noFilteredPlaylists);
  }

  const card = buildPaleCard(`${getEmoji('playlist')} ${modeMeta.heading}`, sections);
  const rows = [];

  if (paged.items.length) {
    rows.push(...buildPlaylistButtonRows(paged.items, mode, filterKey, paged.page));
  }

  rows.push(buildFilterRow(mode, filterKey, text));
  rows.push(buildSelectionNavigationRow(mode, paged.page, paged.totalPages, filterKey, text));
  card.addActionRowComponents(rows);

  return interaction.editReply({
    components: [card],
    flags: MessageFlags.IsComponentsV2,
    fetchReply: true
  });
}

function createPlaylistModal(lang) {
  const text = getPlaylistTexts(lang);
  const modal = new ModalBuilder()
    .setCustomId('playlist_modal_create')
    .setTitle(text.createModalTitle);

  const nameInput = new TextInputBuilder()
    .setCustomId('playlistName')
    .setLabel(text.playlistNameLabel)
    .setRequired(true)
    .setStyle(TextInputStyle.Short)
    .setMaxLength(100)
    .setPlaceholder(text.playlistNamePlaceholder);

  modal.addComponents(new ActionRowBuilder().addComponents(nameInput));
  return modal;
}

function createAddSongsModal(playlistName, playlistId, lang) {
  const text = getPlaylistTexts(lang);
  const modal = new ModalBuilder()
    .setCustomId(`playlist_modal_add_${playlistId}`)
    .setTitle(text.addSongsModalTitle.replace('{name}', truncateLabel(playlistName, 24)));

  const songsInput = new TextInputBuilder()
    .setCustomId('songsInput')
    .setLabel(text.songsInputLabel)
    .setRequired(true)
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(1000)
    .setPlaceholder(text.songsInputPlaceholder);

  modal.addComponents(new ActionRowBuilder().addComponents(songsInput));
  return modal;
}

function createRemoveSongsModal(playlistId, filterKey, listPage, songsPage, lang) {
  const text = getPlaylistTexts(lang);
  const modal = new ModalBuilder()
    .setCustomId(`playlist_modal_remove_${playlistId}_${filterKey}_${listPage}_${songsPage}`)
    .setTitle(text.removeSongsModalTitle);

  const indexInput = new TextInputBuilder()
    .setCustomId('songIndexes')
    .setLabel(text.removeSongsInputLabel)
    .setRequired(true)
    .setStyle(TextInputStyle.Short)
    .setMaxLength(120)
    .setPlaceholder(text.removeSongsInputPlaceholder);

  modal.addComponents(new ActionRowBuilder().addComponents(indexInput));
  return modal;
}

function normalizeSongEntries(rawValue) {
  return String(rawValue || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function parseSongIndexes(rawValue) {
  const uniqueIndexes = new Set();

  for (const token of String(rawValue || '').split(',')) {
    const parsed = Number.parseInt(token.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      uniqueIndexes.add(parsed);
    }
  }

  return Array.from(uniqueIndexes).sort((a, b) => a - b);
}

function formatSongLine(songEntry, index) {
  const label = songEntry?.name || songEntry?.url || 'Unknown track';
  return `${index}. ${truncateLabel(label, 90)}`;
}

function buildSongsNavigationRow(playlistId, currentPage, totalPages, filterKey, listPage, text, canRemove) {
  const prevButton = new ButtonBuilder()
    .setCustomId(`playlist_songspage_${playlistId}_${currentPage - 1}_${filterKey}_${listPage}`)
    .setLabel('Prev')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(currentPage <= 1);

  const pageIndicator = new ButtonBuilder()
    .setCustomId(`playlist_songs_info_${playlistId}_${currentPage}_${totalPages}`)
    .setLabel(text.pageStatus.replace('{current}', `${currentPage}`).replace('{total}', `${totalPages}`))
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(true);

  const nextButton = new ButtonBuilder()
    .setCustomId(`playlist_songspage_${playlistId}_${currentPage + 1}_${filterKey}_${listPage}`)
    .setLabel('Next')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(currentPage >= totalPages);

  const removeButton = new ButtonBuilder()
    .setCustomId(`playlist_remove_open_${playlistId}_${filterKey}_${listPage}_${currentPage}`)
    .setLabel(text.removeSongsLabel)
    .setStyle(ButtonStyle.Danger)
    .setDisabled(!canRemove);

  const backButton = new ButtonBuilder()
    .setCustomId(`playlist_songsback_${filterKey}_${listPage}`)
    .setLabel(text.backToPlaylistsLabel)
    .setStyle(ButtonStyle.Secondary)
    .setEmoji(getEmojiForButton('back'));

  return new ActionRowBuilder().addComponents(prevButton, pageIndicator, nextButton, removeButton, backButton);
}

async function showPlaylistSongs(client, interaction, lang, playlistId, options = {}) {
  const text = getPlaylistTexts(lang);
  const playlist = await playlistCollection.findOne({
    _id: new ObjectId(playlistId),
    serverId: interaction.guild.id
  });

  if (!playlist) {
    return sendErrorResponse(
      interaction,
      `${text.playlistNotFoundTitle}\n\n${text.playlistNotFoundMessage}`,
      5000
    );
  }

  const songs = Array.isArray(playlist.songs) ? playlist.songs : [];
  if (!songs.length) {
    return sendErrorResponse(
      interaction,
      `${text.songsEmptyTitle}\n\n${text.songsEmptyMessage.replace('{name}', sanitizeTitle(playlist.name))}`,
      5000
    );
  }

  const filterKey = ['all', 'num', 'af', 'gl', 'mr', 'sz'].includes(options.filterKey)
    ? options.filterKey
    : 'all';
  const listPage = toSafePage(options.listPage, 1);
  const pagedSongs = paginate(songs, options.page || 1, SONGS_PER_PAGE);
  const canRemove = String(playlist.userId) === String(interaction.user.id);
  const startNumber = pagedSongs.startIndex + 1;
  const endNumber = pagedSongs.startIndex + pagedSongs.items.length;

  // Resolve real titles for URL-only entries and patch them permanently in DB
  if (client?.riffy) {
    const urlOnlyIndexes = pagedSongs.items
      .map((song, i) => ({ song, absIndex: pagedSongs.startIndex + i }))
      .filter(({ song }) => song?.url && !song?.name);
    if (urlOnlyIndexes.length > 0) {
      const resolvedSongs = [...songs];
      for (const { song, absIndex } of urlOnlyIndexes) {
        try {
          const result = await client.riffy.resolve({ query: song.url, requester: 'playlist' });
          if (result?.tracks?.length > 0) {
            const title = result.tracks[0].info?.title;
            if (title) {
              resolvedSongs[absIndex] = { ...song, name: title };
              pagedSongs.items[absIndex - pagedSongs.startIndex] = resolvedSongs[absIndex];
            }
          }
        } catch (_) { /* keep original if resolve fails */ }
      }
      // Patch DB so future views are instant
      await playlistCollection.updateOne(
        { _id: new ObjectId(playlistId) },
        { $set: { songs: resolvedSongs } }
      ).catch(() => {});
    }
  }

  const lines = pagedSongs.items.map((song, index) => formatSongLine(song, pagedSongs.startIndex + index + 1));

  const sections = [
    text.songsViewStatus
      .replace('{start}', `${startNumber}`)
      .replace('{end}', `${endNumber}`)
      .replace('{total}', `${songs.length}`),
    `### ${getEmoji('music')} Songs\n${lines.join('\n')}`
  ];

  if (!canRemove) {
    sections.push(text.viewOnlyNote);
  }

  const card = buildPaleCard(
    `${getEmoji('playlist')} ${text.songsViewTitle} • ${sanitizeTitle(playlist.name)}`,
    sections
  );

  card.addActionRowComponents([
    buildSongsNavigationRow(playlistId, pagedSongs.page, pagedSongs.totalPages, filterKey, listPage, text, canRemove)
  ]);

  return interaction.editReply({
    components: [card],
    flags: MessageFlags.IsComponentsV2,
    fetchReply: true
  });
}

async function handleCreateModalSubmit(interaction, lang) {
  const playlistText = getPlaylistTexts(lang);
  const playlistName = interaction.fields.getTextInputValue('playlistName').trim();
  const userId = interaction.user.id;
  const serverId = interaction.guild.id;

  if (!playlistName) {
    return sendErrorResponse(
      interaction,
      `${playlistText.invalidPlaylistNameTitle}\n\n${playlistText.invalidPlaylistNameMessage}`,
      5000
    );
  }

  const existingPlaylist = await playlistCollection.findOne({ name: playlistName, userId, serverId });
  if (existingPlaylist) {
    return sendErrorResponse(
      interaction,
      `${playlistText.playlistExistsTitle}\n\n${playlistText.playlistExistsMessage.replace('{name}', playlistName)}`,
      5000
    );
  }

  await playlistCollection.insertOne({
    name: playlistName,
    songs: [],
    isPrivate: true,
    userId,
    serverId,
    createdAt: new Date()
  });

  return sendSuccessResponse(
    interaction,
    `${playlistText.playlistCreatedTitle}\n\n${playlistText.playlistCreatedMessage.replace('{name}', playlistName)}`,
    '#00ff00',
    5000
  );
}

async function handleAddSongsModalSubmit(client, interaction, lang, playlistId) {
  const songsValue = interaction.fields.getTextInputValue('songsInput');
  const userId = interaction.user.id;
  const serverId = interaction.guild.id;
  const songNames = normalizeSongEntries(songsValue);

  const playlistText = getPlaylistTexts(lang);

  if (!songNames.length) {
    return sendErrorResponse(
      interaction,
      `${playlistText.noSongsFoundTitle}\n\n${playlistText.noSongsFoundMessage}`,
      5000
    );
  }

  const playlist = await playlistCollection.findOne({ _id: new ObjectId(playlistId), userId, serverId });
  if (!playlist) {
    return sendErrorResponse(
      interaction,
      `${playlistText.playlistNotFoundTitle}\n\n${playlistText.playlistNotFoundMessage}`,
      5000
    );
  }

  // Defer response because parsing multiple playlist tracks may exceed Discord's 3-second limit
  await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});

  const songs = [];
  for (const entry of songNames) {
    const trimmed = entry.trim();
    if (URL_REGEX.test(trimmed)) {
      // 1. Spotify Playlist URL
      if (trimmed.includes('spotify.com') && trimmed.includes('/playlist/')) {
        try {
          const playlistIdMatch = trimmed.split('/playlist/')[1]?.split('?')[0];
          if (playlistIdMatch) {
            const { getTracks } = require('spotify-url-info')(require('node-fetch'));
            const items = await getTracks(trimmed);
            const tracksToAdd = items.slice(0, 200); // Safe limit of 200 tracks
            let spotifyTracksCount = 0;
            const seenIds = new Set();
            for (const item of tracksToAdd) {
              if (item) {
                if (item.isLocal || item.type !== 'track' || (!item.id && !item.uri)) {
                  continue;
                }
                const trackId = item.id || item.uri;
                if (trackId) {
                  if (seenIds.has(trackId)) {
                    continue;
                  }
                  seenIds.add(trackId);
                }
                const name = item.name || item.title || 'Unknown';
                const artist = item.artist || item.artists?.map(a => a.name).join(', ') || item.subtitle || 'Unknown Artist';
                songs.push({ name: `${name} - ${artist}` });
                spotifyTracksCount++;
              }
            }
            console.log(`✅ Expanded ${spotifyTracksCount} tracks from Spotify playlist into custom database playlist.`);
            continue;
          }
        } catch (spotifyErr) {
          console.error("Error expanding Spotify playlist tracks:", spotifyErr.message);
        }
      }

      // 2. YouTube Playlist or other URL
      let resolvedName = null;
      try {
        if (client?.riffy) {
          const result = await client.riffy.resolve({ query: trimmed, requester: interaction.user.username });
          if (result) {
            if (result.loadType === 'playlist' && result.tracks && result.tracks.length > 0) {
              const tracksToAdd = result.tracks.slice(0, 200); // Safe limit of 200 tracks
              for (const track of tracksToAdd) {
                songs.push({ name: track.info.title, url: track.info.uri });
              }
              console.log(`✅ Expanded ${tracksToAdd.length} tracks from YouTube playlist into custom database playlist.`);
              continue;
            } else if (result.tracks && result.tracks.length > 0) {
              resolvedName = result.tracks[0].info?.title || null;
            }
          }
        }
      } catch (err) {
        console.error("Error expanding YouTube/other playlist tracks:", err.message || err);
      }
      songs.push(resolvedName ? { url: trimmed, name: resolvedName } : { url: trimmed });
    } else {
      songs.push({ name: trimmed });
    }
  }

  if (songs.length === 0) {
    return sendErrorResponse(
      interaction,
      `${playlistText.noSongsFoundTitle}\n\nNo valid tracks could be resolved from the provided input.`,
      5000
    );
  }

  await playlistCollection.updateOne(
    { _id: new ObjectId(playlistId), userId, serverId },
    { $push: { songs: { $each: songs } } }
  );

  return sendSuccessResponse(
    interaction,
    `${playlistText.songsAddedTitle}\n\n${playlistText.songsAddedMessage.replace('{count}', `${songs.length}`).replace('{name}', playlist.name)}`,
    '#00ff00',
    5000
  );
}

async function handleRemoveSongsModalSubmit(client, interaction, lang, playlistId, filterKey, listPage, songsPage) {
  const playlistText = getPlaylistTexts(lang);
  const userId = interaction.user.id;
  const serverId = interaction.guild.id;
  const indexesRaw = interaction.fields.getTextInputValue('songIndexes');
  const indexes = parseSongIndexes(indexesRaw);

  if (!indexes.length) {
    return sendErrorResponse(
      interaction,
      `${playlistText.removeSongsInvalidTitle}\n\n${playlistText.removeSongsInvalidMessage}`,
      5000
    );
  }

  const playlist = await playlistCollection.findOne({ _id: new ObjectId(playlistId), serverId });
  if (!playlist) {
    return sendErrorResponse(
      interaction,
      `${playlistText.playlistNotFoundTitle}\n\n${playlistText.playlistNotFoundMessage}`,
      5000
    );
  }

  if (String(playlist.userId) !== String(userId)) {
    return sendErrorResponse(
      interaction,
      `${playlistText.removeSongsDeniedTitle}\n\n${playlistText.removeSongsDeniedMessage}`,
      5000
    );
  }

  const songs = Array.isArray(playlist.songs) ? playlist.songs : [];
  if (!songs.length) {
    return sendErrorResponse(
      interaction,
      `${playlistText.songsEmptyTitle}\n\n${playlistText.songsEmptyMessage.replace('{name}', sanitizeTitle(playlist.name))}`,
      5000
    );
  }

  const validIndexes = indexes.filter((value) => value <= songs.length);
  if (!validIndexes.length) {
    return sendErrorResponse(
      interaction,
      `${playlistText.removeSongsOutOfRangeTitle}\n\n${playlistText.removeSongsOutOfRangeMessage}`,
      5000
    );
  }

  const removeSet = new Set(validIndexes.map((value) => value - 1));
  const updatedSongs = songs.filter((_, index) => !removeSet.has(index));
  const removedCount = songs.length - updatedSongs.length;

  await playlistCollection.updateOne(
    { _id: new ObjectId(playlistId), userId, serverId },
    { $set: { songs: updatedSongs } }
  );

  await sendSuccessResponse(
    interaction,
    `${playlistText.removeSongsSuccessTitle}\n\n${playlistText.removeSongsSuccessMessage
      .replace('{count}', `${removedCount}`)
      .replace('{name}', sanitizeTitle(playlist.name))}`,
    '#00ff00',
    5000
  );

  return showPlaylistSongs(client, interaction, lang, playlistId, {
    page: songsPage,
    filterKey,
    listPage
  });
}

async function playPlaylistById(client, interaction, playlistId, lang) {
  const { requesters } = require('../music/play.js');
  const serverId = interaction.guild.id;
  const playlistText = getPlaylistTexts(lang);
  const playlist = await playlistCollection.findOne({ _id: new ObjectId(playlistId), serverId });

  if (!playlist) {
    return sendErrorResponse(
      interaction,
      `${playlistText.playlistNotFoundTitle}\n\n${playlistText.playlistNotFoundMessage}`,
      5000
    );
  }
  const processingCard = buildPaleCard(
    `${getEmoji('music')} ${playlistText.processingTitle}`,
    [
      playlistText.processingMessage.replace('{name}', sanitizeTitle(playlist.name))
    ]
  );

  await interaction.editReply({
    components: [processingCard],
    flags: MessageFlags.IsComponentsV2,
    fetchReply: true
  });

  if (!playlist.songs.length) {
    return sendErrorResponse(
      interaction,
      `${playlistText.emptyPlaylistTitle}\n\n${playlistText.emptyPlaylistMessage.replace('{name}', playlist.name)}`,
      5000
    );
  }

  const existingPlayer = client.riffy.players.get(interaction.guildId);
  const voiceCheck = await checkVoiceChannel(interaction, existingPlayer);
  if (!voiceCheck.allowed) {
    if (voiceCheck.response && typeof voiceCheck.response === 'object') {
      const reply = await interaction.editReply(voiceCheck.response);
      setTimeout(() => reply.delete().catch(() => {}), 5000);
      return reply;
    }
    return sendErrorResponse(
      interaction,
      `${playlistText.voiceChannelErrorTitle}\n\n${playlistText.voiceChannelErrorMessage}`,
      5000
    );
  }

  const nodeManager = getLavalinkManager();
  if (!nodeManager) {
    return sendErrorResponse(
      interaction,
      `${playlistText.lavalinkUnavailableTitle}\n\n${playlistText.lavalinkUnavailableMessage}`,
      5000
    );
  }

  try {
    await nodeManager.ensureNodeAvailable();
  } catch (err) {
    return sendErrorResponse(
      interaction,
      `${playlistText.nodesUnavailableTitle}\n\n${playlistText.nodesUnavailableMessage}`,
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
      } catch (_) {}
    }
  }

  await nodeManager.checkAllNodesHealth().catch(() => {});
  await nodeManager.forceConnectAllNodes?.().catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 300));

  // Reuse the existing player if it is already connected to the target channel
  const activePlayer = client.riffy.players.get(interaction.guildId);
  let player = (activePlayer && !activePlayer.destroyed && activePlayer.voiceChannel === userVoiceChannel) ? activePlayer : null;

  if (!player) {
    let attempts = 0;
    while (attempts < 3) {
      attempts += 1;
      try {
        player = client.riffy.createConnection({
          guildId: interaction.guildId,
          voiceChannel: userVoiceChannel,
          textChannel: interaction.channelId,
          deaf: true
        });
        break;
      } catch (error) {
        if (attempts >= 3) {
          throw error;
        }
        await nodeManager.reconnectNodesNow?.(5000).catch(() => {});
        await nodeManager.ensureNodeAvailable().catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  }

  if (!player) {
    throw new Error('Failed to create a player connection.');
  }

  // Fast-start: Resolve the first playable track and play it immediately
  let firstTrackResolved = null;
  let firstTrackIndex = -1;

  for (let i = 0; i < playlist.songs.length; i++) {
    const trackEntry = playlist.songs[i];
    let query = trackEntry.url ? trackEntry.url : trackEntry.name;
    if (!query) continue;

    // Sanitize query to remove "- Unknown Artist", "- Unknown", hyphens, commas, etc.
    let searchQuery = query;
    if (!searchQuery.startsWith('http://') && !searchQuery.startsWith('https://')) {
      searchQuery = cleanSearchQuery(searchQuery);
    }

    let resolveResult;
    try {
      resolveResult = await client.riffy.resolve({ query: searchQuery, requester: interaction.user.username });
      if (resolveResult && resolveResult.tracks && resolveResult.tracks.length > 0) {
        firstTrackResolved = resolveResult.tracks[0];
        firstTrackResolved.info.requester = interaction.user.username;
        requesters.set(firstTrackResolved.info.uri, interaction.user.username);
        player.queue.add(firstTrackResolved);
        firstTrackIndex = i;
        break;
      }
    } catch (resolveError) {
      console.warn(`Failed to resolve track at index ${i}:`, resolveError.message || resolveError);
    }
  }

  if (!firstTrackResolved) {
    return sendErrorResponse(
      interaction,
      `${playlistText.playbackErrorTitle}\n\nCould not resolve any tracks in the playlist.`,
      5000
    );
  }

  const connected = await waitForPlayerConnection(player);
  if (!connected) {
    throw new Error('Voice connection could not be established.');
  }

  if (!player.playing && !player.paused && player.queue.length > 0) {
    await player.play().catch(() => {});
  }

  const successCard = buildPaleCard(
    `${getEmoji('playlist')} ${playlistText.playingPlaylistTitle}`,
    [
      `### ${getEmoji('play')} ${sanitizeTitle(playlist.name)}`,
      playlistText.playingPlaylistLineStatus.replace('{count}', `${playlist.songs.length}`)
    ]
  );

  const reply = await interaction.editReply({
    components: [successCard],
    flags: MessageFlags.IsComponentsV2,
    fetchReply: true
  });

  setTimeout(() => reply.delete().catch(() => {}), 5000);

  // Background resolving: load the rest of the playlist tracks in background parallel batches, preserving order
  (async () => {
    const remainingSongs = playlist.songs.filter((_, idx) => idx !== firstTrackIndex);
    const batchSize = 5;

    for (let i = 0; i < remainingSongs.length; i += batchSize) {
      const currentPlayer = client.riffy.players.get(interaction.guildId);
      if (!currentPlayer || currentPlayer.destroyed || currentPlayer !== player) break;

      const batch = remainingSongs.slice(i, i + batchSize);
      
      // Resolve the batch in parallel but preserve the relative array ordering
      const resolvedBatch = await Promise.all(batch.map(async (trackEntry) => {
        let query = trackEntry.url ? trackEntry.url : trackEntry.name;
        if (!query) return null;

        // Sanitize query to remove "- Unknown Artist", "- Unknown", hyphens, commas, etc.
        let searchQuery = query;
        if (!searchQuery.startsWith('http://') && !searchQuery.startsWith('https://')) {
          searchQuery = cleanSearchQuery(searchQuery);
        }

        try {
          const resolveResult = await client.riffy.resolve({ query: searchQuery, requester: interaction.user.username });
          if (resolveResult && resolveResult.tracks && resolveResult.tracks.length > 0) {
            const track = resolveResult.tracks[0];
            track.info.requester = interaction.user.username;
            return track;
          }
        } catch (err) {
          console.error(`Background resolution error for query "${query}":`, err.message || err);
        }
        return null;
      }));

      // Add resolved tracks to queue in the correct order
      const checkPlayer = client.riffy.players.get(interaction.guildId);
      if (checkPlayer && !checkPlayer.destroyed && checkPlayer === player) {
        for (const track of resolvedBatch) {
          if (track) {
            requesters.set(track.info.uri, interaction.user.username);
            player.queue.add(track);
          }
        }
        const { refreshNowPlayingPanel } = require('../../player.js');
        await refreshNowPlayingPanel(client, interaction.guildId).catch(() => {});
      }

      await new Promise(resolve => setTimeout(resolve, 250));
    }
  })();

  return reply;
}

function extractPlaylistId(customId, prefix) {
  if (!customId || !customId.startsWith(prefix)) return null;
  return customId.slice(prefix.length + 1);
}

async function handleComponent(client, interaction) {
  if (!playlistCollection) {
    const errMsg = '❌ Playlist system is unavailable because the database is not connected. Please try again later.';
    if (interaction.replied || interaction.deferred) {
      return interaction.followUp({ content: errMsg, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return interaction.reply({ content: errMsg, flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  const customId = interaction.customId;
  const lang = await getLang(interaction.guildId).catch(() => ({}));

  if (interaction.isButton()) {
    if (customId === 'playlist_menu_back') {
      await safeDeferUpdate(interaction);
      return showMenu(interaction, lang);
    }

    if (customId === 'playlist_menu_create') {
      return interaction.showModal(createPlaylistModal(lang)).catch(() => {});
    }

    const playlistText = getPlaylistTexts(lang);

    if (customId === 'playlist_menu_add') {
      await safeDeferUpdate(interaction);
      return showPlaylistSelection(interaction, lang, 'add', { page: 1, filterKey: 'all' });
    }

    if (customId === 'playlist_menu_view' || customId === 'playlist_menu_play') {
      await safeDeferUpdate(interaction);
      return showPlaylistSelection(interaction, lang, 'play', { page: 1, filterKey: 'all' });
    }

    if (customId === 'playlist_menu_songs') {
      await safeDeferUpdate(interaction);
      return showPlaylistSelection(interaction, lang, 'songs', { page: 1, filterKey: 'all' });
    }

    if (customId === 'playlist_menu_delete') {
      await safeDeferUpdate(interaction);
      return showPlaylistSelection(interaction, lang, 'delete', { page: 1, filterKey: 'all' });
    }

    if (customId.startsWith('playlist_filter_')) {
      await safeDeferUpdate(interaction);
      const parts = customId.split('_');
      const mode = parts[2];
      const filterKey = parts[3] || 'all';

      if (!['add', 'play', 'songs', 'delete'].includes(mode)) {
        return;
      }

      return showPlaylistSelection(interaction, lang, mode, { page: 1, filterKey });
    }

    if (customId.startsWith('playlist_page_')) {
      await safeDeferUpdate(interaction);
      const parts = customId.split('_');
      const mode = parts[2];
      const filterKey = parts[3] || 'all';
      const targetPage = toSafePage(parts[4], 1);

      if (!['add', 'play', 'songs', 'delete'].includes(mode)) {
        return;
      }

      return showPlaylistSelection(interaction, lang, mode, { page: targetPage, filterKey });
    }

    if (customId.startsWith('playlist_songspage_')) {
      await safeDeferUpdate(interaction);
      const parts = customId.split('_');
      const playlistId = parts[2];
      const targetPage = toSafePage(parts[3], 1);
      const filterKey = parts[4] || 'all';
      const listPage = toSafePage(parts[5], 1);

      return showPlaylistSongs(client, interaction, lang, playlistId, {
        page: targetPage,
        filterKey,
        listPage
      });
    }

    if (customId.startsWith('playlist_songsback_')) {
      await safeDeferUpdate(interaction);
      const parts = customId.split('_');
      const filterKey = parts[2] || 'all';
      const listPage = toSafePage(parts[3], 1);
      return showPlaylistSelection(interaction, lang, 'songs', { page: listPage, filterKey });
    }

    if (customId.startsWith('playlist_remove_open_')) {
      const parts = customId.split('_');
      const playlistId = parts[3];
      const filterKey = parts[4] || 'all';
      const listPage = toSafePage(parts[5], 1);
      const songsPage = toSafePage(parts[6], 1);

      const playlist = await playlistCollection.findOne({
        _id: new ObjectId(playlistId),
        serverId: interaction.guild.id
      });

      if (!playlist) {
        return sendErrorResponse(
          interaction,
          `${playlistText.playlistNotFoundTitle}\n\n${playlistText.playlistNotFoundMessage}`,
          5000
        );
      }

      if (String(playlist.userId) !== String(interaction.user.id)) {
        return sendErrorResponse(
          interaction,
          `${playlistText.removeSongsDeniedTitle}\n\n${playlistText.removeSongsDeniedMessage}`,
          5000
        );
      }

      return interaction.showModal(createRemoveSongsModal(playlistId, filterKey, listPage, songsPage, lang)).catch(() => {});
    }

    if (customId.startsWith('playlist_pick_')) {
      const parts = customId.split('_');
      const mode = parts[2];
      const playlistId = parts[3];
      const filterKey = parts[4] || 'all';
      const listPage = toSafePage(parts[5], 1);

      if (!playlistId || !['add', 'play', 'songs', 'delete'].includes(mode)) {
        return;
      }

      if (mode === 'add') {
        const playlist = await playlistCollection.findOne({ _id: new ObjectId(playlistId), userId: interaction.user.id, serverId: interaction.guild.id });
        if (!playlist) {
          return sendErrorResponse(
            interaction,
            `${playlistText.playlistNotFoundTitle}\n\n${playlistText.playlistNotFoundMessage}`,
            5000
          );
        }
        return interaction.showModal(createAddSongsModal(playlist.name, playlistId, lang)).catch(() => {});
      }

      if (mode === 'play') {
        await safeDeferUpdate(interaction);
        return playPlaylistById(client, interaction, playlistId, lang);
      }

      if (mode === 'songs') {
        await safeDeferUpdate(interaction);
        return showPlaylistSongs(client, interaction, lang, playlistId, {
          page: 1,
          filterKey,
          listPage
        });
      }

      await safeDeferUpdate(interaction);
      const result = await playlistCollection.deleteOne({ _id: new ObjectId(playlistId), userId: interaction.user.id, serverId: interaction.guild.id });
      if (result.deletedCount === 0) {
        return sendErrorResponse(
          interaction,
          `${playlistText.playlistNotFoundTitle}\n\n${playlistText.playlistNotFoundMessage}`,
          5000
        );
      }
      return sendSuccessResponse(
        interaction,
        `${playlistText.playlistDeletedTitle}\n\n${playlistText.playlistDeletedMessage}`,
        '#00ff00',
        5000
      );
    }

    if (customId.startsWith('playlist_add_select_')) {
      const playlistId = extractPlaylistId(customId, 'playlist_add_select');
      const playlist = await playlistCollection.findOne({ _id: new ObjectId(playlistId), userId: interaction.user.id, serverId: interaction.guild.id });
      if (!playlist) {
        return sendErrorResponse(
          interaction,
          `${playlistText.playlistNotFoundTitle}\n\n${playlistText.playlistNotFoundMessage}`,
          5000
        );
      }
      return interaction.showModal(createAddSongsModal(playlist.name, playlistId, lang)).catch(() => {});
    }

    if (customId.startsWith('playlist_view_')) {
      await safeDeferUpdate(interaction);
      const playlistId = extractPlaylistId(customId, 'playlist_view');
      return playPlaylistById(client, interaction, playlistId, lang);
    }

    if (customId.startsWith('playlist_delete_')) {
      await safeDeferUpdate(interaction);
      const playlistId = extractPlaylistId(customId, 'playlist_delete');
      const result = await playlistCollection.deleteOne({ _id: new ObjectId(playlistId), userId: interaction.user.id, serverId: interaction.guild.id });
      if (result.deletedCount === 0) {
        return sendErrorResponse(
          interaction,
          `${playlistText.playlistNotFoundTitle}\n\n${playlistText.playlistNotFoundMessage}`,
          5000
        );
      }
      return sendSuccessResponse(
        interaction,
        `${playlistText.playlistDeletedTitle}\n\n${playlistText.playlistDeletedMessage}`,
        '#00ff00',
        5000
      );
    }
  }

  if (interaction.isModalSubmit()) {
    if (customId === 'playlist_modal_create') {
      return handleCreateModalSubmit(interaction, lang);
    }

    if (customId.startsWith('playlist_modal_add_')) {
      const playlistId = customId.replace('playlist_modal_add_', '');
      return handleAddSongsModalSubmit(client, interaction, lang, playlistId);
    }

    if (customId.startsWith('playlist_modal_remove_')) {
      const parts = customId.split('_');
      const playlistId = parts[3];
      const filterKey = parts[4] || 'all';
      const listPage = toSafePage(parts[5], 1);
      const songsPage = toSafePage(parts[6], 1);
      return handleRemoveSongsModalSubmit(client, interaction, lang, playlistId, filterKey, listPage, songsPage);
    }
  }
}

module.exports = {
  data,
  helpers: {
    handleComponent
  },
  run: async (client, interaction) => {
    try {
      const deferred = await safeDeferReply(interaction);
      if (!deferred && !interaction.deferred && !interaction.replied) return;

      if (!playlistCollection) {
        return sendErrorResponse(
          interaction,
          '## ❌ Database Unavailable\n\nThe playlist system requires a database connection.\nPlease check your MongoDB URI in `config.js` and restart the bot.',
          8000
        );
      }

      return showMenu(interaction, await getLang(interaction.guildId));
    } catch (error) {
      return handleCommandError(interaction, error, 'playlist', '## ❌ Playlist Error\n\nThere was an issue opening your playlist menu.');
    }
  }
};
