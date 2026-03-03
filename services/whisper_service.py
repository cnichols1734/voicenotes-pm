"""
VoiceNotes PM - Whisper transcription service.

Supports two backends:
  1. Local whisper.cpp server — tried first if WHISPER_BASE_URL is set
  2. OpenAI Whisper API — used as fallback, or as primary if no local URL configured

The local backend uses whisper.cpp's /inference endpoint.
The OpenAI backend uses the standard /v1/audio/transcriptions endpoint.
"""
import io
import logging
import time

import openai
import requests

from config import Config

logger = logging.getLogger(__name__)

# Whisper API limit is 25MB; use 24MB as a safe ceiling
WHISPER_MAX_BYTES = 24 * 1024 * 1024  # 24 MB

# Timeout for local Whisper requests (seconds)
LOCAL_WHISPER_TIMEOUT = 120


class NamedBytesIO(io.BytesIO):
    """BytesIO subclass that carries a filename attribute for the OpenAI SDK."""

    def __init__(self, data: bytes, name: str):
        super().__init__(data)
        self.name = name


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
                "-ar", "16000",   # 16kHz sample rate (Whisper's native rate)
                "-ac", "1",       # mono
                "-c:a", "pcm_s16le",  # 16-bit PCM
                tmp_out_path,
            ],
            capture_output=True,
            timeout=30,
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


def _transcribe_local(audio_bytes: bytes, file_format: str, use_diarization: bool = True) -> str:
    """
    Transcribe audio using a local whisper.cpp server.
    Converts to WAV first (whisper.cpp needs WAV format).

    If use_diarization is True, sends to /diarize endpoint which returns
    speaker-labeled transcripts (e.g. "Speaker 1: Hello"). Falls back to
    /inference if /diarize fails.
    """
    # Convert to WAV — whisper.cpp can't decode webm/opus natively
    wav_bytes = _convert_to_wav(audio_bytes, file_format)

    base_url = Config.WHISPER_BASE_URL.rstrip("/")
    files = {
        "file": ("audio.wav", wav_bytes, "audio/wav"),
    }

    # Try diarization endpoint first for speaker-labeled transcription
    if use_diarization:
        try:
            response = requests.post(
                f"{base_url}/diarize",
                files=files,
                timeout=LOCAL_WHISPER_TIMEOUT,
            )
            response.raise_for_status()
            result = response.json()
            text = result.get("text", "").strip()
            if text:
                logger.info("Local diarize returned: '%s'", text[:100])
                return text
        except Exception as exc:
            logger.warning("Diarize endpoint failed (%s), falling back to /inference", exc)
            # Re-create files dict since requests consumes the BytesIO
            files = {"file": ("audio.wav", wav_bytes, "audio/wav")}

    # Fallback: plain transcription without speaker labels
    data = {
        "response_format": "json",
    }

    response = requests.post(
        f"{base_url}/inference",
        files=files,
        data=data,
        timeout=LOCAL_WHISPER_TIMEOUT,
    )
    response.raise_for_status()
    result = response.json()
    text = result.get("text", "").strip()
    logger.info("Local Whisper returned: '%s'", text[:100] if text else "(empty)")
    return text


def _transcribe_openai(audio_bytes: bytes, file_format: str) -> str:
    """Transcribe audio using OpenAI Whisper API."""
    client = openai.OpenAI(api_key=Config.OPENAI_API_KEY)
    file_obj = NamedBytesIO(audio_bytes, name=f"audio.{file_format}")
    response = client.audio.transcriptions.create(
        model="whisper-1",
        file=file_obj,
    )
    return response.text.strip()


def transcribe_audio(audio_bytes: bytes, file_format: str = "webm") -> str:
    """
    Transcribe audio using Whisper.

    Strategy:
      1. If WHISPER_BASE_URL is configured, try the local whisper.cpp server first.
      2. If local fails (connection error, timeout, etc.), fall back to OpenAI.
      3. If no local URL is configured, go straight to OpenAI.

    With streaming transcription, each chunk is typically ~60s of audio (< 2 MB),
    so chunking is rarely needed. The chunking logic is kept as a safety net for
    the legacy upload path.

    Returns the full transcript as a single string.
    """
    if len(audio_bytes) < 500:
        return ""

    size_mb = len(audio_bytes) / (1024 * 1024)

    # --- Try local Whisper first ---
    if Config.WHISPER_BASE_URL:
        try:
            logger.info("Trying local Whisper at %s (%.1f MB)...", Config.WHISPER_BASE_URL, size_mb)
            start = time.time()
            text = _transcribe_local(audio_bytes, file_format)
            elapsed = time.time() - start
            logger.info("Local Whisper succeeded in %.1fs.", elapsed)
            return text
        except Exception as exc:
            logger.warning("Local Whisper failed (%.1f MB): %s. Falling back to OpenAI.", size_mb, exc)

    # --- Fallback: OpenAI Whisper API ---
    logger.info("Using OpenAI Whisper (%.1f MB)...", size_mb)

    # For streaming chunks (< 24 MB), send directly
    if len(audio_bytes) <= WHISPER_MAX_BYTES:
        start = time.time()
        text = _transcribe_openai(audio_bytes, file_format)
        elapsed = time.time() - start
        logger.info("OpenAI Whisper succeeded in %.1fs.", elapsed)
        return text

    # Legacy path: large file from non-streaming upload — chunk it with pydub
    logger.info("Audio exceeds 24 MB, using pydub chunking for OpenAI...")
    from services.audio_processing import chunk_audio_pydub

    chunks = chunk_audio_pydub(audio_bytes, file_format=file_format)
    transcripts = []
    for idx, chunk in enumerate(chunks):
        logger.info("Transcribing pydub chunk %d / %d (%.1f MB)...", idx + 1, len(chunks), len(chunk) / (1024 * 1024))
        text = _transcribe_openai(chunk, file_format)
        transcripts.append(text)

    return "\n\n".join(transcripts)
