"""
VoiceNotes PM - Audio chunking service.
Splits large audio files into smaller chunks for Whisper API.
Requires ffmpeg to be installed (available on Railway via nixpacks).
"""
import io
import logging
import math

logger = logging.getLogger(__name__)


def _check_ffmpeg():
    """Verify that ffmpeg is available on the system PATH."""
    import shutil
    if shutil.which("ffmpeg") is None:
        raise RuntimeError(
            "ffmpeg is not installed or not on PATH. "
            "Install it with: brew install ffmpeg (macOS) or apt-get install ffmpeg (Linux). "
            "On Railway it is available automatically via nixpacks."
        )


def chunk_audio(
    audio_bytes: bytes,
    file_format: str = "webm",
    max_chunk_mb: int = 24,
) -> list:
    """
    Split audio into chunks no larger than max_chunk_mb.

    Uses pydub to load the audio, splits it into equal-duration segments,
    and exports each segment back to bytes in the original format.

    Returns a list of bytes objects, one per chunk.
    """
    _check_ffmpeg()

    try:
        from pydub import AudioSegment
    except ImportError as exc:
        raise ImportError(
            "pydub is required for audio chunking. Install it with: pip install pydub"
        ) from exc

    max_bytes = max_chunk_mb * 1024 * 1024
    total_bytes = len(audio_bytes)
    num_chunks = math.ceil(total_bytes / max_bytes)

    logger.info(
        "Chunking %.1f MB audio into %d chunks (max %d MB each).",
        total_bytes / (1024 * 1024),
        num_chunks,
        max_chunk_mb,
    )

    audio = AudioSegment.from_file(io.BytesIO(audio_bytes), format=file_format)
    total_ms = len(audio)
    chunk_ms = math.ceil(total_ms / num_chunks)

    chunks = []
    for i in range(num_chunks):
        start = i * chunk_ms
        end = min(start + chunk_ms, total_ms)
        segment = audio[start:end]

        buf = io.BytesIO()
        segment.export(buf, format=file_format)
        chunks.append(buf.getvalue())
        logger.info("Chunk %d: %.1f MB", i + 1, len(chunks[-1]) / (1024 * 1024))

    return chunks
