"""
VoiceNotes PM - Whisper transcription service.

Supports two backends:
  1. Local / self-hosted Whisper (via LM Studio, etc.) — tried first if WHISPER_BASE_URL is set
  2. OpenAI Whisper API — used as fallback, or as primary if no local URL configured

Both backends use the OpenAI-compatible API format, so the same SDK works for both.
"""
import io
import logging
import time

import openai

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


def _get_local_client():
    """Create an OpenAI client pointed at the local Whisper endpoint."""
    if not Config.WHISPER_BASE_URL:
        return None
    return openai.OpenAI(
        api_key=Config.WHISPER_API_KEY,
        base_url=Config.WHISPER_BASE_URL,
        timeout=LOCAL_WHISPER_TIMEOUT,
    )


def _get_openai_client():
    """Create a standard OpenAI client."""
    return openai.OpenAI(api_key=Config.OPENAI_API_KEY)


def _transcribe_with_client(client, audio_bytes: bytes, file_format: str, model: str) -> str:
    """Send audio to a Whisper-compatible endpoint and return transcript text."""
    file_obj = NamedBytesIO(audio_bytes, name=f"audio.{file_format}")
    response = client.audio.transcriptions.create(
        model=model,
        file=file_obj,
    )
    return response.text.strip()


def transcribe_audio(audio_bytes: bytes, file_format: str = "webm") -> str:
    """
    Transcribe audio using Whisper.

    Strategy:
      1. If WHISPER_BASE_URL is configured, try the local/self-hosted endpoint first.
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
    local_client = _get_local_client()
    if local_client:
        try:
            logger.info("Trying local Whisper (%.1f MB)...", size_mb)
            start = time.time()
            text = _transcribe_with_client(
                local_client, audio_bytes, file_format,
                model="whisper-large-v3-turbo",
            )
            elapsed = time.time() - start
            logger.info("Local Whisper succeeded in %.1fs.", elapsed)
            return text
        except Exception as exc:
            logger.warning("Local Whisper failed (%.1f MB): %s. Falling back to OpenAI.", size_mb, exc)

    # --- Fallback: OpenAI Whisper API ---
    logger.info("Using OpenAI Whisper (%.1f MB)...", size_mb)
    openai_client = _get_openai_client()

    # For streaming chunks (< 24 MB), send directly
    if len(audio_bytes) <= WHISPER_MAX_BYTES:
        start = time.time()
        text = _transcribe_with_client(openai_client, audio_bytes, file_format, model="whisper-1")
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
        text = _transcribe_with_client(openai_client, chunk, file_format, model="whisper-1")
        transcripts.append(text)

    return "\n\n".join(transcripts)
