"""
VoiceNotes PM - Supabase Storage service.
Handles audio file upload, signed URL generation, and deletion
for the private 'meeting-audio' bucket.

Incoming browser audio (typically WebM from MediaRecorder) is transcoded
to MP3 before storage so that the resulting file is fully seekable —
WebM recorded in streaming mode lacks cue/duration metadata, which
breaks seeking past the initial buffered range.
"""
import io
import logging

from services.supabase_client import get_supabase

logger = logging.getLogger(__name__)

BUCKET_NAME = "meeting-audio"

# Formats that are already seekable and don't need transcoding
_SEEKABLE_FORMATS = {"mp3", "mp4", "m4a", "aac"}


def _ensure_bucket():
    """Create the private storage bucket if it doesn't already exist."""
    sb = get_supabase()
    try:
        sb.storage.get_bucket(BUCKET_NAME)
    except Exception:
        try:
            sb.storage.create_bucket(
                BUCKET_NAME,
                options={"public": False},
            )
            logger.info("Created storage bucket '%s'.", BUCKET_NAME)
        except Exception as exc:
            if "already exists" not in str(exc).lower():
                raise


def _transcode_to_mp3(audio_bytes: bytes, source_format: str) -> bytes:
    """Convert audio bytes to MP3 via pydub/ffmpeg for reliable seeking."""
    from pydub import AudioSegment

    audio = AudioSegment.from_file(io.BytesIO(audio_bytes), format=source_format)
    buf = io.BytesIO()
    audio.export(buf, format="mp3", bitrate="128k")
    mp3_bytes = buf.getvalue()
    logger.info(
        "Transcoded %s → mp3 (%.1f MB → %.1f MB).",
        source_format,
        len(audio_bytes) / (1024 * 1024),
        len(mp3_bytes) / (1024 * 1024),
    )
    return mp3_bytes


def _source_format_from_mime(mime_type: str) -> str:
    """Derive a pydub-compatible format string from a MIME type."""
    if "webm" in mime_type:
        return "webm"
    if "ogg" in mime_type:
        return "ogg"
    if "wav" in mime_type:
        return "wav"
    if "mp4" in mime_type or "m4a" in mime_type:
        return "mp4"
    if "mp3" in mime_type or "mpeg" in mime_type:
        return "mp3"
    return "webm"


def upload_audio(user_id: str, meeting_id: str, audio_bytes: bytes, mime_type: str) -> str:
    """
    Upload audio bytes to Supabase Storage.

    Non-seekable formats (webm, ogg, wav) are transcoded to MP3 first.
    Returns the object path (storage key) for later retrieval / signed URLs.
    """
    _ensure_bucket()

    source_fmt = _source_format_from_mime(mime_type)

    if source_fmt in _SEEKABLE_FORMATS:
        ext = source_fmt
        upload_bytes = audio_bytes
        content_type = mime_type
    else:
        ext = "mp3"
        upload_bytes = _transcode_to_mp3(audio_bytes, source_fmt)
        content_type = "audio/mpeg"

    object_path = f"{user_id}/{meeting_id}.{ext}"

    sb = get_supabase()
    sb.storage.from_(BUCKET_NAME).upload(
        path=object_path,
        file=upload_bytes,
        file_options={"content-type": content_type, "upsert": "true"},
    )
    logger.info(
        "Uploaded audio to %s/%s (%.1f MB).",
        BUCKET_NAME, object_path, len(upload_bytes) / (1024 * 1024),
    )
    return object_path


def get_signed_url(audio_path: str, expires_in: int = 3600) -> str:
    """Generate a time-limited signed URL for audio playback."""
    sb = get_supabase()
    result = sb.storage.from_(BUCKET_NAME).create_signed_url(audio_path, expires_in)
    return result.get("signedURL") or result.get("signedUrl") or ""


def delete_audio(audio_path: str) -> None:
    """Remove an audio file from storage. Fails silently if not found."""
    try:
        sb = get_supabase()
        sb.storage.from_(BUCKET_NAME).remove([audio_path])
        logger.info("Deleted audio at %s/%s.", BUCKET_NAME, audio_path)
    except Exception as exc:
        logger.warning("Failed to delete audio at %s: %s", audio_path, exc)
