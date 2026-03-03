#!/usr/bin/env bash
# Render Build Script
# Installs Node.js dependencies, Python youtube-transcript-api, and yt-dlp

set -e

echo "==> Installing Node.js dependencies..."
npm install

echo "==> Installing Python youtube-transcript-api..."
pip install youtube-transcript-api

echo "==> Downloading yt-dlp standalone binary..."
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o ./yt-dlp
chmod +x ./yt-dlp

echo "==> yt-dlp version:"
./yt-dlp --version

echo "==> Python youtube-transcript-api version:"
python3 -c "import youtube_transcript_api; print(youtube_transcript_api.__version__)"

echo "==> Build complete!"
