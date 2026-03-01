"""
Whisper transcription service.
Handles sending audio to OpenAI's Whisper API and returning transcripts.
Supports chunking for recordings over 25MB.
"""


def transcribe_audio(audio_bytes: bytes, file_format: str = "webm") -> str:
    """
    Send audio bytes to OpenAI Whisper API and return the transcript text.

    Args:
        audio_bytes: Raw audio data
        file_format: Audio format (webm, mp3, wav, etc.)

    Returns:
        Full transcript as a string
    """
    raise NotImplementedError("TODO: Implement Whisper transcription")
