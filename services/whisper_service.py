"""
VoiceNotes PM - Whisper transcription service.

Supports two backends:
  1. Local whisper.cpp server — tried first if WHISPER_BASE_URL is set
  2. OpenAI Whisper API — used as fallback, or as primary if no local URL configured

Returns segment-level timestamped data (list of dicts with start/end/text)
for synchronized transcript playback.
"""
import io
import logging
import time

import openai
import requests

from config import Config

logger = logging.getLogger(__name__)

WHISPER_MAX_BYTES = 24 * 1024 * 1024  # 24 MB

LOCAL_WHISPER_TIMEOUT = 120


class NamedBytesIO(io.BytesIO):
    """BytesIO subclass that carries a filename attribute for the OpenAI SDK."""

    def __init__(self, data: bytes, name: str):
        super().__init__(data)
        self.name = name


def segments_to_text(segments: list) -> str:
    """Join segment dicts into a plain-text transcript string."""
    return "\n\n".join(seg["text"] for seg in segments if seg.get("text"))


def _convert_to_wav(audio_bytes: bytes, file_format: str) -> bytes:
    """
    Convert audio to 16kHz mono WAV using ffmpeg.
    whisper.cpp needs WAV format since it was built without FFmpeg support.
    """
    import subprocess
    import tempfile
    import os

    with tempfile.NamedTemporaryFile(suffix=f".{file_format}", delete=False) as tmp_in:
        tmp_in.write(audio_bytes)
        tmp_in_path = tmp_in.name

    tmp_out_path = tmp_in_path.rsplit(".", 1)[0] + ".wav"

    try:
        result = subprocess.run(
            [
                "ffmpeg", "-y", "-i", tmp_in_path,
                "-ar", "16000",
                "-ac", "1",
                "-c:a", "pcm_s16le",
                tmp_out_path,
            ],
            capture_output=True,
            timeout=120,
        )
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg conversion failed: {result.stderr.decode()[:200]}")

        with open(tmp_out_path, "rb") as f:
            wav_bytes = f.read()

        logger.info("Converted %s (%.1f KB) -> WAV (%.1f KB)",
                     file_format, len(audio_bytes) / 1024, len(wav_bytes) / 1024)
        return wav_bytes
    finally:
        os.unlink(tmp_in_path)
        if os.path.exists(tmp_out_path):
            os.unlink(tmp_out_path)


def _transcribe_local(audio_bytes: bytes, file_format: str) -> list:
    """
    Transcribe audio using a local whisper.cpp server.
    Returns a list of segment dicts [{start, end, text}, ...].
    """
    wav_bytes = _convert_to_wav(audio_bytes, file_format)

    base_url = Config.WHISPER_BASE_URL.rstrip("/")
    files = {
        "file": ("audio.wav", wav_bytes, "audio/wav"),
    }
    data = {
        "response_format": "verbose_json",
        "no_context": "true",
    }

    response = requests.post(
        f"{base_url}/inference",
        files=files,
        data=data,
        timeout=LOCAL_WHISPER_TIMEOUT,
    )
    response.raise_for_status()
    result = response.json()

    # whisper.cpp verbose_json returns segments with timestamps
    raw_segments = result.get("segments") or result.get("transcription") or []
    if raw_segments and isinstance(raw_segments[0], dict) and "start" in raw_segments[0]:
        segments = [
            {
                "start": float(s.get("t0", s.get("start", 0)) if isinstance(s.get("t0", s.get("start", 0)), (int, float)) else 0),
                "end": float(s.get("t1", s.get("end", 0)) if isinstance(s.get("t1", s.get("end", 0)), (int, float)) else 0),
                "text": (s.get("text") or "").strip(),
            }
            for s in raw_segments
            if (s.get("text") or "").strip()
        ]
        if segments:
            logger.info("Local Whisper returned %d segments.", len(segments))
            return segments

    # Fallback: plain text wrapped as a single segment
    text = result.get("text", "").strip()
    if not text and raw_segments:
        text = " ".join((s.get("text", "") if isinstance(s, dict) else str(s)) for s in raw_segments).strip()

    logger.info("Local Whisper returned plain text (no segments): '%s'", text[:100] if text else "(empty)")
    if text:
        return [{"start": 0.0, "end": 0.0, "text": text}]
    return []


def _transcribe_openai(audio_bytes: bytes, file_format: str) -> list:
    """
    Transcribe audio using OpenAI Whisper API with verbose_json.
    Returns a list of segment dicts [{start, end, text}, ...].
    """
    client = openai.OpenAI(api_key=Config.OPENAI_API_KEY)
    file_obj = NamedBytesIO(audio_bytes, name=f"audio.{file_format}")
    response = client.audio.transcriptions.create(
        model="whisper-1",
        file=file_obj,
        response_format="verbose_json",
        timestamp_granularities=["segment"],
    )

    raw_segments = getattr(response, "segments", None) or []
    segments = [
        {
            "start": round(float(s.start), 2),
            "end": round(float(s.end), 2),
            "text": s.text.strip(),
        }
        for s in raw_segments
        if s.text.strip()
    ]

    if segments:
        return segments

    # Fallback if API returned text but no segments
    text = getattr(response, "text", "").strip()
    if text:
        return [{"start": 0.0, "end": 0.0, "text": text}]
    return []


def transcribe_audio(audio_bytes: bytes, file_format: str = "webm") -> list:
    """
    Transcribe audio using Whisper.

    Returns a list of segment dicts: [{"start": float, "end": float, "text": str}, ...]

    Strategy:
      1. If WHISPER_BASE_URL is configured, try the local whisper.cpp server first.
      2. If local fails, fall back to OpenAI.
      3. If no local URL is configured, go straight to OpenAI.
      4. For files > 24MB, chunk with pydub and merge segments with cumulative offsets.
    """
    if len(audio_bytes) < 500:
        return []

    size_mb = len(audio_bytes) / (1024 * 1024)

    # --- Try local Whisper first ---
    if Config.WHISPER_BASE_URL:
        try:
            logger.info("Trying local Whisper at %s (%.1f MB)...", Config.WHISPER_BASE_URL, size_mb)
            start = time.time()
            segments = _transcribe_local(audio_bytes, file_format)
            elapsed = time.time() - start
            logger.info("Local Whisper succeeded in %.1fs (%d segments).", elapsed, len(segments))
            return segments
        except Exception as exc:
            logger.warning("Local Whisper failed (%.1f MB): %s. Falling back to OpenAI.", size_mb, exc)

    # --- Fallback: OpenAI Whisper API ---
    logger.info("Using OpenAI Whisper (%.1f MB)...", size_mb)

    if len(audio_bytes) <= WHISPER_MAX_BYTES:
        start = time.time()
        segments = _transcribe_openai(audio_bytes, file_format)
        elapsed = time.time() - start
        logger.info("OpenAI Whisper succeeded in %.1fs (%d segments).", elapsed, len(segments))
        return segments

    # Large file: chunk with pydub, merge segments with cumulative time offset
    logger.info("Audio exceeds 24 MB, using pydub chunking for OpenAI...")
    from pydub import AudioSegment
    from services.audio_processing import chunk_audio_pydub

    chunks = chunk_audio_pydub(audio_bytes, file_format=file_format)
    all_segments = []
    cumulative_offset = 0.0

    for idx, chunk in enumerate(chunks):
        logger.info("Transcribing pydub chunk %d / %d (%.1f MB)...",
                     idx + 1, len(chunks), len(chunk) / (1024 * 1024))
        segments = _transcribe_openai(chunk, file_format)
        for seg in segments:
            seg["start"] = round(seg["start"] + cumulative_offset, 2)
            seg["end"] = round(seg["end"] + cumulative_offset, 2)
        all_segments.extend(segments)

        chunk_audio_obj = AudioSegment.from_file(io.BytesIO(chunk), format=file_format)
        cumulative_offset += len(chunk_audio_obj) / 1000.0

    return all_segments
