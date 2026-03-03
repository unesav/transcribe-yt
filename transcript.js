/**
 * YouTube Transcript Fetcher
 * 
 * Uses Python youtube-transcript-api (via child_process) as the primary method.
 * Falls back to yt-dlp for additional reliability.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Python script path
const PY_SCRIPT = path.join(__dirname, 'get_transcript.py');

// yt-dlp fallback detection
let YT_DLP_CMD = null;
const localBin = path.join(__dirname, 'yt-dlp');
if (fs.existsSync(localBin)) YT_DLP_CMD = localBin;
if (!YT_DLP_CMD) {
    try {
        require('child_process').execFileSync('python3', ['-m', 'yt_dlp', '--version'], { timeout: 5000 });
        YT_DLP_CMD = 'python3';
    } catch { }
}

const COOKIES_FILE = path.join(__dirname, 'cookies.txt');

/**
 * Main entry point — tries Python youtube-transcript-api first, falls back to yt-dlp.
 */
async function fetchTranscript(videoId, lang) {
    const errors = [];

    // Strategy 1: Python youtube-transcript-api
    try {
        const result = await pythonTranscript(videoId, lang);
        if (result && result.transcript.length > 0) return result;
    } catch (e) {
        errors.push('python: ' + e.message);
    }

    // Strategy 2: yt-dlp fallback
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

// ─── Strategy 1: Python youtube-transcript-api ──────────────────

function pythonTranscript(videoId, lang) {
    return new Promise((resolve, reject) => {
        const args = [PY_SCRIPT, videoId];
        if (lang) args.push(lang);

        const pythonLibs = path.join(__dirname, 'python_libs');
        const pythonEnv = { ...process.env, PYTHONPATH: pythonLibs + (process.env.PYTHONPATH ? ':' + process.env.PYTHONPATH : '') };

        execFile('python3', args, { timeout: 30000, maxBuffer: 10 * 1024 * 1024, cwd: __dirname, env: pythonEnv }, (error, stdout, stderr) => {
            if (stderr) console.error('Python stderr:', stderr.substring(0, 200));

            if (!stdout || stdout.trim().length === 0) {
                return reject(new Error('Python script returned no output'));
            }

            try {
                const result = JSON.parse(stdout.trim());
                if (result.error) {
                    return reject(new Error(result.error));
                }
                resolve(result);
            } catch (e) {
                reject(new Error('Python output parse error: ' + e.message));
            }
        });
    });
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

function cleanup(dir) {
    try {
        for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
        fs.rmdirSync(dir);
    } catch { }
}

module.exports = { fetchTranscript };
