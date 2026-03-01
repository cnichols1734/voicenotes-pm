"""
Audio processing service.
Chunks audio for Whisper API (25MB limit) and handles format conversion.
"""


def chunk_audio(audio_bytes: bytes) -> list[bytes]:
    """
    Split audio bytes into chunks suitable for Whisper API (under 25MB each).

    Args:
        audio_bytes: Raw audio data

    Returns:
        List of audio byte chunks
    """
    raise NotImplementedError("TODO: Implement audio chunking")
