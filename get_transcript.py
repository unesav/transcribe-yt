#!/usr/bin/env python3
"""
YouTube transcript extraction using youtube-transcript-api.
Called from Node.js via child_process.
Output: JSON to stdout.

Strategy:
1. Try direct youtube-transcript-api (works if YouTube doesn't block IP)
2. If IP blocked: get captionTracks via CF Worker, fetch timedtext directly
"""
import sys
import os
import json

# Add local python_libs to path (installed by build.sh on Render)
_libs_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'python_libs')
if os.path.isdir(_libs_dir) and _libs_dir not in sys.path:
    sys.path.insert(0, _libs_dir)

CF_WORKER_URL = "https://yt-transcript-proxy.transcribeyoutubevideo.workers.dev"

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Missing video_id"}))
        sys.exit(1)
    
    video_id = sys.argv[1]
    lang = sys.argv[2] if len(sys.argv) > 2 else None
    
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
    except ImportError as ie:
        sys.stderr.write(f"ImportError: {ie}\n")
        print(json.dumps({"error": "youtube-transcript-api not installed"}))
        sys.exit(1)
    
    errors = []
    
    # Strategy 1: Direct youtube-transcript-api
    try:
        api = YouTubeTranscriptApi()
        result = try_fetch(api, video_id, lang)
        if result and result.get("transcript"):
            print(json.dumps(result))
            return
        errors.append("direct: no segments")
    except Exception as e:
        err_str = str(e)
        errors.append(f"direct: {err_str[:100]}")
        sys.stderr.write(f"Direct failed: {err_str[:200]}\n")
    
    # Strategy 2: Get tracks from CF Worker, fetch timedtext directly
    try:
        result = fetch_via_cf_tracks(video_id, lang)
        if result and result.get("transcript"):
            print(json.dumps(result))
            return
        errors.append("cf-tracks: no segments")
    except Exception as e:
        errors.append(f"cf-tracks: {e}")
        sys.stderr.write(f"CF tracks failed: {e}\n")
    
    sys.stderr.write(f"All strategies failed: {'; '.join(errors)}\n")
    print(json.dumps({"error": "CAPTIONS_UNAVAILABLE"}))
    sys.exit(1)


def fetch_via_cf_tracks(video_id, lang):
    """
    Get captionTracks from CF Worker (bypasses IP block on page),
    then fetch timedtext content directly with requests (different TLS fingerprint).
    """
    import requests
    from xml.etree import ElementTree
    
    # Step 1: Get tracks + session cookies from CF Worker
    resp = requests.get(f"{CF_WORKER_URL}/", params={"videoId": video_id, "mode": "tracks"}, timeout=15)
    resp.raise_for_status()
    data = resp.json()
    
    if "error" in data:
        raise Exception(data["error"])
    
    tracks = data.get("tracks", [])
    yt_cookies = data.get("cookies", "")  # YouTube session cookies from CF Worker
    if not tracks:
        raise Exception("No tracks found")
    
    # Pick best track
    manual = [t for t in tracks if t.get("kind") != "asr"]
    auto = [t for t in tracks if t.get("kind") == "asr"]
    
    selected = None
    if lang:
        selected = next((t for t in manual if t["languageCode"] == lang), None)
        if not selected:
            selected = next((t for t in auto if t["languageCode"] == lang), None)
        if not selected:
            selected = next((t for t in manual if t["languageCode"].startswith(lang)), None)
        if not selected:
            selected = next((t for t in auto if t["languageCode"].startswith(lang)), None)
    
    if not selected:
        selected = (manual[0] if manual else auto[0]) if (manual or auto) else None
    
    if not selected:
        raise Exception("No matching track")
    
    # Step 2: Fetch timedtext WITH the YouTube session cookies from CF Worker
    base_url = selected["baseUrl"].replace("&fmt=srv3", "")
    
    session = requests.Session()
    session.headers.update({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.5',
        'Cookie': yt_cookies,  # Forward YouTube cookies from CF Worker session
    })
    
    tt_resp = session.get(base_url, timeout=15)
    tt_resp.raise_for_status()
    xml_text = tt_resp.text
    
    if not xml_text or len(xml_text.strip()) == 0:
        # Try json3 format
        j3_resp = session.get(base_url + "&fmt=json3", timeout=15)
        j3_text = j3_resp.text
        if j3_text and len(j3_text.strip()) > 0:
            j3 = json.loads(j3_text)
            return parse_json3(j3, selected["languageCode"])
        raise Exception("Timedtext returned empty")
    
    # Parse XML
    return parse_xml(xml_text, selected["languageCode"])


def parse_xml(xml_text, language_code):
    from xml.etree import ElementTree
    from html import unescape
    
    root = ElementTree.fromstring(xml_text)
    segments = []
    for text_elem in root.findall('.//text'):
        start = float(text_elem.get('start', '0'))
        dur = float(text_elem.get('dur', '0'))
        content = text_elem.text or ''
        content = unescape(content).replace('\n', ' ').strip()
        if content:
            segments.append({"text": content, "offset": start, "duration": dur})
    
    return {"transcript": segments, "language": language_code}


def parse_json3(j3, language_code):
    segments = []
    for event in j3.get("events", []):
        segs = event.get("segs")
        if not segs:
            continue
        text = ''.join(s.get('utf8', '') for s in segs).replace('\n', ' ').strip()
        if text:
            segments.append({
                "text": text,
                "offset": (event.get("tStartMs", 0)) / 1000,
                "duration": (event.get("dDurationMs", 0)) / 1000,
            })
    return {"transcript": segments, "language": language_code}


def try_fetch(api, video_id, lang):
    """Try fetching transcript with the given API instance."""
    transcript_list = api.list(video_id)
    
    manual = []
    generated = []
    for t in transcript_list:
        if t.is_generated:
            generated.append(t)
        else:
            manual.append(t)
    
    transcript = None
    if lang:
        for t in manual:
            if t.language_code == lang:
                transcript = t; break
        if not transcript:
            for t in generated:
                if t.language_code == lang:
                    transcript = t; break
        if not transcript:
            for t in manual:
                if t.language_code.startswith(lang) or lang.startswith(t.language_code):
                    transcript = t; break
        if not transcript:
            for t in generated:
                if t.language_code.startswith(lang) or lang.startswith(t.language_code):
                    transcript = t; break
    
    if not transcript:
        transcript = manual[0] if manual else (generated[0] if generated else None)
    
    if transcript is None:
        return None
    
    fetched = transcript.fetch()
    segments = []
    for s in fetched:
        text = s.text.replace("\n", " ").strip()
        if text:
            segments.append({"text": text, "offset": s.start, "duration": s.duration})
    
    return {"transcript": segments, "language": transcript.language_code} if segments else None


if __name__ == "__main__":
    main()
