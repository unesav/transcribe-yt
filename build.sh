#!/usr/bin/env bash
# Render Build Script
# Installs Node.js dependencies, Python youtube-transcript-api, and yt-dlp

set -e

echo "==> Installing Node.js dependencies..."
npm install

echo "==> Installing Python youtube-transcript-api..."
pip install youtube-transcript-api

echo "==> Verifying youtube-transcript-api..."
python3 -c "from youtube_transcript_api import YouTubeTranscriptApi; print('youtube-transcript-api OK')"

echo "==> Downloading yt-dlp standalone binary..."
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o ./yt-dlp
chmod +x ./yt-dlp

echo "==> yt-dlp version:"
./yt-dlp --version

echo "==> Build complete!"
