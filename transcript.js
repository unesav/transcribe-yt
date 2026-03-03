/**
 * YouTube Transcript Fetcher
 * 
 * Uses a Cloudflare Worker proxy to route YouTube requests through
 * Cloudflare edge IPs (bypasses datacenter IP blocking).
 * Falls back to direct fetch + yt-dlp for local development.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Cloudflare Worker proxy URL (routes requests through edge IPs)
const PROXY_URL = 'https://yt-transcript-proxy.transcribeyoutubevideo.workers.dev';

// Whether to use the proxy (always use in production to bypass bot detection)
const USE_PROXY = true;

// yt-dlp fallback detection (for local dev)
let YT_DLP_CMD = null;
try {
    require('child_process').execFileSync('python3', ['-m', 'yt_dlp', '--version'], { timeout: 5000 });
    YT_DLP_CMD = 'python3';
} catch { /* yt-dlp not available */ }

const localBin = path.join(__dirname, 'yt-dlp');
if (fs.existsSync(localBin)) YT_DLP_CMD = localBin;

const COOKIES_FILE = path.join(__dirname, 'cookies.txt');

/**
 * Fetch a URL, optionally through the Cloudflare proxy.
 */
async function proxyFetch(url, options = {}) {
    if (USE_PROXY) {
        const proxyUrl = PROXY_URL + '?url=' + encodeURIComponent(url);
        return fetch(proxyUrl, options);
    }
    return fetch(url, options);
}

/**
 * Main entry point — tries pure JS (via proxy) first, falls back to yt-dlp.
 */
async function fetchTranscript(videoId, lang) {
    const errors = [];

    // Strategy 1: Pure JS with proxy
    try {
        const result = await jsTranscript(videoId, lang);
        if (result && result.transcript.length > 0) return result;
    } catch (e) {
        errors.push('js: ' + e.message);
    }

    // Strategy 2: yt-dlp (for local dev)
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

// ─── Strategy 1: Pure JS via Cloudflare proxy ───────────────────

async function jsTranscript(videoId, preferredLang) {
    const videoUrl = 'https://www.youtube.com/watch?v=' + videoId;

    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Cookie': 'SOCS=CAESEwgDEgk2NjE0MTEyNTQaAmVuIAEaBgiA_c28Bg; CONSENT=PENDING+987',
    };

    // Fetch video page (through proxy if enabled)
    const pageRes = await proxyFetch(videoUrl, { headers, redirect: 'follow' });
    if (!pageRes.ok) throw new Error('Page fetch failed: ' + pageRes.status);

    const html = await pageRes.text();

    // Extract ytInitialPlayerResponse
    const playerMatch = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;/s);
    if (!playerMatch) throw new Error('No player response found');

    const playerResponse = JSON.parse(playerMatch[1]);

    const playability = playerResponse?.playabilityStatus;
    if (playability?.status === 'ERROR' || playability?.status === 'UNPLAYABLE') {
        throw new Error(playability?.reason || 'Video unavailable');
    }

    const captionTracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!captionTracks || captionTracks.length === 0) {
        throw new Error('CAPTIONS_UNAVAILABLE');
    }

    const track = pickTrack(captionTracks, preferredLang);

    let baseUrl = track.baseUrl;
    if (baseUrl.startsWith('/')) {
        baseUrl = 'https://www.youtube.com' + baseUrl;
    }

    const captionHeaders = {
        ...headers,
        'Referer': videoUrl,
    };

    // Try json3 format (through proxy)
    const json3Url = baseUrl + '&fmt=json3';
    const json3Res = await proxyFetch(json3Url, { headers: captionHeaders, redirect: 'follow' });
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

    // Try XML format (through proxy)
    const xmlRes = await proxyFetch(baseUrl, { headers: captionHeaders, redirect: 'follow' });
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
    const videoUrl = 'https://www.youtube.com/watch?v=' + videoId;
    const ytdlpArgs = YT_DLP_CMD === 'python3' ? ['-m', 'yt_dlp'] : [];
    const cookiesArgs = fs.existsSync(COOKIES_FILE) ? ['--cookies', COOKIES_FILE] : [];

    const tracks = await new Promise((resolve, reject) => {
        const args = [...ytdlpArgs, ...cookiesArgs, '--no-check-certificates', '--list-subs', '--skip-download', videoUrl];
        execFile(YT_DLP_CMD, args, { timeout: 30000 }, (error, stdout, stderr) => {
            if (error && !stdout && !stderr) return reject(new Error('yt-dlp failed'));
            const combined = (stdout || '') + '\n' + (stderr || '');
            const lines = combined.split('\n');
            const manual = [], auto = [];
            let section = null;
            for (const line of lines) {
                if (line.includes('Available subtitles for')) { section = 'manual'; continue; }
                if (line.includes('Available automatic captions for')) { section = 'auto'; continue; }
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

    if (tracks.manual.length === 0 && tracks.auto.length === 0) throw new Error('CAPTIONS_UNAVAILABLE');

    // Pick best track
    const origTrack = tracks.auto.find(l => l.endsWith('-orig'));
    const origLang = origTrack ? origTrack.replace(/-orig$/, '') : null;
    let selectedLang, isAuto;
    if (origTrack) {
        if (tracks.manual.includes(origLang)) { selectedLang = origLang; isAuto = false; }
        else { selectedLang = origTrack; isAuto = true; }
    } else if (lang && tracks.manual.includes(lang)) { selectedLang = lang; isAuto = false; }
    else if (lang && tracks.auto.includes(lang)) { selectedLang = lang; isAuto = true; }
    else if (tracks.manual.length > 0) { selectedLang = tracks.manual[0]; isAuto = false; }
    else { selectedLang = tracks.auto[0]; isAuto = true; }

    // Download subtitle
    return new Promise((resolve, reject) => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-transcript-'));
        const outTemplate = path.join(tmpDir, 'sub');
        const args = [
            ...ytdlpArgs, ...cookiesArgs, '--no-check-certificates',
            isAuto ? '--write-auto-sub' : '--write-sub',
            '--sub-lang', selectedLang, '--sub-format', 'json3',
            '--skip-download', '-o', outTemplate, videoUrl,
        ];
        execFile(YT_DLP_CMD, args, { timeout: 45000 }, () => {
            try {
                const files = fs.readdirSync(tmpDir);
                const subFile = files.find(f => f.endsWith('.json3'));
                if (!subFile) { cleanup(tmpDir); return reject(new Error('CAPTIONS_UNAVAILABLE')); }
                const raw = fs.readFileSync(path.join(tmpDir, subFile), 'utf-8');
                const json = JSON.parse(raw);
                const transcript = parseJson3(json);
                cleanup(tmpDir);
                const langMatch = subFile.match(/\.([a-zA-Z\-]+)\.json3$/);
                resolve({ transcript, language: langMatch ? langMatch[1] : selectedLang });
            } catch {
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
