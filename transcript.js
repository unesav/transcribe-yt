/**
 * YouTube Transcript Fetcher — pure JS, cookie-aware.
 *
 * Strategy:
 *  1. Establish a YouTube session with proper CONSENT cookies
 *  2. Fetch the video page, extract caption track info from ytInitialPlayerResponse
 *  3. Fetch the actual caption data using the session cookies
 *
 * Falls back to yt-dlp if available.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// yt-dlp fallback detection
let YT_DLP_CMD, YT_DLP_ARGS_PREFIX;
const localBin = path.join(__dirname, 'yt-dlp');
if (fs.existsSync(localBin)) {
    YT_DLP_CMD = localBin;
    YT_DLP_ARGS_PREFIX = [];
} else {
    try {
        require('child_process').execFileSync('python3', ['-m', 'yt_dlp', '--version'], { timeout: 5000 });
        YT_DLP_CMD = 'python3';
        YT_DLP_ARGS_PREFIX = ['-m', 'yt_dlp'];
    } catch {
        YT_DLP_CMD = null;
        YT_DLP_ARGS_PREFIX = [];
    }
}

const COOKIES_FILE = path.join(__dirname, 'cookies.txt');
const COOKIES_ARGS = fs.existsSync(COOKIES_FILE) ? ['--cookies', COOKIES_FILE] : [];

/**
 * Main entry point — tries pure JS first, falls back to yt-dlp.
 */
async function fetchTranscript(videoId, lang) {
    const errors = [];

    // Strategy 1: Pure JS with innertube/timedtext
    try {
        const result = await jsTranscript(videoId, lang);
        if (result && result.transcript.length > 0) return result;
    } catch (e) {
        errors.push('js: ' + e.message);
    }

    // Strategy 2: yt-dlp (if available)
    if (YT_DLP_CMD) {
        try {
            const result = await ytdlpTranscript(videoId, lang);
            if (result && result.transcript.length > 0) return result;
        } catch (e) {
            errors.push('yt-dlp: ' + e.message);
        }
    }

    console.error('All transcript strategies failed:', errors.join('; '));
    throw new Error('CAPTIONS_UNAVAILABLE');
}

// ─── Strategy 1: Pure JS ────────────────────────────────────────

async function jsTranscript(videoId, preferredLang) {
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    // Step 1: Fetch video page with proper cookie handling
    // YouTube serves a consent page without the right cookies.
    // We need to set SOCS cookie or CONSENT cookie to bypass it.
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        // SOCS cookie to bypass consent in EU/GDPR regions
        'Cookie': 'SOCS=CAESEwgDEgk2NjE0MTEyNTQaAmVuIAEaBgiA_c28Bg; CONSENT=PENDING+987',
    };

    const pageRes = await fetch(videoUrl, { headers, redirect: 'follow' });
    if (!pageRes.ok) throw new Error(`Page fetch failed: ${pageRes.status}`);

    const html = await pageRes.text();

    // Collect Set-Cookie headers for subsequent requests
    const responseCookies = pageRes.headers.getSetCookie?.() || [];
    const cookieStr = [
        'SOCS=CAESEwgDEgk2NjE0MTEyNTQaAmVuIAEaBgiA_c28Bg',
        'CONSENT=PENDING+987',
        ...responseCookies.map(c => c.split(';')[0])
    ].join('; ');

    // Step 2: Extract ytInitialPlayerResponse
    const playerMatch = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;/s);
    if (!playerMatch) throw new Error('No player response found');

    let playerResponse;
    try {
        playerResponse = JSON.parse(playerMatch[1]);
    } catch {
        throw new Error('Failed to parse player response');
    }

    // Check for playability errors (bot detection, geo-restriction, etc.)
    const playability = playerResponse?.playabilityStatus;
    if (playability?.status === 'ERROR' || playability?.status === 'UNPLAYABLE') {
        throw new Error(playability?.reason || 'Video unavailable');
    }

    const captionTracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!captionTracks || captionTracks.length === 0) {
        throw new Error('CAPTIONS_UNAVAILABLE');
    }

    // Step 3: Pick best track
    const track = pickTrack(captionTracks, preferredLang);

    // Step 4: Build absolute URL
    let baseUrl = track.baseUrl;
    if (baseUrl.startsWith('/')) {
        baseUrl = 'https://www.youtube.com' + baseUrl;
    }

    // Step 5: Fetch caption data (try json3, then XML)
    const captionHeaders = {
        ...headers,
        'Cookie': cookieStr,
        'Referer': videoUrl,
    };

    // Try json3 format
    const json3Url = baseUrl + '&fmt=json3';
    const json3Res = await fetch(json3Url, { headers: captionHeaders, redirect: 'follow' });
    if (json3Res.ok) {
        const text = await json3Res.text();
        if (text.length > 10) {
            try {
                const json = JSON.parse(text);
                const segments = parseJson3(json);
                if (segments.length > 0) {
                    return { transcript: segments, language: track.languageCode };
                }
            } catch { }
        }
    }

    // Try XML format
    const xmlRes = await fetch(baseUrl, { headers: captionHeaders, redirect: 'follow' });
    if (xmlRes.ok) {
        const xml = await xmlRes.text();
        if (xml.length > 10) {
            const segments = parseXml(xml);
            if (segments.length > 0) {
                return { transcript: segments, language: track.languageCode };
            }
        }
    }

    throw new Error('Caption content empty');
}

function pickTrack(captionTracks, preferredLang) {
    if (preferredLang) {
        const manual = captionTracks.find(t => t.languageCode === preferredLang && t.kind !== 'asr');
        if (manual) return manual;
        const auto = captionTracks.find(t => t.languageCode === preferredLang);
        if (auto) return auto;
    }
    const manual = captionTracks.find(t => t.kind !== 'asr');
    if (manual) return manual;
    return captionTracks[0];
}

function parseJson3(json) {
    if (!json.events) return [];
    return json.events
        .filter(e => e.segs)
        .map(e => ({
            offset: (e.tStartMs || 0) / 1000,
            duration: (e.dDurationMs || 0) / 1000,
            text: e.segs.map(s => s.utf8 || '').join('').replace(/\n/g, ' ').trim(),
        }))
        .filter(s => s.text);
}

function parseXml(xml) {
    const segments = [];
    const regex = /<text start="([\d.]+)" dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
    let m;
    while ((m = regex.exec(xml)) !== null) {
        const text = m[3]
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
            .replace(/<[^>]+>/g, '').replace(/\n/g, ' ').trim();
        if (text) {
            segments.push({ offset: parseFloat(m[1]), duration: parseFloat(m[2]), text });
        }
    }
    return segments;
}

// ─── Strategy 2: yt-dlp fallback ────────────────────────────────

async function ytdlpTranscript(videoId, lang) {
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    // Phase 1: list subs
    const tracks = await listSubtitles(videoUrl);
    if (tracks.manual.length === 0 && tracks.auto.length === 0) {
        throw new Error('CAPTIONS_UNAVAILABLE');
    }

    const { selectedLang, isAuto } = pickBestYtdlpTrack(tracks, lang);

    // Phase 2: download
    return downloadSubtitle(videoId, videoUrl, selectedLang, isAuto);
}

function listSubtitles(videoUrl) {
    return new Promise((resolve, reject) => {
        const args = [
            ...YT_DLP_ARGS_PREFIX, ...COOKIES_ARGS,
            '--no-check-certificates', '--list-subs', '--skip-download', videoUrl,
        ];
        execFile(YT_DLP_CMD, args, { timeout: 30000 }, (error, stdout, stderr) => {
            if (error && !stdout && !stderr) return reject(new Error('yt-dlp failed: ' + error.message));
            const combined = (stdout || '') + '\n' + (stderr || '');
            const lines = combined.split('\n');
            const manual = [], auto = [];
            let section = null;
            for (const line of lines) {
                if (line.includes('Available subtitles for')) { section = 'manual'; continue; }
                if (line.includes('Available automatic captions for')) { section = 'auto'; continue; }
                if (line.includes('has no subtitles') || line.includes('has no automatic captions')) continue;
                if (line.startsWith('Language') || line.startsWith('---')) continue;
                if (section) {
                    const match = line.match(/^([a-zA-Z\-]+)\s+/);
                    if (match && match[1] !== 'Language') {
                        (section === 'manual' ? manual : auto).push(match[1].trim());
                    }
                }
            }
            resolve({ manual, auto });
        });
    });
}

function pickBestYtdlpTrack(tracks, preferredLang) {
    const origTrack = tracks.auto.find(l => l.endsWith('-orig'));
    const origLang = origTrack ? origTrack.replace(/-orig$/, '') : null;
    if (origTrack) {
        if (tracks.manual.includes(origLang)) return { selectedLang: origLang, isAuto: false };
        return { selectedLang: origTrack, isAuto: true };
    }
    if (preferredLang) {
        if (tracks.manual.includes(preferredLang)) return { selectedLang: preferredLang, isAuto: false };
        if (tracks.auto.includes(preferredLang)) return { selectedLang: preferredLang, isAuto: true };
    }
    if (tracks.manual.length > 0) return { selectedLang: tracks.manual[0], isAuto: false };
    if (tracks.auto.length > 0) {
        const base = tracks.auto.filter(l => /^[a-z]{2,3}$/.test(l));
        if (base.length > 0) return { selectedLang: base[0], isAuto: true };
        return { selectedLang: tracks.auto[0], isAuto: true };
    }
    throw new Error('CAPTIONS_UNAVAILABLE');
}

function downloadSubtitle(videoId, videoUrl, lang, isAuto) {
    return new Promise((resolve, reject) => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-transcript-'));
        const outTemplate = path.join(tmpDir, 'sub');
        const args = [
            ...YT_DLP_ARGS_PREFIX, ...COOKIES_ARGS,
            '--no-check-certificates',
            isAuto ? '--write-auto-sub' : '--write-sub',
            '--sub-lang', lang, '--sub-format', 'json3',
            '--skip-download', '-o', outTemplate, videoUrl,
        ];
        execFile(YT_DLP_CMD, args, { timeout: 45000 }, (error, stdout, stderr) => {
            try {
                const files = fs.readdirSync(tmpDir);
                const subFile = files.find(f => f.endsWith('.json3'));
                if (!subFile) { cleanup(tmpDir); return reject(new Error('CAPTIONS_UNAVAILABLE')); }
                const raw = fs.readFileSync(path.join(tmpDir, subFile), 'utf-8');
                const json = JSON.parse(raw);
                const transcript = parseJson3(json);
                cleanup(tmpDir);
                const langMatch = subFile.match(/\.([a-zA-Z\-]+)\.json3$/);
                resolve({ transcript, language: langMatch ? langMatch[1] : lang });
            } catch (e) {
                cleanup(tmpDir);
                reject(new Error('CAPTIONS_PARSE_ERROR'));
            }
        });
    });
}

function cleanup(dir) {
    try {
        for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
        fs.rmdirSync(dir);
    } catch { }
}

module.exports = { fetchTranscript };
