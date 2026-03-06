"""
VoiceNotes PM - Speaker Diarization Service

Uses pyannote.audio for speaker diarization and whisper.cpp for transcription.
Merges the results to produce speaker-labeled transcripts.

Tuned for Google Meet calls recorded through MacBook speakers.
Designed to run on the same Mac as whisper.cpp and LM Studio.
"""

import logging
import os
import subprocess
import tempfile
import time

import requests
import torch

logger = logging.getLogger(__name__)

# Will be initialized lazily on first use
_pipeline = None
_pipeline_loading = False


def _get_pipeline():
    """Load the pyannote speaker diarization pipeline (lazy, cached)."""
    global _pipeline, _pipeline_loading

    if _pipeline is not None:
        return _pipeline

    if _pipeline_loading:
        # Another thread is loading, wait
        while _pipeline_loading:
            time.sleep(0.5)
        return _pipeline

    _pipeline_loading = True

    hf_token = os.environ.get("HF_TOKEN", "")
    if not hf_token:
        logger.error("HF_TOKEN not set. Cannot load pyannote pipeline.")
        _pipeline_loading = False
        return None

    try:
        from pyannote.audio import Pipeline

        logger.info("Loading pyannote speaker-diarization-3.1 pipeline...")
        start = time.time()

        pipeline = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-3.1",
            token=hf_token,
        )

        # Tune for Google Meet calls recorded through MacBook speakers:
        # - Higher min_duration_off = merge short pauses from echo/reverb
        # - Lower clustering threshold = better speaker separation
        # - Higher min_cluster_size = ignore tiny spurious speaker clusters from echo
        pipeline.instantiate({
            "segmentation": {
                "min_duration_off": 0.8,
            },
            "clustering": {
                "method": "centroid",
                "min_cluster_size": 20,
                "threshold": 0.65,
            },
        })
        logger.info("Pipeline tuned for meeting audio (laptop speaker recording)")

        # Use MPS if available (Apple Silicon), else CPU
        if torch.backends.mps.is_available():
            logger.info("Using Apple MPS (Metal) for pyannote")
            pipeline.to(torch.device("mps"))
        else:
            logger.info("Using CPU for pyannote")

        elapsed = time.time() - start
        logger.info("pyannote pipeline loaded in %.1fs", elapsed)
        _pipeline = pipeline
        return _pipeline

    except Exception as exc:
        logger.error("Failed to load pyannote pipeline: %s", exc)
        return None
    finally:
        _pipeline_loading = False


def _preprocess_audio(wav_path: str) -> str:
    """
    Preprocess audio for optimal diarization of laptop-recorded meeting audio.

    Applies:
    - High-pass filter at 80Hz (remove room rumble)
    - Low-pass filter at 8kHz (remove hiss, speech is below this)
    - Loudness normalization (EBU R128)

    Returns path to the preprocessed file (caller must delete).
    """
    preprocessed_path = wav_path.replace(".wav", "_preprocessed.wav")
    try:
        subprocess.run(
            [
                "ffmpeg", "-y", "-i", wav_path,
                "-ar", "16000",
                "-ac", "1",
                "-c:a", "pcm_s16le",
                "-af", "highpass=f=80,lowpass=f=8000,loudnorm",
                preprocessed_path,
            ],
            capture_output=True,
            timeout=120,
            check=True,
        )
        logger.info("Audio preprocessed: highpass+lowpass+loudnorm")
        return preprocessed_path
    except Exception as exc:
        logger.warning("Audio preprocessing failed (%s), using original", exc)
        return wav_path


def diarize_audio(wav_bytes: bytes, min_speakers: int = None, max_speakers: int = None) -> list[dict]:
    """
    Run speaker diarization on WAV audio.

    Args:
        wav_bytes: Raw WAV audio bytes.
        min_speakers: Minimum expected speakers (hint for clustering).
        max_speakers: Maximum expected speakers (hint for clustering).

    Returns a list of segments:
    [
        {"start": 0.0, "end": 3.5, "speaker": "SPEAKER_00"},
        {"start": 3.5, "end": 8.2, "speaker": "SPEAKER_01"},
        ...
    ]
    """
    pipeline = _get_pipeline()
    if pipeline is None:
        return []

    # Write WAV to temp file (pyannote needs a file path)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp.write(wav_bytes)
        tmp_path = tmp.name

    # Preprocess audio for better results with laptop recordings
    preprocessed_path = _preprocess_audio(tmp_path)

    try:
        start = time.time()

        # Build inference kwargs with speaker hints
        kwargs = {}
        if min_speakers is not None:
            kwargs["min_speakers"] = min_speakers
        if max_speakers is not None:
            kwargs["max_speakers"] = max_speakers

        if kwargs:
            logger.info("Diarization hints: %s", kwargs)

        result = pipeline(preprocessed_path, **kwargs)
        elapsed = time.time() - start

        # pyannote 4.x returns DiarizeOutput; extract the Annotation
        diarization = getattr(result, "speaker_diarization", result)

        # Post-process: remove very short segments (echo artifacts)
        segments = []
        for turn, _, speaker in diarization.itertracks(yield_label=True):
            duration = turn.end - turn.start
            if duration < 0.3:
                continue  # Skip sub-300ms segments (likely echo/noise)
            segments.append({
                "start": round(turn.start, 2),
                "end": round(turn.end, 2),
                "speaker": speaker,
            })

        # Post-process: merge same-speaker segments with small gaps
        merged = []
        for seg in segments:
            if merged and merged[-1]["speaker"] == seg["speaker"]:
                gap = seg["start"] - merged[-1]["end"]
                if gap < 1.0:
                    # Merge into previous segment
                    merged[-1]["end"] = seg["end"]
                    continue
            merged.append(dict(seg))

        logger.info(
            "Diarization: %.1fs audio → %d segments (%d raw), %d speakers in %.1fs",
            merged[-1]["end"] if merged else 0,
            len(merged),
            len(segments),
            len(set(s["speaker"] for s in merged)),
            elapsed,
        )
        return merged

    finally:
        os.unlink(tmp_path)
        if preprocessed_path != tmp_path:
            os.unlink(preprocessed_path)


def _is_hallucination(text: str) -> bool:
    """
    Detect whisper hallucination patterns: repeated phrases, filler loops, etc.
    Whisper tends to get stuck repeating the same phrase dozens of times.
    """
    if not text or len(text) < 20:
        return False

    # Split into sentences/phrases
    import re
    phrases = re.split(r'[.!?]+', text.strip())
    phrases = [p.strip() for p in phrases if p.strip()]

    if len(phrases) < 3:
        return False

    # Check if 60%+ of phrases are identical (hallucination loop)
    from collections import Counter
    counts = Counter(phrases)
    most_common_count = counts.most_common(1)[0][1]
    if most_common_count >= max(3, len(phrases) * 0.5):
        return True

    # Check for very short repeated phrases ("I'm gonna do it" loop)
    words = text.split()
    if len(words) > 20:
        # Sliding window: check if any 4-word phrase repeats 5+ times
        ngrams = [' '.join(words[i:i+4]) for i in range(len(words) - 3)]
        ngram_counts = Counter(ngrams)
        top_count = ngram_counts.most_common(1)[0][1]
        if top_count >= 5 and top_count > len(ngrams) * 0.15:
            return True

    return False


def _deduplicate_segment(text: str) -> str:
    """
    If a segment contains repeated phrases (mild hallucination),
    keep only unique phrases in order.
    """
    import re
    phrases = re.split(r'(?<=[.!?])\s+', text.strip())
    if len(phrases) < 4:
        return text

    seen = set()
    deduped = []
    for phrase in phrases:
        normalized = phrase.strip().lower()
        if normalized not in seen:
            seen.add(normalized)
            deduped.append(phrase)

    return ' '.join(deduped)


def transcribe_with_timestamps(wav_bytes: bytes, whisper_url: str) -> list[dict]:
    """
    Transcribe audio using whisper.cpp with timestamps.

    Returns a list of segments:
    [
        {"start": 0, "end": 3500, "text": "Hello everyone"},
        ...
    ]
    Times are in milliseconds.
    """
    # Request verbose JSON from whisper.cpp for timestamps
    files = {"file": ("audio.wav", wav_bytes, "audio/wav")}
    data = {
        "response_format": "verbose_json",
        # Anti-hallucination: prevent the model from conditioning on its own
        # looping output. This is the single most effective fix for the
        # "I'm not gonna be a good one" repetition bug.
        "no_context": "true",
    }

    response = requests.post(
        f"{whisper_url}/inference",
        files=files,
        data=data,
        timeout=600,
    )
    response.raise_for_status()
    result = response.json()

    # whisper.cpp verbose_json returns segments with offsets
    # Each segment has: t0 (start ms), t1 (end ms), text
    raw_segments = []
    if isinstance(result, list):
        # Array of segments
        for seg in result:
            raw_segments.append({
                "start": seg.get("t0", seg.get("start", 0)),
                "end": seg.get("t1", seg.get("end", 0)),
                "text": seg.get("text", "").strip(),
            })
    elif isinstance(result, dict):
        # Might have a "segments" key or "text" with timestamps
        if "segments" in result:
            for seg in result["segments"]:
                raw_segments.append({
                    "start": seg.get("t0", seg.get("start", 0)),
                    "end": seg.get("t1", seg.get("end", 0)),
                    "text": seg.get("text", "").strip(),
                })
        elif "text" in result:
            # Fallback: single text block, no timestamps
            raw_segments.append({
                "start": 0,
                "end": 0,
                "text": result["text"].strip(),
            })

    # Post-process: detect and handle hallucinated segments
    segments = []
    hallucination_count = 0
    for seg in raw_segments:
        text = seg.get("text", "")
        if not text:
            continue
        if _is_hallucination(text):
            hallucination_count += 1
            logger.warning(
                "Hallucination detected (%.0f-%.0fms): '%s'",
                seg.get("start", 0), seg.get("end", 0), text[:80] + "..."
            )
            # Skip entirely — hallucinated segments have no real content
            continue

        # Mild deduplication for segments with some repetition
        seg["text"] = _deduplicate_segment(text)
        segments.append(seg)

    if hallucination_count:
        logger.info("Removed %d hallucinated segments from transcript", hallucination_count)

    return segments


def merge_diarization_and_transcript(
    speaker_segments: list[dict],
    transcript_segments: list[dict],
) -> str:
    """
    Merge pyannote speaker segments with whisper transcript segments.

    For each transcript segment, find which speaker is talking based on
    timestamp overlap. Produces a clean, speaker-labeled transcript.
    """
    if not speaker_segments:
        # No diarization available, return plain transcript
        return "\n".join(s["text"] for s in transcript_segments if s.get("text"))

    if not transcript_segments:
        return ""

    def find_speaker(start_ms: float, end_ms: float) -> str:
        """Find the speaker with the most overlap for a given time range."""
        start_s = start_ms / 1000.0 if start_ms > 100 else start_ms
        end_s = end_ms / 1000.0 if end_ms > 100 else end_ms

        best_speaker = "Unknown"
        best_overlap = 0

        for seg in speaker_segments:
            overlap_start = max(start_s, seg["start"])
            overlap_end = min(end_s, seg["end"])
            overlap = max(0, overlap_end - overlap_start)

            if overlap > best_overlap:
                best_overlap = overlap
                best_speaker = seg["speaker"]

        return best_speaker

    # Build speaker-labeled lines
    lines = []
    current_speaker = None
    current_text_parts = []

    # Create a mapping from raw speaker IDs to friendly names
    speaker_map = {}
    speaker_counter = 1

    for seg in transcript_segments:
        text = seg.get("text", "").strip()
        if not text:
            continue

        speaker_id = find_speaker(seg.get("start", 0), seg.get("end", 0))

        if speaker_id not in speaker_map:
            speaker_map[speaker_id] = f"Speaker {speaker_counter}"
            speaker_counter += 1

        friendly_name = speaker_map[speaker_id]

        if friendly_name != current_speaker:
            # New speaker - flush current
            if current_speaker and current_text_parts:
                lines.append(f"{current_speaker}: {' '.join(current_text_parts)}")
            current_speaker = friendly_name
            current_text_parts = [text]
        else:
            current_text_parts.append(text)

    # Flush last speaker
    if current_speaker and current_text_parts:
        lines.append(f"{current_speaker}: {' '.join(current_text_parts)}")

    return "\n\n".join(lines)


def diarize_and_transcribe(
    wav_bytes: bytes,
    whisper_url: str,
    min_speakers: int = None,
    max_speakers: int = None,
) -> str:
    """
    Full pipeline: diarize + transcribe + merge.

    Runs pyannote and whisper.cpp in sequence (both are compute-intensive,
    running in parallel on the same machine wouldn't help much).

    Args:
        wav_bytes: Raw WAV audio bytes.
        whisper_url: URL of the whisper.cpp server.
        min_speakers: Minimum expected speakers (hint).
        max_speakers: Maximum expected speakers (hint).

    Returns a speaker-labeled transcript string.
    """
    start = time.time()

    # Step 1: Diarize (who is speaking when)
    speaker_segments = diarize_audio(wav_bytes, min_speakers=min_speakers, max_speakers=max_speakers)

    # Step 2: Transcribe with timestamps (what is being said)
    transcript_segments = transcribe_with_timestamps(wav_bytes, whisper_url)

    # Step 3: Merge
    result = merge_diarization_and_transcript(speaker_segments, transcript_segments)

    elapsed = time.time() - start
    n_speakers = len(set(s["speaker"] for s in speaker_segments)) if speaker_segments else 0
    logger.info(
        "Full diarize+transcribe pipeline: %.1fs, %d speakers detected",
        elapsed, n_speakers,
    )

    return result
