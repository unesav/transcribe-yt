/**
 * YouTube Transcript Fetcher using yt-dlp standalone binary.
 * 
 * Language-agnostic: auto-detects available caption tracks via --list-subs,
 * then downloads the best available track. Falls back from manual → auto-generated.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Detect yt-dlp: standalone binary in project dir, system binary, or Python module
let YT_DLP_CMD, YT_DLP_ARGS_PREFIX;
const localBin = path.join(__dirname, 'yt-dlp');
if (fs.existsSync(localBin)) {
    YT_DLP_CMD = localBin;
    YT_DLP_ARGS_PREFIX = [];
} else {
    // Fall back to python3 -m yt_dlp (works on machines with pip-installed yt-dlp)
    YT_DLP_CMD = 'python3';
    YT_DLP_ARGS_PREFIX = ['-m', 'yt_dlp'];
}

// Cookies file for authenticated YouTube requests (bypasses bot detection on server IPs)
const COOKIES_FILE = path.join(__dirname, 'cookies.txt');
const COOKIES_ARGS = fs.existsSync(COOKIES_FILE)
    ? ['--cookies', COOKIES_FILE]
    : [];

/**
 * Fetch transcript for a YouTube video using yt-dlp.
 * 
 * Strategy:
 *  1. Run --list-subs to discover all available tracks (manual + auto-generated).
 *  2. Pick the best language: prefer the requested lang, then the video's
 *     original/auto-generated language, then any available.
 *  3. Download that specific track.
 * 
 * @param {string} videoId - 11-char YouTube video ID
 * @param {string} [lang] - Optional preferred language code. If omitted, auto-detects.
 * @returns {Promise<{transcript: Array<{offset: number, duration: number, text: string}>, language: string}>}
 */
async function fetchTranscript(videoId, lang) {
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    // Phase 1: Discover available subtitle tracks
    const tracks = await listSubtitles(videoUrl);

    if (tracks.manual.length === 0 && tracks.auto.length === 0) {
        throw new Error('CAPTIONS_UNAVAILABLE');
    }

    // Phase 2: Pick the best language/type to download
    const { selectedLang, isAuto } = pickBestTrack(tracks, lang);

    // Phase 3: Download that specific track
    const result = await downloadSubtitle(videoId, videoUrl, selectedLang, isAuto);

    if (!result || result.transcript.length === 0) {
        throw new Error('CAPTIONS_EMPTY');
    }

    return result;
}

/**
 * Run yt-dlp --list-subs to discover available subtitle tracks.
 * Parses the output to find manual and auto-generated languages.
 */
function listSubtitles(videoUrl) {
    return new Promise((resolve, reject) => {
        const args = [
            ...YT_DLP_ARGS_PREFIX,
            ...COOKIES_ARGS,
            '--no-check-certificates',
            '--list-subs',
            '--skip-download',
            videoUrl,
        ];

        execFile(YT_DLP_CMD, args, { timeout: 30000 }, (error, stdout, stderr) => {
            if (error && !stdout && !stderr) {
                return reject(new Error('yt-dlp execution failed: ' + error.message));
            }

            const combined = (stdout || '') + '\n' + (stderr || '');
            const lines = combined.split('\n');

            const manual = [];
            const auto = [];
            let section = null; // 'manual' | 'auto' | null

            for (const line of lines) {
                // Detect section headers
                if (line.includes('Available subtitles for')) {
                    section = 'manual';
                    continue;
                }
                if (line.includes('Available automatic captions for')) {
                    section = 'auto';
                    continue;
                }
                if (line.includes('has no subtitles') || line.includes('has no automatic captions')) {
                    continue;
                }
                // Skip header row
                if (line.startsWith('Language') || line.startsWith('---')) {
                    continue;
                }

                // Parse language lines like: "fr       French                vtt, srt, ..."
                if (section) {
                    const match = line.match(/^([a-zA-Z\-]+)\s+/);
                    if (match) {
                        const langCode = match[1].trim();
                        if (langCode && langCode !== 'Language') {
                            if (section === 'manual') {
                                manual.push(langCode);
                            } else {
                                auto.push(langCode);
                            }
                        }
                    }
                }
            }

            resolve({ manual, auto });
        });
    });
}

/**
 * Pick the best subtitle track to download.
 */
function pickBestTrack(tracks, preferredLang) {
    // Step 1: Detect the original language from auto tracks
    const origTrack = tracks.auto.find(l => l.endsWith('-orig'));
    const origLang = origTrack ? origTrack.replace(/-orig$/, '') : null;

    // Step 2: If we found the original language, prioritize it
    if (origTrack) {
        if (tracks.manual.includes(origLang)) {
            return { selectedLang: origLang, isAuto: false };
        }
        return { selectedLang: origTrack, isAuto: true };
    }

    // Step 3: No -orig track found. Use preferred language if specified.
    if (preferredLang) {
        if (tracks.manual.includes(preferredLang)) {
            return { selectedLang: preferredLang, isAuto: false };
        }
        if (tracks.auto.includes(preferredLang)) {
            return { selectedLang: preferredLang, isAuto: true };
        }
    }

    // Step 4: Pick the best available.
    if (tracks.manual.length > 0) {
        return { selectedLang: tracks.manual[0], isAuto: false };
    }

    if (tracks.auto.length > 0) {
        const baseTracks = tracks.auto.filter(l => /^[a-z]{2,3}$/.test(l));
        if (baseTracks.length > 0) {
            return { selectedLang: baseTracks[0], isAuto: true };
        }
        return { selectedLang: tracks.auto[0], isAuto: true };
    }

    throw new Error('CAPTIONS_UNAVAILABLE');
}

/**
 * Download a specific subtitle track using yt-dlp.
 */
function downloadSubtitle(videoId, videoUrl, lang, isAuto) {
    return new Promise((resolve, reject) => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-transcript-'));
        const outTemplate = path.join(tmpDir, 'sub');

        const args = [
            ...YT_DLP_ARGS_PREFIX,
            ...COOKIES_ARGS,
            '--no-check-certificates',
            isAuto ? '--write-auto-sub' : '--write-sub',
            '--sub-lang', lang,
            '--sub-format', 'json3',
            '--skip-download',
            '-o', outTemplate,
            videoUrl,
        ];

        execFile(YT_DLP_CMD, args, { timeout: 45000 }, (error, stdout, stderr) => {
            try {
                const files = fs.readdirSync(tmpDir);
                const subFile = files.find(f => f.endsWith('.json3'));

                if (!subFile) {
                    cleanup(tmpDir);
                    return reject(new Error('CAPTIONS_UNAVAILABLE'));
                }

                const subPath = path.join(tmpDir, subFile);
                const raw = fs.readFileSync(subPath, 'utf-8');
                const json = JSON.parse(raw);

                const transcript = parseJson3(json);
                cleanup(tmpDir);

                // Extract actual lang from filename: sub.<lang>.json3
                const langMatch = subFile.match(/\.([a-zA-Z\-]+)\.json3$/);
                const detectedLang = langMatch ? langMatch[1] : lang;

                resolve({
                    transcript,
                    language: detectedLang,
                });
            } catch (e) {
                cleanup(tmpDir);
                reject(new Error('CAPTIONS_PARSE_ERROR'));
            }
        });
    });
}

/**
 * Parse yt-dlp json3 subtitle format into a clean transcript array.
 */
function parseJson3(json) {
    if (!json.events) return [];

    const result = [];

    for (const event of json.events) {
        if (!event.segs) continue;

        const text = event.segs
            .map(s => s.utf8 || '')
            .join('')
            .replace(/\n/g, ' ')
            .trim();

        if (!text) continue;

        result.push({
            offset: (event.tStartMs || 0) / 1000,
            duration: (event.dDurationMs || 0) / 1000,
            text,
        });
    }

    return result;
}

/**
 * Clean up temporary directory
 */
function cleanup(dir) {
    try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
            fs.unlinkSync(path.join(dir, file));
        }
        fs.rmdirSync(dir);
    } catch (_) {
        // Ignore cleanup errors
    }
}

module.exports = { fetchTranscript };
