/**
 * patchRiffy.js
 * 
 * Run this once on bot startup (before Riffy is loaded) to patch Riffy's Player.play()
 * so that any YouTube track is transparently swapped to a SoundCloud stream.
 * This survives npm install because it's applied at runtime, not to the files on disk.
 */

let _riffyInstance = null;

function setRiffyInstance(riffy) {
    _riffyInstance = riffy;
}

/**
 * Monkey-patch the Player.play() prototype method to intercept YouTube tracks.
 * Called once after Riffy is initialized.
 */
function patchPlayerPlay() {
    try {
        const { Player } = require('riffy');
        const originalPlay = Player.prototype.play;

        Player.prototype.play = async function() {
            // If queue is empty, just call original (it handles that)
            if (!this.queue || this.queue.length === 0) {
                return originalPlay.call(this);
            }

            // Peek at the next track without shifting it
            const nextTrack = this.queue[0];
            const sourceName = nextTrack?.info?.sourceName || '';
            const uri = nextTrack?.info?.uri || '';
            const isYouTube = sourceName === 'youtube' || /(?:youtube\.com|youtu\.be)/i.test(uri);

            if (isYouTube && _riffyInstance) {
                try {
                    const title = (nextTrack.info.title || '').replace(/\([^)]*\)|\[[^\]]*\]/g, '').trim();
                    const author = (nextTrack.info.author || '').replace(/ - Topic$/i, '').trim();
                    const scQuery = `${title} ${author}`.trim();
                    // Use source:'scsearch' — do NOT embed 'scsearch:' in query (Riffy would double-prefix it)
                    const scRes = await _riffyInstance.resolve({
                        query: scQuery,
                        source: 'scsearch',
                        requester: nextTrack.info.requester || 'SC-Auto'
                    }).catch(() => null);

                    if (scRes && scRes.tracks && scRes.tracks.length > 0) {
                        // Prefer actual SoundCloud tracks, not YouTube results
                        const scTrack = scRes.tracks.find(t => t.info?.sourceName === 'soundcloud') || scRes.tracks[0];
                        if (scTrack) {
                            scTrack.info.requester = nextTrack.info.requester;
                            // Replace the YouTube track in queue with SC track
                            this.queue[0] = scTrack;
                            console.log(`[ SC-PATCH ] Converted "${nextTrack.info.title}" → SoundCloud (${scTrack.info.sourceName}) before play()`);
                        }
                    }
                } catch (e) {
                    // If SC lookup fails, proceed with original track
                }
            }

            return originalPlay.call(this);
        };

        console.log('[ SC-PATCH ] Player.play() successfully patched for SoundCloud auto-conversion');
    } catch (e) {
        console.error('[ SC-PATCH ] Failed to patch Player.play():', e.message || e);
    }
}

module.exports = { patchPlayerPlay, setRiffyInstance };
