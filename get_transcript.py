#!/usr/bin/env python3
"""
YouTube transcript extraction using youtube-transcript-api.
Called from Node.js via child_process.
Output: JSON to stdout.
"""
import sys
import os
import json

# Add local python_libs to path (installed by build.sh on Render)
_libs_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'python_libs')
if os.path.isdir(_libs_dir) and _libs_dir not in sys.path:
    sys.path.insert(0, _libs_dir)

# Cloudflare Worker proxy URL for bypassing YouTube IP blocks
PROXY_URL = "https://yt-transcript-proxy.transcribeyoutubevideo.workers.dev"

def create_proxied_session():
    """Create a requests.Session that routes YouTube requests through CF Worker."""
    import requests
    from urllib.parse import quote
    
    class ProxiedAdapter(requests.adapters.HTTPAdapter):
        def send(self, request, **kwargs):
            original_url = request.url
            # Route YouTube requests through our CF Worker proxy
            if "youtube.com" in original_url or "youtu.be" in original_url:
                request.url = PROXY_URL + "/?url=" + quote(original_url, safe='')
            return super().send(request, **kwargs)
    
    session = requests.Session()
    session.mount("https://", ProxiedAdapter())
    session.mount("http://", ProxiedAdapter())
    return session

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Missing video_id"}))
        sys.exit(1)
    
    video_id = sys.argv[1]
    lang = sys.argv[2] if len(sys.argv) > 2 else None
    
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
        from youtube_transcript_api._errors import (
            TranscriptsDisabled,
            NoTranscriptFound,
            VideoUnavailable,
        )
    except ImportError as ie:
        sys.stderr.write(f"ImportError: {ie}\n")
        print(json.dumps({"error": "youtube-transcript-api not installed"}))
        sys.exit(1)
    
    try:
        # Try direct first (works for manual subtitles on any IP)
        api_direct = YouTubeTranscriptApi()
        result = try_fetch(api_direct, video_id, lang)
        if result:
            print(json.dumps(result))
            return
    except Exception as e:
        sys.stderr.write(f"Direct attempt failed: {e}\n")
    
    try:
        # Fall back to proxied session for IP-blocked requests
        session = create_proxied_session()
        api_proxied = YouTubeTranscriptApi(http_client=session)
        result = try_fetch(api_proxied, video_id, lang)
        if result:
            print(json.dumps(result))
            return
    except Exception as e:
        sys.stderr.write(f"Proxied attempt failed: {e}\n")
    
    print(json.dumps({"error": "CAPTIONS_UNAVAILABLE"}))
    sys.exit(1)

def try_fetch(api, video_id, lang):
    """Try fetching transcript with the given API instance. Returns dict or None."""
    try:
        transcript_list = api.list(video_id)
    except Exception:
        return None
    
    manual_transcripts = []
    generated_transcripts = []
    
    for t in transcript_list:
        if t.is_generated:
            generated_transcripts.append(t)
        else:
            manual_transcripts.append(t)
    
    # Pick best transcript
    transcript = None
    
    if lang:
        for t in manual_transcripts:
            if t.language_code == lang:
                transcript = t; break
        if not transcript:
            for t in generated_transcripts:
                if t.language_code == lang:
                    transcript = t; break
        if not transcript:
            for t in manual_transcripts:
                if t.language_code.startswith(lang) or lang.startswith(t.language_code):
                    transcript = t; break
        if not transcript:
            for t in generated_transcripts:
                if t.language_code.startswith(lang) or lang.startswith(t.language_code):
                    transcript = t; break
    
    if not transcript:
        if manual_transcripts:
            transcript = manual_transcripts[0]
        elif generated_transcripts:
            transcript = generated_transcripts[0]
    
    if transcript is None:
        return None
    
    fetched = transcript.fetch()
    segments = []
    for snippet in fetched:
        text = snippet.text.replace("\n", " ").strip()
        if text:
            segments.append({
                "text": text,
                "offset": snippet.start,
                "duration": snippet.duration,
            })
    
    if not segments:
        return None
    
    return {
        "transcript": segments,
        "language": transcript.language_code,
    }

if __name__ == "__main__":
    main()
