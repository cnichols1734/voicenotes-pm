"""
VoiceNotes PM - Whisper transcription service.
Sends audio to OpenAI Whisper API and returns the transcript text.
"""
import io
import logging

import openai

from config import Config
from services.audio_processing import chunk_audio_raw, chunk_audio_pydub

logger = logging.getLogger(__name__)

# Whisper API limit is 25MB; use 24MB as a safe ceiling
WHISPER_MAX_BYTES = 24 * 1024 * 1024  # 24 MB


class NamedBytesIO(io.BytesIO):
    """BytesIO subclass that carries a filename attribute for the OpenAI SDK."""

    def __init__(self, data: bytes, name: str):
        super().__init__(data)
        self.name = name


def transcribe_audio(audio_bytes: bytes, file_format: str = "webm") -> str:
    """
    Transcribe audio using OpenAI Whisper API.

    Accepts raw audio bytes and format string (e.g. 'webm').
    If audio exceeds 24 MB, chunks it using fast raw byte splitting
    (falls back to pydub if raw splitting fails at the Whisper API level).

    Returns the full transcript as a single string.
    """
    if len(audio_bytes) < 1000:
        raise ValueError("Recording too short (under 1 KB). Please record at least a few seconds.")

    client = openai.OpenAI(api_key=Config.OPENAI_API_KEY)

    if len(audio_bytes) > WHISPER_MAX_BYTES:
        logger.info(
            "Audio is %.1f MB, chunking before transcription.",
            len(audio_bytes) / (1024 * 1024),
        )
        # Try fast raw byte split first (no ffmpeg, instant)
        chunks = chunk_audio_raw(audio_bytes, max_chunk_mb=24)
        use_raw = True
    else:
        chunks = [audio_bytes]
        use_raw = False

    transcripts = []
    for idx, chunk in enumerate(chunks):
        logger.info("Transcribing chunk %d / %d (%.1f MB)...", idx + 1, len(chunks), len(chunk) / (1024 * 1024))
        file_obj = NamedBytesIO(chunk, name=f"audio_{idx}.{file_format}")
        try:
            response = client.audio.transcriptions.create(
                model="whisper-1",
                file=file_obj,
            )
            transcripts.append(response.text.strip())
        except Exception as exc:
            if use_raw and idx == 0:
                # Raw byte split didn't work for this codec; fall back to pydub
                logger.warning(
                    "Raw byte split failed at Whisper API (chunk %d): %s. "
                    "Falling back to pydub chunking.",
                    idx, exc,
                )
                chunks = chunk_audio_pydub(audio_bytes, file_format=file_format)
                # Restart transcription with properly-encoded chunks
                transcripts = []
                for j, pydub_chunk in enumerate(chunks):
                    logger.info("Transcribing pydub chunk %d / %d...", j + 1, len(chunks))
                    pydub_file = NamedBytesIO(pydub_chunk, name=f"audio_{j}.{file_format}")
                    resp = client.audio.transcriptions.create(
                        model="whisper-1",
                        file=pydub_file,
                    )
                    transcripts.append(resp.text.strip())
                break
            else:
                raise

    return "\n\n".join(transcripts)
