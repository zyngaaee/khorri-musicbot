const config = require("../config.js");
const { InteractionType, MessageFlags } = require('discord.js');
const path = require("path");
const colors = require('../UI/colors/colors');
const { getLang, getLangSync } = require('../utils/languageLoader.js');
const { safeDeferUpdate } = require('../utils/responseHandler');

async function resolveLang(guildId) {
  return getLang(guildId).catch(() => getLangSync());
}

module.exports = async (client, interaction) => {
  try {

    if (interaction.type === InteractionType.ApplicationCommand) {
    if (!interaction?.guild) {
        const lang = await resolveLang(interaction.guildId);
        return interaction?.reply({ 
          content: lang?.events?.interactionCreate?.noGuild || 'This command can only be used inside a server.', 
          flags: MessageFlags.Ephemeral 
        });
    }

      const lang = await resolveLang(interaction.guildId);
      const command = client.commands.get(interaction.commandName);

      if (!command) {
        const consoleLang = getLangSync();
        console.error(`${colors.cyan}[ INTERACTION ]${colors.reset} ${colors.red}${consoleLang.console?.events?.interaction?.commandNotFound?.replace('{commandName}', interaction.commandName) || `Command not found: ${interaction.commandName}`}${colors.reset}`);
        return interaction?.reply({ 
          content: lang?.events?.interactionCreate?.commandNotFound || 'That command could not be found.', 
          flags: MessageFlags.Ephemeral 
        });
      }

      const requiredPermissions = command.permissions;
      if (requiredPermissions && !interaction?.member?.permissions?.has(requiredPermissions)) {
        return interaction?.reply({ 
          content: lang?.events?.interactionCreate?.noPermission || 'You do not have permission to use this command.', 
          flags: MessageFlags.Ephemeral 
        });
      }

  
      try {
        await command.run(client, interaction);
      } catch (error) {
        const consoleLang = getLangSync();
        console.error(`${colors.cyan}[ INTERACTION ]${colors.reset} ${colors.red}${consoleLang.console?.events?.interaction?.errorExecuting?.replace('{commandName}', interaction.commandName) || `Error executing command ${interaction.commandName}:`}${colors.reset}`, error);
        
        const errorTemplate = lang?.events?.interactionCreate?.errorOccurred || 'An error occurred: {message}';
        const errorMessage = errorTemplate.replace('{message}', error.message);
        
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ 
            content: errorMessage, 
            flags: MessageFlags.Ephemeral 
          }).catch(() => {});
        } else {
          await interaction.reply({ 
            content: errorMessage, 
            flags: MessageFlags.Ephemeral 
          }).catch(() => {});
        }
      }
    }

    if (interaction.type === InteractionType.ApplicationCommandAutocomplete) {
      const command = client.commands.get(interaction.commandName);

      if (!command) {
        return;
      }

      try {
        if (typeof command.autocomplete === 'function') {
          await command.autocomplete(interaction);
        } else if (typeof command.run === 'function') {
          // Backward compatibility for commands that handle autocomplete inside run().
          await command.run(client, interaction);
        }
      } catch (error) {
        if (error?.code === 10062 || error?.message?.includes('Unknown interaction')) {
          return;
        }
        const consoleLang = getLangSync();
        console.error(`${colors.cyan}[ AUTOCOMPLETE ]${colors.reset} ${colors.red}${consoleLang.console?.events?.interaction?.errorExecuting?.replace('{commandName}', interaction.commandName) || `Error executing autocomplete for ${interaction.commandName}:`}${colors.reset}`, error);
      }
    }

   
    if (interaction.isButton()) {
      if (interaction.customId.startsWith('help_')) {
        try {
          const deferred = await safeDeferUpdate(interaction);
          if (!deferred && !interaction.deferred && !interaction.replied) return;
          const helpCommand = client.commands.get('help');
          if (helpCommand && helpCommand.helpers?.handleComponent) {
            return await helpCommand.helpers.handleComponent(client, interaction);
          }
        } catch (error) {
          const consoleLang = getLangSync();
          console.error(consoleLang.console?.events?.interaction?.errorHelpButton || 'Error handling help interaction button:', error);
          const lang = await resolveLang(interaction.guildId);
          const retryMessage = lang?.events?.interactionCreate?.errorTryAgain || 'Something went wrong. Please try again.';
          try {
            if (!interaction.replied && !interaction.deferred) {
              await interaction.reply({ content: retryMessage, flags: MessageFlags.Ephemeral });
            } else {
              await interaction.followUp({ content: retryMessage, flags: MessageFlags.Ephemeral });
            }
          } catch (e) {}
        }
        return;
      }

      if (interaction.customId.startsWith('playlist_')) {
        try {
          const playlistCommand = client.commands.get('playlist');
          if (playlistCommand && playlistCommand.helpers?.handleComponent) {
            return await playlistCommand.helpers.handleComponent(client, interaction);
          }
        } catch (error) {
          const consoleLang = getLangSync();
          console.error(consoleLang.console?.events?.interaction?.errorPlaylistButton || 'Error handling playlist interaction button:', error);
          const lang = await resolveLang(interaction.guildId);
          const retryMessage = lang?.events?.interactionCreate?.errorTryAgain || 'Something went wrong. Please try again.';
          try {
            if (!interaction.replied && !interaction.deferred) {
              await interaction.reply({ content: retryMessage, flags: MessageFlags.Ephemeral });
            } else {
              await interaction.followUp({ content: retryMessage, flags: MessageFlags.Ephemeral });
            }
          } catch (e) {}
        }
        return;
      }

      if (interaction.customId.startsWith('spotify:')) {
        try {
          const spotifyCommand = client.commands.get('spotify');
          if (spotifyCommand && spotifyCommand.helpers?.handleComponent) {
            return await spotifyCommand.helpers.handleComponent(client, interaction);
          }
        } catch (error) {
          const consoleLang = getLangSync();
          console.error('Error handling spotify interaction button:', error);
          const lang = await resolveLang(interaction.guildId);
          const retryMessage = lang?.events?.interactionCreate?.errorTryAgain || 'Something went wrong. Please try again.';
          try {
            if (!interaction.replied && !interaction.deferred) {
              await interaction.reply({ content: retryMessage, flags: MessageFlags.Ephemeral });
            } else {
              await interaction.followUp({ content: retryMessage, flags: MessageFlags.Ephemeral });
            }
          } catch (e) {}
        }
        return;
      }
    }

  
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith('help_') || interaction.customId === 'help_category_select') {
        try {
          const deferred = await safeDeferUpdate(interaction);
          if (!deferred && !interaction.deferred && !interaction.replied) return;
          const helpCommand = client.commands.get('help');
          if (helpCommand && helpCommand.helpers?.handleComponent) {
            return await helpCommand.helpers.handleComponent(client, interaction);
          }
        } catch (error) {
          const consoleLang = getLangSync();
          console.error(consoleLang.console?.events?.interaction?.errorHelpSelect || 'Error handling help interaction select:', error);
          const lang = await resolveLang(interaction.guildId);
          const retryMessage = lang?.events?.interactionCreate?.errorTryAgain || 'Something went wrong. Please try again.';
          try {
            if (!interaction.replied && !interaction.deferred) {
              await interaction.reply({ content: retryMessage, flags: MessageFlags.Ephemeral });
            } else {
              await interaction.followUp({ content: retryMessage, flags: MessageFlags.Ephemeral });
            }
          } catch (e) {}
        }
        return;
      }
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith('playlist_modal_')) {
        try {
          const playlistCommand = client.commands.get('playlist');
          if (playlistCommand && playlistCommand.helpers?.handleComponent) {
            return await playlistCommand.helpers.handleComponent(client, interaction);
          }
        } catch (error) {
          const consoleLang = getLangSync();
          console.error(consoleLang.console?.events?.interaction?.errorPlaylistModal || 'Error handling playlist modal:', error);
          const lang = await resolveLang(interaction.guildId);
          const retryMessage = lang?.events?.interactionCreate?.errorTryAgain || 'Something went wrong. Please try again.';
          try {
            if (!interaction.replied && !interaction.deferred) {
              await interaction.reply({ content: retryMessage, flags: MessageFlags.Ephemeral });
            } else {
              await interaction.followUp({ content: retryMessage, flags: MessageFlags.Ephemeral });
            }
          } catch (e) {}
        }
        return;
      }
    }
  } catch (error) {
    const consoleLang = getLangSync();
    console.error(`${colors.cyan}[ INTERACTION ]${colors.reset} ${colors.red}${consoleLang.console?.events?.interaction?.unexpectedError || 'Unexpected error:'}${colors.reset}`, error);
    
    const lang = await resolveLang(interaction.guildId);
    const unexpectedMessage = lang?.events?.interactionCreate?.unexpectedError || 'An unexpected error occurred. Please try again.';
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ 
          content: unexpectedMessage, 
          flags: MessageFlags.Ephemeral 
        }).catch(() => {});
      } else {
        await interaction.reply({ 
          content: unexpectedMessage, 
          flags: MessageFlags.Ephemeral 
        }).catch(() => {});
      }
    } catch (replyError) {
      console.error(`${colors.cyan}[ INTERACTION ]${colors.reset} ${colors.red}${consoleLang.console?.events?.interaction?.failedToSendError || 'Failed to send error message:'}${colors.reset}`, replyError);
    }
  }
};
