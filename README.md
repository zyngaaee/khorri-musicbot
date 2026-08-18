
# Khorri Music Bot

An advanced Discord music bot built with Discord.js, Lavalink, and Riffy. It supports music playback, playlists, Spotify linking, queue controls, voice controls, and utility commands.

## Features

- Music playback with `/play`, `/search`, `/queue`, `/skip`, `/pause`, `/resume`, `/stop`, `/seek`, `/volume`, `/shuffle`, `/move`, `/jump`, `/remove`, `/disconnect`
- Spotify support for track, playlist, and profile handling
- Autoplay and 24/7 voice support
- Now playing panels and queue display
- Language system
- Utility commands like `/help`, `/ping`, `/stats`, `/history`, `/emoji`
- Lavalink node management through Riffy

## Requirements

- Node.js 20+ recommended
- Discord bot token
- Lavalink server
- MongoDB
- Spotify API credentials if you want Spotify features

## Installation

```bash
npm install
```

## Configuration

Create or update `config.js` in the project root with your own values.

Do not commit private values such as tokens, database URIs, or API secrets.

Example keys used by the bot:

```js
{
  TOKEN: "your-discord-bot-token",
  commandsDir: "./commands",
  language: "en",
  mongodbUri: "your-mongodb-uri",
  nodes: [
    {
      name: "MainNode",
      host: "your-lavalink-host",
      port: 2333,
      password: "your-lavalink-password",
      secure: false
    }
  ],
  spotifyClientId: "your-spotify-client-id",
  spotifyClientSecret: "your-spotify-client-secret",
  spotifyRedirectUri: "your-spotify-redirect-uri"
}
```

Some optional visual settings are also read from `config.js`, such as embed colors, music card settings, progress bar settings, and voice debug options.

## Run

```bash
npm start
```

The bot starts from `index.js`, which loads `bot.js`.

## Main Commands

Music:

- `/play`
- `/search`
- `/queue`
- `/skip`
- `/pause`
- `/resume`
- `/stop`
- `/seek`
- `/volume`
- `/shuffle`
- `/move`
- `/jump`
- `/remove`
- `/disconnect`
- `/np`
- `/trackinfo`
- `/voteskip`
- `/autoplay`

Playlist and Spotify:

- `/playlist`
- `/fetchplaylist`
- `/spotify`

Utility:

- `/help`
- `/ping`
- `/stats`
- `/history`
- `/emoji`
- `/language`
- `/247`

## Notes

- `config.js` is ignored by Git, so your secrets stay local.
- The bot uses Lavalink through Riffy for playback.
- If YouTube playback fails on a node, check the Lavalink server and YouTube plugin first.

## License

MIT
