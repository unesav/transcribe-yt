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
            VideoUnavailable,
        )
    except ImportError as ie:
        sys.stderr.write(f"ImportError: {ie}\n")
        print(json.dumps({"error": "youtube-transcript-api not installed"}))
        sys.exit(1)
    
    try:
        # Use default session (no custom headers that break parsing)
        api = YouTubeTranscriptApi()
        transcript_list = api.list(video_id)
        
        manual = []
        generated = []
        for t in transcript_list:
            if t.is_generated:
                generated.append(t)
            else:
                manual.append(t)
        
        # Pick best transcript
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
            print(json.dumps({"error": "CAPTIONS_UNAVAILABLE"}))
            sys.exit(1)
        
        fetched = transcript.fetch()
        segments = []
        for s in fetched:
            text = s.text.replace("\n", " ").strip()
            if text:
                segments.append({"text": text, "offset": s.start, "duration": s.duration})
        
        print(json.dumps({"transcript": segments, "language": transcript.language_code}))
        
    except TranscriptsDisabled:
        print(json.dumps({"error": "CAPTIONS_UNAVAILABLE"}))
        sys.exit(1)
    except VideoUnavailable:
        print(json.dumps({"error": "VIDEO_UNAVAILABLE"}))
        sys.exit(1)
    except Exception as e:
        sys.stderr.write(f"Error: {e}\n")
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
