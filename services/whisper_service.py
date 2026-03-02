"""
VoiceNotes PM - Whisper transcription service.
Sends audio to OpenAI Whisper API and returns the transcript text.
"""
import io
import logging

import openai

from config import Config
from services.audio_processing import chunk_audio

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
    Chunks the audio if it exceeds 24 MB, then sends each chunk
    to Whisper and concatenates the results.

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
        chunks = chunk_audio(audio_bytes, file_format=file_format)
    else:
        chunks = [audio_bytes]

    transcripts = []
    for idx, chunk in enumerate(chunks):
        logger.info("Transcribing chunk %d / %d...", idx + 1, len(chunks))
        file_obj = NamedBytesIO(chunk, name=f"audio_{idx}.{file_format}")
        response = client.audio.transcriptions.create(
            model="whisper-1",
            file=file_obj,
        )
        transcripts.append(response.text.strip())

    return "\n\n".join(transcripts)
