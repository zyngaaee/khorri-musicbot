const spotifyURI = require('spotify-uri');

const urls = [
    'https://open.spotify.com/playlist/08YlHkYTx9SyKzxoe8wXPI?si=f42c292dc0c34b5b&nd=1&dlsi=075e1b966daf48ae',
    'https://open.spotify.com/playlist/08YlHkYTx9SyKzxoe8wXPI'
];

urls.forEach(url => {
    try {
        const parsed = spotifyURI.parse(url);
        console.log(`Parsed ${url}:`, parsed);
    } catch (err) {
        console.error(`Failed to parse ${url}:`, err.message);
    }
});
