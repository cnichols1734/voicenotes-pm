"""
VoiceNotes PM - Audio chunking service.
Splits large audio files into smaller chunks for Whisper API.

Strategy:
  1. First attempt: split raw bytes directly (fast, no ffmpeg needed).
     Whisper is tolerant of partial segments for most codecs.
  2. Fallback: use pydub/ffmpeg to re-encode proper segments if the
     raw split fails during transcription.
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


def chunk_audio_raw(audio_bytes: bytes, max_chunk_mb: int = 24) -> list:
    """
    Split audio into byte-level chunks without decoding.

    This is extremely fast (no ffmpeg needed) and works well with Whisper,
    which is tolerant of partial audio segments.

    Returns a list of bytes objects, one per chunk.
    """
    max_bytes = max_chunk_mb * 1024 * 1024
    total_bytes = len(audio_bytes)
    num_chunks = math.ceil(total_bytes / max_bytes)

    logger.info(
        "Raw-splitting %.1f MB audio into %d chunks (max %d MB each).",
        total_bytes / (1024 * 1024),
        num_chunks,
        max_chunk_mb,
    )

    chunks = []
    for i in range(num_chunks):
        start = i * max_bytes
        end = min(start + max_bytes, total_bytes)
        chunk = audio_bytes[start:end]
        chunks.append(chunk)
        logger.info("Chunk %d: %.1f MB", i + 1, len(chunk) / (1024 * 1024))

    return chunks


def chunk_audio_pydub(
    audio_bytes: bytes,
    file_format: str = "webm",
    max_chunk_mb: int = 24,
) -> list:
    """
    Split audio into chunks using pydub (ffmpeg).

    This decodes the audio, splits by duration, and re-encodes each chunk.
    More reliable for codecs that don't tolerate byte-level splits, but
    much slower because it must decode the entire file.

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
        "Pydub-chunking %.1f MB audio into %d chunks (max %d MB each).",
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


# Keep legacy name for backwards compatibility
chunk_audio = chunk_audio_pydub
