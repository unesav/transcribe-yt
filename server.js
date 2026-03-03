const express = require('express');
const path = require('path');
const { fetchTranscript } = require('./transcript');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== i18n Setup =====
const translations = require('./locales/translations.json');
const SUPPORTED_LANGS = Object.keys(translations);
const RTL_LANGS = ['ar', 'he'];
const BASE_URL = 'https://transcribeyoutubevideo.com';

// Native language names for the switcher dropdown
const LANG_NAMES = {
  en: 'English', ru: 'Русский', es: 'Español', id: 'Bahasa Indonesia',
  fil: 'Filipino', hi: 'हिन्दी', de: 'Deutsch', fr: 'Français',
  ro: 'Română', ar: 'العربية', da: 'Dansk', nl: 'Nederlands',
  he: 'עברית', it: 'Italiano', ja: '日本語', ko: '한국어',
  pl: 'Polski', pt: 'Português', sv: 'Svenska', tr: 'Türkçe',
  'zh-cn': '简体中文', 'zh-tw': '繁體中文'
};

// Build availableLangs object for template
const availableLangs = {};
for (const code of SUPPORTED_LANGS) {
  availableLangs[code] = { name: LANG_NAMES[code] || code };
}

// EJS setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// ===== Helper: Generate hreflang tags =====
function generateHreflangTags(pagePath) {
  let tags = '';
  for (const code of SUPPORTED_LANGS) {
    const href = code === 'en'
      ? `${BASE_URL}${pagePath || '/'}`
      : `${BASE_URL}/${code}${pagePath || ''}`;
    const hreflang = code === 'zh-cn' ? 'zh-Hans' : code === 'zh-tw' ? 'zh-Hant' : code;
    tags += `  <link rel="alternate" hreflang="${hreflang}" href="${href}" />\n`;
  }
  // x-default points to English
  tags += `  <link rel="alternate" hreflang="x-default" href="${BASE_URL}${pagePath || '/'}" />\n`;
  return tags;
}

// ===== Helper: Render i18n page =====
function renderPage(req, res, lang) {
  const t = translations[lang];
  if (!t) return res.status(404).send('Language not found');

  const dir = RTL_LANGS.includes(lang) ? 'rtl' : 'ltr';
  const langPrefix = lang === 'en' ? '' : `/${lang}`;
  const canonical = lang === 'en' ? `${BASE_URL}/` : `${BASE_URL}/${lang}`;
  const hreflangTags = generateHreflangTags('');
  const langNativeName = LANG_NAMES[lang] || lang;

  res.render('index', {
    lang,
    dir,
    t,
    canonical,
    hreflangTags,
    langPrefix,
    langNativeName,
    availableLangs
  });
}

// ===== Extract video ID =====
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

// ===== API Routes =====
app.get('/api/transcript', async (req, res) => {
  try {
    const { videoId: rawInput, lang } = req.query;
    if (!rawInput) return res.status(400).json({ error: 'Missing videoId parameter' });
    const videoId = extractVideoId(rawInput);
    if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL or video ID.' });
    const result = await fetchTranscript(videoId, lang || undefined);
    res.json({ videoId, transcript: result.transcript, language: result.language });
  } catch (err) {
    console.error('Transcript fetch error:', err.message);
    if (err.message === 'CAPTIONS_UNAVAILABLE' || err.message === 'CAPTIONS_EMPTY') {
      return res.status(404).json({ error: 'No transcript available for this video.' });
    }
    if (err.message === 'CAPTIONS_PARSE_ERROR') {
      return res.status(500).json({ error: 'Failed to parse caption data.' });
    }
    res.status(500).json({ error: 'Failed to fetch transcript.' });
  }
});

app.get('/api/video-info', async (req, res) => {
  try {
    const { videoId: rawInput } = req.query;
    const videoId = extractVideoId(rawInput);
    if (!videoId) return res.status(400).json({ error: 'Invalid video ID' });
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const response = await fetch(oembedUrl);
    if (!response.ok) return res.status(404).json({ error: 'Video not found' });
    const data = await response.json();
    res.json({
      videoId, title: data.title, author: data.author_name,
      authorUrl: data.author_url,
      thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    });
  } catch (err) {
    console.error('Video info error:', err.message);
    res.status(500).json({ error: 'Failed to fetch video info' });
  }
});

// ===== Static pages (English only) =====
app.get('/about', (req, res) => res.sendFile(path.join(__dirname, 'public', 'about.html')));
app.get('/contact', (req, res) => res.sendFile(path.join(__dirname, 'public', 'contact.html')));
app.get('/privacy-policy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy-policy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));

// ===== Dynamic sitemap =====
app.get('/sitemap.xml', (req, res) => {
  res.set('Content-Type', 'application/xml');
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n';
  xml += '        xmlns:xhtml="http://www.w3.org/1999/xhtml">\n';

  // Home page for each language
  for (const code of SUPPORTED_LANGS) {
    const loc = code === 'en' ? `${BASE_URL}/` : `${BASE_URL}/${code}`;
    xml += '  <url>\n';
    xml += `    <loc>${loc}</loc>\n`;
    xml += '    <changefreq>weekly</changefreq>\n';
    xml += `    <priority>${code === 'en' ? '1.0' : '0.9'}</priority>\n`;
    // Add xhtml:link alternates
    for (const altCode of SUPPORTED_LANGS) {
      const altHref = altCode === 'en' ? `${BASE_URL}/` : `${BASE_URL}/${altCode}`;
      const hreflang = altCode === 'zh-cn' ? 'zh-Hans' : altCode === 'zh-tw' ? 'zh-Hant' : altCode;
      xml += `    <xhtml:link rel="alternate" hreflang="${hreflang}" href="${altHref}" />\n`;
    }
    xml += `    <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}/" />\n`;
    xml += '  </url>\n';
  }

  // Static English-only pages
  const staticPages = [
    { path: '/about', freq: 'monthly', priority: '0.6' },
    { path: '/contact', freq: 'monthly', priority: '0.5' },
    { path: '/privacy-policy', freq: 'yearly', priority: '0.3' },
    { path: '/terms', freq: 'yearly', priority: '0.3' }
  ];
  for (const pg of staticPages) {
    xml += '  <url>\n';
    xml += `    <loc>${BASE_URL}${pg.path}</loc>\n`;
    xml += `    <changefreq>${pg.freq}</changefreq>\n`;
    xml += `    <priority>${pg.priority}</priority>\n`;
    xml += '  </url>\n';
  }

  xml += '</urlset>\n';
  res.send(xml);
});

// ===== i18n routes =====
// Redirect /en to / (prevent duplicate content)
app.get('/en', (req, res) => res.redirect(301, '/'));
app.get('/en/transcript', (req, res) => res.redirect(301, '/transcript'));

// English home (default)
app.get('/', (req, res) => renderPage(req, res, 'en'));

// Language-specific home pages
// Match exact language codes including zh-cn, zh-tw
app.get('/:lang', (req, res, next) => {
  const lang = req.params.lang.toLowerCase();
  if (SUPPORTED_LANGS.includes(lang) && lang !== 'en') {
    return renderPage(req, res, lang);
  }
  next();
});

// Language-specific transcript pages (SPA fallback)
app.get('/:lang/transcript', (req, res, next) => {
  const lang = req.params.lang.toLowerCase();
  if (SUPPORTED_LANGS.includes(lang) && lang !== 'en') {
    return renderPage(req, res, lang);
  }
  next();
});

// English transcript page (SPA fallback)
app.get('/transcript', (req, res) => renderPage(req, res, 'en'));

// Catch-all fallback to English
app.get('*', (req, res) => renderPage(req, res, 'en'));

app.listen(PORT, () => {
  console.log(`✅ YouTube Transcript server running at http://localhost:${PORT}`);
});
