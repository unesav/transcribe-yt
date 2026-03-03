#!/usr/bin/env bash
# Render Build Script
# Installs Node.js dependencies and downloads yt-dlp standalone binary

set -e

echo "==> Installing Node.js dependencies..."
npm install

echo "==> Downloading yt-dlp standalone binary..."
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o ./yt-dlp
chmod +x ./yt-dlp

echo "==> yt-dlp version:"
./yt-dlp --version

echo "==> Build complete!"
