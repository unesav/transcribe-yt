// ===== DOM Elements =====
const homeView = document.getElementById('home-view');
const resultsView = document.getElementById('results-view');
const urlInput = document.getElementById('url-input');
const extractBtn = document.getElementById('extract-btn');
const homeError = document.getElementById('home-error');
const navUrlInput = document.getElementById('nav-url-input');
const navExtractBtn = document.getElementById('nav-extract-btn');
const backBtn = document.getElementById('back-btn');
const loadingOverlay = document.getElementById('loading-overlay');
const toast = document.getElementById('toast');

// Results elements
const videoThumbnail = document.getElementById('video-thumbnail');
const videoPlayLink = document.getElementById('video-play-link');
const videoTitle = document.getElementById('video-title');
const videoAuthor = document.getElementById('video-author');
const displayVideoId = document.getElementById('display-video-id');
const searchInput = document.getElementById('search-input');
const transcriptContainer = document.getElementById('transcript-container');
const wordCountEl = document.getElementById('word-count');
const charCountEl = document.getElementById('char-count');

// Action buttons
const copyPlainBtn = document.getElementById('copy-plain-btn');
const copyTsBtn = document.getElementById('copy-ts-btn');
const downloadDropdown = document.getElementById('download-dropdown');
const downloadBtn = document.getElementById('download-btn');
const downloadMenu = document.getElementById('download-menu');

// ===== i18n =====
const T = window.__T__ || {};
const LANG = window.__LANG__ || 'en';

// ===== State =====
let rawTranscript = [];      // Original fine-grained segments
let aggregatedTranscript = []; // Merged ~65-word chunks
let currentVideoId = '';
let currentVideoTitle = '';

// ===== YouTube URL Parsing =====
function extractVideoId(input) {
    if (!input) return null;
    input = input.trim();

    if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;

    try {
        const url = new URL(input);
        const hostname = url.hostname.replace('www.', '');

        if (hostname === 'youtube.com' || hostname === 'm.youtube.com') {
            if (url.searchParams.has('v')) return url.searchParams.get('v');
            const embedMatch = url.pathname.match(/^\/(embed|v)\/([a-zA-Z0-9_-]{11})/);
            if (embedMatch) return embedMatch[2];
            const shortsMatch = url.pathname.match(/^\/shorts\/([a-zA-Z0-9_-]{11})/);
            if (shortsMatch) return shortsMatch[1];
            const liveMatch = url.pathname.match(/^\/live\/([a-zA-Z0-9_-]{11})/);
            if (liveMatch) return liveMatch[1];
        }

        if (hostname === 'youtu.be') {
            const id = url.pathname.slice(1).split('/')[0];
            if (/^[a-zA-Z0-9_-]{11}$/.test(id)) return id;
        }
    } catch (_) { }

    const regex = /(?:youtube\.com\/(?:watch\?.*v=|embed\/|v\/|shorts\/|live\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
    const match = input.match(regex);
    return match ? match[1] : null;
}

// ===== Format seconds to MM:SS =====
function formatTime(seconds) {
    const s = Math.floor(seconds);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
}

// ===== Format seconds to HH:MM:SS,mmm (for SRT) =====
function formatSRT(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.round((seconds - Math.floor(seconds)) * 1000);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
}

// ===== Format seconds to HH:MM:SS.mmm (for VTT) =====
function formatVTT(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.round((seconds - Math.floor(seconds)) * 1000);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
}

// ===== Aggregate transcript into ~65-word chunks =====
const TARGET_WORDS = 65;

function aggregateTranscript(segments) {
    if (!segments || segments.length === 0) return [];

    const chunks = [];
    let currentChunk = { offset: segments[0].offset, words: [], endOffset: 0 };

    for (const seg of segments) {
        const segWords = seg.text.split(/\s+/).filter(w => w.length > 0);
        currentChunk.words.push(...segWords);
        currentChunk.endOffset = seg.offset + (seg.duration || 0);

        if (currentChunk.words.length >= TARGET_WORDS) {
            chunks.push({
                offset: currentChunk.offset,
                endOffset: currentChunk.endOffset,
                text: currentChunk.words.join(' '),
            });
            // Prepare next chunk — set offset to the next segment's start
            currentChunk = { offset: 0, words: [], endOffset: 0 };
        }
    }

    // Push remaining words
    if (currentChunk.words.length > 0) {
        chunks.push({
            offset: currentChunk.offset,
            endOffset: currentChunk.endOffset,
            text: currentChunk.words.join(' '),
        });
    }

    // Fix chunk offsets: the offset for a new chunk after flushing should be
    // set properly. We handle this by tracking the next segment offset.
    // Re-run with proper offset tracking:
    return aggregateWithOffsets(segments);
}

function aggregateWithOffsets(segments) {
    const chunks = [];
    let chunkText = [];
    let chunkStartOffset = segments[0].offset;
    let chunkEndOffset = 0;

    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const segWords = seg.text.split(/\s+/).filter(w => w.length > 0);
        chunkText.push(...segWords);
        chunkEndOffset = seg.offset + (seg.duration || 0);

        if (chunkText.length >= TARGET_WORDS) {
            chunks.push({
                offset: chunkStartOffset,
                endOffset: chunkEndOffset,
                text: chunkText.join(' '),
            });
            chunkText = [];
            // Next chunk starts at the next segment
            if (i + 1 < segments.length) {
                chunkStartOffset = segments[i + 1].offset;
            }
        }
    }

    // Push remaining
    if (chunkText.length > 0) {
        chunks.push({
            offset: chunkStartOffset,
            endOffset: chunkEndOffset,
            text: chunkText.join(' '),
        });
    }

    return chunks;
}

// ===== Show/Hide Loading =====
function showLoading() {
    loadingOverlay.classList.remove('hidden');
}

function hideLoading() {
    loadingOverlay.classList.add('hidden');
}

// ===== Show Error =====
function showError(msg) {
    homeError.textContent = msg;
    homeError.classList.remove('hidden');
}

function hideError() {
    homeError.classList.add('hidden');
}

// ===== Toast =====
function showToast(message) {
    const toastSpan = toast.querySelector('span');
    if (message) toastSpan.textContent = message;
    toast.classList.remove('hidden');
    toast.offsetHeight; // Force reflow
    toast.classList.add('show');
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.classList.add('hidden'), 300);
    }, 2500);
}

// ===== Switch View =====
function showHome() {
    resultsView.classList.remove('active');
    homeView.classList.add('active');
    urlInput.value = '';
    hideError();
}

function showResults() {
    homeView.classList.remove('active');
    resultsView.classList.add('active');
}

// ===== Render Transcript =====
function renderTranscript(chunks, query = '') {
    transcriptContainer.innerHTML = '';

    const filtered = query
        ? chunks.filter(c => c.text.toLowerCase().includes(query.toLowerCase()))
        : chunks;

    if (filtered.length === 0) {
        transcriptContainer.innerHTML = '<div class="no-results">No matching lines found.</div>';
        return;
    }

    const fragment = document.createDocumentFragment();

    filtered.forEach(chunk => {
        const row = document.createElement('div');
        row.className = 'transcript-line';

        const ts = document.createElement('span');
        ts.className = 'timestamp';
        ts.textContent = formatTime(chunk.offset);
        ts.title = 'Click to open video at this timestamp';
        ts.addEventListener('click', () => {
            window.open(`https://www.youtube.com/watch?v=${currentVideoId}&t=${Math.floor(chunk.offset)}s`, '_blank');
        });

        const txt = document.createElement('span');
        txt.className = 'transcript-text';

        if (query) {
            const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
            txt.innerHTML = chunk.text.replace(regex, '<mark>$1</mark>');
        } else {
            txt.textContent = chunk.text;
        }

        row.appendChild(ts);
        row.appendChild(txt);
        fragment.appendChild(row);
    });

    transcriptContainer.appendChild(fragment);
}

// ===== Update Stats =====
function updateStats(chunks) {
    const fullText = chunks.map(c => c.text).join(' ');
    const words = fullText.split(/\s+/).filter(w => w.length > 0).length;
    const chars = fullText.length;
    wordCountEl.textContent = `${T.wordCount || 'Word Count'}: ${words.toLocaleString()}`;
    charCountEl.textContent = `${T.charCount || 'Character count'}: ${chars.toLocaleString()}`;
}

// ===== Main Fetch Flow =====
async function fetchTranscript(videoId) {
    showLoading();
    hideError();

    try {
        const [transcriptRes, infoRes] = await Promise.all([
            fetch(`/api/transcript?videoId=${encodeURIComponent(videoId)}`),
            fetch(`/api/video-info?videoId=${encodeURIComponent(videoId)}`)
        ]);

        if (!transcriptRes.ok) {
            const err = await transcriptRes.json();
            throw new Error(err.error || 'Failed to fetch transcript');
        }

        const transcriptData = await transcriptRes.json();
        const transcript = transcriptData.transcript.map(t => ({
            offset: t.offset,
            duration: t.duration,
            text: t.text
        }));

        rawTranscript = transcript;
        aggregatedTranscript = aggregateWithOffsets(transcript);
        currentVideoId = videoId;

        // Video info
        if (infoRes.ok) {
            const info = await infoRes.json();
            currentVideoTitle = info.title || 'transcript';
            videoTitle.textContent = info.title || (T.untitledVideo || 'Untitled Video');
            videoAuthor.textContent = info.author || '';
            videoThumbnail.src = info.thumbnail;
            videoThumbnail.alt = info.title || 'Video thumbnail';
        } else {
            currentVideoTitle = 'transcript';
            videoTitle.textContent = T.video || 'Video';
            videoAuthor.textContent = '';
            videoThumbnail.src = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
        }

        videoPlayLink.href = `https://www.youtube.com/watch?v=${videoId}`;
        displayVideoId.textContent = videoId;

        renderTranscript(aggregatedTranscript);
        updateStats(aggregatedTranscript);
        searchInput.value = '';
        showResults();
    } catch (err) {
        showError(err.message);
    } finally {
        hideLoading();
    }
}

// ===== Clipboard Helpers =====
function copyToClipboard(text, buttonEl, label) {
    navigator.clipboard.writeText(text).then(() => {
        showToast(T.copiedClipboard || 'Copied to clipboard');
        if (buttonEl) {
            buttonEl.classList.add('copied');
            const origText = buttonEl.textContent;
            const svgEl = buttonEl.querySelector('svg');
            buttonEl.textContent = T.copied || 'Copied!';
            if (svgEl) buttonEl.prepend(svgEl);
            setTimeout(() => {
                buttonEl.classList.remove('copied');
                buttonEl.textContent = label;
                if (svgEl) buttonEl.prepend(svgEl);
            }, 2000);
        }
    }).catch(() => {
        // Fallback
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast(T.copiedClipboard || 'Copied to clipboard');
    });
}

// ===== Copy Handlers =====
function copyPlainText() {
    if (!aggregatedTranscript.length) return;
    const text = aggregatedTranscript.map(c => c.text).join('\n\n');
    copyToClipboard(text, copyPlainBtn, T.copy || 'Copy');
}

function copyWithTimestamps() {
    if (!aggregatedTranscript.length) return;
    const text = aggregatedTranscript
        .map(c => `${formatTime(c.offset)}\n${c.text}`)
        .join('\n\n');
    copyToClipboard(text, copyTsBtn, T.copyTimestamps || 'Copy with timestamps');
}

// ===== Download Helpers =====
function triggerDownload(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function sanitizeFilename(title) {
    return title.replace(/[^a-zA-Z0-9_\- ]/g, '').trim().replace(/\s+/g, '_') || 'transcript';
}

function downloadSRT() {
    if (!aggregatedTranscript.length) return;
    const lines = aggregatedTranscript.map((chunk, i) => {
        const start = formatSRT(chunk.offset);
        const end = formatSRT(chunk.endOffset || chunk.offset + 10);
        return `${i + 1}\n${start} --> ${end}\n${chunk.text}`;
    });
    const content = lines.join('\n\n') + '\n';
    triggerDownload(content, `${sanitizeFilename(currentVideoTitle)}.srt`, 'application/x-subrip');
    showToast('Downloaded .srt file');
}

function downloadVTT() {
    if (!aggregatedTranscript.length) return;
    const lines = aggregatedTranscript.map((chunk, i) => {
        const start = formatVTT(chunk.offset);
        const end = formatVTT(chunk.endOffset || chunk.offset + 10);
        return `${start} --> ${end}\n${chunk.text}`;
    });
    const content = 'WEBVTT\n\n' + lines.join('\n\n') + '\n';
    triggerDownload(content, `${sanitizeFilename(currentVideoTitle)}.vtt`, 'text/vtt');
    showToast('Downloaded .vtt file');
}

function downloadTXT() {
    if (!aggregatedTranscript.length) return;
    const content = aggregatedTranscript.map(c => c.text).join('\n\n') + '\n';
    triggerDownload(content, `${sanitizeFilename(currentVideoTitle)}.txt`, 'text/plain');
    showToast('Downloaded .txt file');
}

// ===== Dropdown Toggle =====
function toggleDropdown(e) {
    e.stopPropagation();
    downloadDropdown.classList.toggle('open');
}

function closeDropdown() {
    downloadDropdown.classList.remove('open');
}

// ===== Event Handlers =====
function handleExtract(inputEl) {
    const val = inputEl.value.trim();
    if (!val) {
        showError('Please paste a YouTube URL.');
        return;
    }

    const videoId = extractVideoId(val);
    if (!videoId) {
        showError('Invalid YouTube URL. Please enter a valid link (e.g. https://youtube.com/watch?v=...)');
        return;
    }

    fetchTranscript(videoId);
}

// Home input
extractBtn.addEventListener('click', () => handleExtract(urlInput));
urlInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleExtract(urlInput);
});

// Nav input (results page)
navExtractBtn.addEventListener('click', () => handleExtract(navUrlInput));
navUrlInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleExtract(navUrlInput);
});

// Back button
backBtn.addEventListener('click', showHome);

// Action buttons
copyPlainBtn.addEventListener('click', copyPlainText);
copyTsBtn.addEventListener('click', copyWithTimestamps);

// Download dropdown
downloadBtn.addEventListener('click', toggleDropdown);
document.addEventListener('click', closeDropdown);

// Download format items
downloadMenu.addEventListener('click', (e) => {
    const item = e.target.closest('.dropdown-item');
    if (!item) return;
    const format = item.dataset.format;
    if (format === 'srt') downloadSRT();
    else if (format === 'vtt') downloadVTT();
    else if (format === 'txt') downloadTXT();
    closeDropdown();
});

// Search
searchInput.addEventListener('input', () => {
    renderTranscript(aggregatedTranscript, searchInput.value);
});

// Auto-focus URL input on load
urlInput.focus();

// ===== Language Switcher =====
document.querySelectorAll('.lang-switcher-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const dropdown = btn.closest('.lang-switcher-wrapper').querySelector('.lang-dropdown');
        dropdown.classList.toggle('open');
    });
});

document.addEventListener('click', () => {
    document.querySelectorAll('.lang-dropdown.open').forEach(d => d.classList.remove('open'));
});
