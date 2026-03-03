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
            NoTranscriptFound,
            VideoUnavailable,
            NoTranscriptAvailable,
        )
    except ImportError:
        print(json.dumps({"error": "youtube-transcript-api not installed"}))
        sys.exit(1)
    
    try:
        api = YouTubeTranscriptApi()
        
        # List available transcripts
        transcript_list = api.list(video_id)
        
        # Collect all available transcripts
        manual_transcripts = []
        generated_transcripts = []
        
        for t in transcript_list:
            if t.is_generated:
                generated_transcripts.append(t)
            else:
                manual_transcripts.append(t)
        
        # Pick the best transcript with priority:
        # 1) Requested language (manual)
        # 2) Requested language (generated)
        # 3) Any manual transcript
        # 4) Any generated transcript
        transcript = None
        
        if lang:
            # Try exact match first
            for t in manual_transcripts:
                if t.language_code == lang:
                    transcript = t
                    break
            if not transcript:
                for t in generated_transcripts:
                    if t.language_code == lang:
                        transcript = t
                        break
            # Try prefix match (e.g., "fr" matches "fr-FR")
            if not transcript:
                for t in manual_transcripts:
                    if t.language_code.startswith(lang) or lang.startswith(t.language_code):
                        transcript = t
                        break
            if not transcript:
                for t in generated_transcripts:
                    if t.language_code.startswith(lang) or lang.startswith(t.language_code):
                        transcript = t
                        break
        
        # If no specific language found or none requested, take the first available
        if not transcript:
            if manual_transcripts:
                transcript = manual_transcripts[0]
            elif generated_transcripts:
                transcript = generated_transcripts[0]
        
        if transcript is None:
            print(json.dumps({"error": "CAPTIONS_UNAVAILABLE"}))
            sys.exit(1)
        
        # Fetch the transcript data
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
        
        result = {
            "transcript": segments,
            "language": transcript.language_code,
        }
        print(json.dumps(result))
        
    except TranscriptsDisabled:
        print(json.dumps({"error": "CAPTIONS_UNAVAILABLE"}))
        sys.exit(1)
    except VideoUnavailable:
        print(json.dumps({"error": "VIDEO_UNAVAILABLE"}))
        sys.exit(1)
    except NoTranscriptAvailable:
        print(json.dumps({"error": "CAPTIONS_UNAVAILABLE"}))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
