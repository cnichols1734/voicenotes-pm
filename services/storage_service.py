"""
VoiceNotes PM - Supabase Storage service.
Handles audio file upload, signed URL generation, and deletion
for the private 'meeting-audio' bucket.
"""
import logging

from services.supabase_client import get_supabase

logger = logging.getLogger(__name__)

BUCKET_NAME = "meeting-audio"


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


def upload_audio(user_id: str, meeting_id: str, audio_bytes: bytes, mime_type: str) -> str:
    """
    Upload audio bytes to Supabase Storage.
    Returns the object path (storage key) for later retrieval / signed URLs.
    """
    _ensure_bucket()

    ext = "webm"
    if "mp4" in mime_type or "mp4a" in mime_type:
        ext = "mp4"
    elif "ogg" in mime_type:
        ext = "ogg"
    elif "wav" in mime_type:
        ext = "wav"

    object_path = f"{user_id}/{meeting_id}.{ext}"

    sb = get_supabase()
    sb.storage.from_(BUCKET_NAME).upload(
        path=object_path,
        file=audio_bytes,
        file_options={"content-type": mime_type, "upsert": "true"},
    )
    logger.info(
        "Uploaded audio to %s/%s (%.1f MB).",
        BUCKET_NAME, object_path, len(audio_bytes) / (1024 * 1024),
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
