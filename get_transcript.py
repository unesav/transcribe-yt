#!/usr/bin/env python3
"""
YouTube transcript extraction using youtube-transcript-api.
Called from Node.js via child_process.
Output: JSON to stdout.
"""
import sys
import json

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
        
        # Try to find the best transcript
        transcript = None
        selected_lang = None
        
        # Priority: 1) requested language manual, 2) requested language auto,
        # 3) any manual, 4) any auto
        if lang:
            try:
                transcript = transcript_list.find_transcript([lang])
                selected_lang = transcript.language_code
            except NoTranscriptFound:
                pass
        
        if transcript is None:
            # Try to find any manually created transcript
            try:
                for t in transcript_list:
                    if not t.is_generated:
                        transcript = t
                        selected_lang = t.language_code
                        break
            except Exception:
                pass
        
        if transcript is None:
            # Fall back to any generated transcript
            try:
                for t in transcript_list:
                    transcript = t
                    selected_lang = t.language_code
                    break
            except Exception:
                pass
        
        if transcript is None:
            print(json.dumps({"error": "CAPTIONS_UNAVAILABLE"}))
            sys.exit(1)
        
        # Fetch the transcript data
        fetched = transcript.fetch()
        segments = []
        for snippet in fetched:
            segments.append({
                "text": snippet.text.replace("\n", " ").strip(),
                "offset": snippet.start,
                "duration": snippet.duration,
            })
        
        result = {
            "transcript": segments,
            "language": selected_lang,
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
