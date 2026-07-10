"""
VoiceNotes PM - Supabase Storage service.
Handles audio file upload, signed URL generation, and deletion
for the private 'meeting-audio' bucket.

Browser-recorded WebM from MediaRecorder is transcoded to MP3 before
storage for reliable seeking.  When the client uses stop/restart chunk
rotation, the uploaded blob is a *concatenation* of multiple independent
WebM files (each with its own EBML header).  We detect this, split on
EBML boundaries, and use ffmpeg's concat demuxer to merge them into a
single valid stream before transcoding.
"""
import io
import logging
import os
import subprocess
import tempfile

from services.supabase_client import get_supabase

logger = logging.getLogger(__name__)

BUCKET_NAME = "meeting-audio"

_SEEKABLE_FORMATS = {"mp3", "mp4", "m4a", "aac"}

EBML_HEADER_MAGIC = b'\x1a\x45\xdf\xa3'


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


def _find_ebml_boundaries(data: bytes) -> list[int]:
    """Return byte offsets of every EBML header in *data*."""
    positions = []
    start = 0
    while True:
        idx = data.find(EBML_HEADER_MAGIC, start)
        if idx == -1:
            break
        positions.append(idx)
        start = idx + 4
    return positions


def _remux_concatenated_webm(data: bytes) -> bytes:
    """
    If *data* contains multiple concatenated WebM files (from
    MediaRecorder stop/restart), split on EBML boundaries and use
    ffmpeg concat demuxer to merge them into one valid WebM stream.
    Returns the merged bytes, or the original data if only one segment.
    """
    boundaries = _find_ebml_boundaries(data)

    if len(boundaries) <= 1:
        return data

    logger.info(
        "Detected %d concatenated WebM segments — remuxing with ffmpeg.",
        len(boundaries),
    )

    with tempfile.TemporaryDirectory() as tmpdir:
        concat_list_path = os.path.join(tmpdir, "concat.txt")
        with open(concat_list_path, "w") as concat_file:
            for i, offset in enumerate(boundaries):
                end = boundaries[i + 1] if i + 1 < len(boundaries) else len(data)
                chunk_path = os.path.join(tmpdir, f"chunk_{i}.webm")
                with open(chunk_path, "wb") as cf:
                    cf.write(data[offset:end])
                concat_file.write(f"file '{chunk_path}'\n")

        output_path = os.path.join(tmpdir, "merged.webm")
        result = subprocess.run(
            [
                "ffmpeg", "-y",
                "-f", "concat", "-safe", "0",
                "-i", concat_list_path,
                "-c", "copy",
                output_path,
            ],
            capture_output=True,
        )

        if result.returncode != 0:
            stderr = result.stderr.decode(errors="replace")[:400]
            logger.warning("ffmpeg concat failed, falling back to raw data: %s", stderr)
            return data

        with open(output_path, "rb") as f:
            merged = f.read()

        logger.info(
            "Remuxed %d WebM segments: %.1f MB → %.1f MB.",
            len(boundaries),
            len(data) / (1024 * 1024),
            len(merged) / (1024 * 1024),
        )
        return merged


def _transcode_to_mp3(audio_bytes: bytes, source_format: str) -> bytes:
    """Convert audio bytes to MP3 via pydub/ffmpeg for reliable seeking."""
    if source_format == "webm":
        audio_bytes = _remux_concatenated_webm(audio_bytes)

    from pydub import AudioSegment

    audio = AudioSegment.from_file(io.BytesIO(audio_bytes), format=source_format)
    buf = io.BytesIO()
    audio.export(buf, format="mp3", bitrate="128k")
    mp3_bytes = buf.getvalue()
    logger.info(
        "Transcoded %s → mp3 (%.1f MB → %.1f MB, %.1f s).",
        source_format,
        len(audio_bytes) / (1024 * 1024),
        len(mp3_bytes) / (1024 * 1024),
        len(audio) / 1000.0,
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


def create_audio_upload_url(user_id: str, meeting_id: str, mime_type: str) -> dict:
    """
    Create a short-lived signed upload URL so the browser can PUT/POST audio
    directly to Supabase Storage — bypassing Railway's 5-minute HTTP timeout.
    """
    from config import Config

    _ensure_bucket()
    source_fmt = _source_format_from_mime(mime_type)
    ext = source_fmt if source_fmt in _SEEKABLE_FORMATS else (
        "webm" if "webm" in mime_type else source_fmt
    )
    object_path = f"{user_id}/{meeting_id}.{ext}"

    # Remove any previous object so signed upload isn't blocked by "already exists"
    try:
        delete_audio(object_path)
    except Exception:
        pass

    sb = get_supabase()
    signed = sb.storage.from_(BUCKET_NAME).create_signed_upload_url(object_path)
    token = signed.get("token") or ""
    if not token:
        raise RuntimeError("Supabase did not return an upload token")

    # Rebuild the URL ourselves — storage3 can concatenate base_url + path without
    # a slash (…/storage/v1 + object/… → …/storage/v1object/…), which breaks browsers.
    signed_url = (
        f"{Config.SUPABASE_URL.rstrip('/')}/storage/v1/object/upload/sign/"
        f"{BUCKET_NAME}/{object_path}?token={token}"
    )

    logger.info("Created signed upload URL for %s", object_path)
    return {
        "path": object_path,
        "token": token,
        "signed_url": signed_url,
        "bucket": BUCKET_NAME,
        "content_type": mime_type,
    }


def upload_audio_bytes(object_path: str, audio_bytes: bytes, mime_type: str) -> str:
    """Upload raw bytes to an exact storage path (used by chunked reassembly)."""
    _ensure_bucket()
    sb = get_supabase()
    sb.storage.from_(BUCKET_NAME).upload(
        path=object_path,
        file=audio_bytes,
        file_options={"content-type": mime_type, "upsert": "true"},
    )
    return object_path


def download_audio(audio_path: str) -> bytes:
    """Download an object from the meeting-audio bucket."""
    sb = get_supabase()
    return sb.storage.from_(BUCKET_NAME).download(audio_path)


def upload_audio_raw(user_id: str, meeting_id: str, audio_bytes: bytes, mime_type: str) -> str:
    """
    Upload audio as-is (no remux/transcode). Fast path for the HTTP request
    so the meeting is never lost waiting on ffmpeg.
    """
    _ensure_bucket()
    source_fmt = _source_format_from_mime(mime_type)
    ext = source_fmt if source_fmt in _SEEKABLE_FORMATS else (
        "webm" if "webm" in mime_type else source_fmt
    )
    object_path = f"{user_id}/{meeting_id}.{ext}"
    sb = get_supabase()
    sb.storage.from_(BUCKET_NAME).upload(
        path=object_path,
        file=audio_bytes,
        file_options={"content-type": mime_type, "upsert": "true"},
    )
    logger.info(
        "Uploaded raw audio to %s/%s (%.1f MB).",
        BUCKET_NAME, object_path, len(audio_bytes) / (1024 * 1024),
    )
    return object_path


def upload_audio(user_id: str, meeting_id: str, audio_bytes: bytes, mime_type: str) -> str:
    """
    Upload audio bytes to Supabase Storage.

    Non-seekable formats (webm, ogg, wav) are transcoded to MP3 first.
    Concatenated WebM from MediaRecorder chunk rotation is automatically
    detected and remuxed before transcoding.

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


def optimize_audio_to_mp3(user_id: str, meeting_id: str, audio_bytes: bytes, mime_type: str) -> str | None:
    """
    Background optimization: remux concatenated WebM and replace with seekable MP3.
    Returns the new object path, or None if optimization was skipped/failed.
    """
    source_fmt = _source_format_from_mime(mime_type)
    if source_fmt in _SEEKABLE_FORMATS:
        return None

    try:
        mp3_bytes = _transcode_to_mp3(audio_bytes, source_fmt)
    except Exception as exc:
        logger.error("MP3 optimization failed for meeting %s: %s", meeting_id, exc)
        return None

    _ensure_bucket()
    object_path = f"{user_id}/{meeting_id}.mp3"
    sb = get_supabase()
    sb.storage.from_(BUCKET_NAME).upload(
        path=object_path,
        file=mp3_bytes,
        file_options={"content-type": "audio/mpeg", "upsert": "true"},
    )

    # Best-effort cleanup of the raw upload
    raw_ext = "webm" if "webm" in mime_type else source_fmt
    raw_path = f"{user_id}/{meeting_id}.{raw_ext}"
    if raw_path != object_path:
        try:
            sb.storage.from_(BUCKET_NAME).remove([raw_path])
        except Exception:
            pass

    logger.info(
        "Optimized audio to MP3 for meeting %s (%.1f MB).",
        meeting_id, len(mp3_bytes) / (1024 * 1024),
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
