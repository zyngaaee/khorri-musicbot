const { SlashCommandBuilder } = require("discord.js");
const { getLavalinkManager } = require('../../lavalink.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName("disconnect")
        .setDescription("Disconnect the bot from the voice channel"),

    async run(client, interaction) {
        try {
            const player = client.riffy.players.get(interaction.guild.id);

            if (!player) {
                return interaction.reply({
                    content: "❌ I am not connected to any voice channel.",
                    ephemeral: true
                });
            }

            // User must be in VC
            if (!interaction.member.voice.channel) {
                return interaction.reply({
                    content: "❌ You must be in a voice channel.",
                    ephemeral: true
                });
            }

            // Same VC check
            if (
                interaction.guild.members.me.voice.channelId !==
                interaction.member.voice.channelId
            ) {
                return interaction.reply({
                    content: "❌ You must be in my voice channel.",
                    ephemeral: true
                });
            }

            const nodeManager = getLavalinkManager();
            if (nodeManager) {
                await nodeManager.resetVoiceChannelStatus(interaction.guild.id, player.voiceChannel).catch(() => {});
            }

            player.destroy();

            return interaction.reply({
                content: "👋 Disconnected from the voice channel."
            });

        } catch (err) {
            console.error(`[ DISCONNECT ]`, err);

            return interaction.reply({
                content: "❌ Failed to disconnect.",
                ephemeral: true
            });
        }
    }
};
