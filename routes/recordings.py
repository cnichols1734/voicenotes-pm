"""
VoiceNotes PM - Recordings CRUD + upload/transcribe/summarize routes.
"""
import io
import logging
from datetime import datetime

from flask import Blueprint, jsonify, request

from services.supabase_client import get_supabase
from services.whisper_service import transcribe_audio
from services.summarizer_service import summarize_transcript

logger = logging.getLogger(__name__)

recordings_bp = Blueprint("recordings", __name__, url_prefix="/api/recordings")

MAX_AUDIO_BYTES = 100 * 1024 * 1024  # 100 MB hard limit


def _supabase_error(message, status=503):
    return jsonify({"error": message}), status


# ---------------------------------------------------------------------------
# GET /api/recordings
# ---------------------------------------------------------------------------
@recordings_bp.route("/", methods=["GET"])
def list_recordings():
    """List all meetings, with optional ?folder_id= and ?meeting_type_id= filters."""
    try:
        supabase = get_supabase()
        query = (
            supabase.table("meetings")
            .select("*")
            .order("recorded_at", desc=True)
        )

        folder_id = request.args.get("folder_id")
        meeting_type_id = request.args.get("meeting_type_id")

        if folder_id:
            query = query.eq("folder_id", folder_id)
        if meeting_type_id:
            query = query.eq("meeting_type_id", meeting_type_id)

        result = query.execute()
        return jsonify({"meetings": result.data})
    except Exception as exc:
        logger.error("Failed to list recordings: %s", exc)
        return _supabase_error(f"Failed to fetch meetings: {exc}")


# ---------------------------------------------------------------------------
# GET /api/recordings/<id>
# ---------------------------------------------------------------------------
@recordings_bp.route("/<meeting_id>", methods=["GET"])
def get_recording(meeting_id):
    """Get a single meeting with full details."""
    try:
        supabase = get_supabase()
        result = supabase.table("meetings").select("*").eq("id", meeting_id).single().execute()
        if not result.data:
            return jsonify({"error": "Meeting not found"}), 404
        return jsonify({"meeting": result.data})
    except Exception as exc:
        logger.error("Failed to get recording %s: %s", meeting_id, exc)
        return _supabase_error(f"Failed to fetch meeting: {exc}")


# ---------------------------------------------------------------------------
# POST /api/recordings/upload
# ---------------------------------------------------------------------------
@recordings_bp.route("/upload", methods=["POST"])
def upload_recording():
    """
    Accept an audio blob, transcribe it via Whisper, create a meeting record
    with status='selecting_type', and return the transcript + meeting_id.
    """
    if "audio" not in request.files:
        return jsonify({"error": "No audio file provided"}), 400

    audio_file = request.files["audio"]
    audio_bytes = audio_file.read()

    if len(audio_bytes) < 1000:
        return jsonify({"error": "Recording too short. Please record at least a few seconds."}), 400

    if len(audio_bytes) > MAX_AUDIO_BYTES:
        return jsonify({"error": "Audio file exceeds 100 MB limit."}), 413

    file_format = request.form.get("format", "webm")

    # Transcribe
    try:
        transcript = transcribe_audio(audio_bytes, file_format=file_format)
    except Exception as exc:
        logger.error("Whisper transcription failed: %s", exc)
        return jsonify({"error": "Transcription failed", "detail": str(exc)}), 502

    # Generate a default title from the transcript
    title_text = transcript.replace("\n", " ").strip()
    if len(title_text) > 60:
        title_text = title_text[:57] + "..."
    if not title_text:
        title_text = f"Meeting - {datetime.now().strftime('%Y-%m-%d %H:%M')}"

    # Save meeting record
    try:
        supabase = get_supabase()
        insert_data = {
            "title": title_text,
            "transcript": transcript,
            "status": "selecting_type",
        }
        result = supabase.table("meetings").insert(insert_data).execute()
        meeting = result.data[0]
    except Exception as exc:
        logger.error("Failed to save meeting after transcription: %s", exc)
        return _supabase_error(f"Failed to save meeting: {exc}")

    return jsonify({
        "meeting_id": meeting["id"],
        "transcript": transcript,
        "title": meeting["title"],
    })


# ---------------------------------------------------------------------------
# POST /api/recordings/summarize
# ---------------------------------------------------------------------------
@recordings_bp.route("/summarize", methods=["POST"])
def summarize_recording():
    """
    Accept meeting_id, meeting_type_id, optional title and folder_id.
    Run summarization, save result to DB, return the full meeting object.
    """
    data = request.get_json(force=True) or {}
    meeting_id = data.get("meeting_id")
    meeting_type_id = data.get("meeting_type_id")
    title = data.get("title")
    folder_id = data.get("folder_id")

    if not meeting_id or not meeting_type_id:
        return jsonify({"error": "meeting_id and meeting_type_id are required"}), 400

    try:
        supabase = get_supabase()

        # Fetch meeting transcript
        mtg_result = supabase.table("meetings").select("*").eq("id", meeting_id).single().execute()
        if not mtg_result.data:
            return jsonify({"error": "Meeting not found"}), 404
        meeting = mtg_result.data
        transcript = meeting.get("transcript", "")

        # Fetch meeting type prompt
        mt_result = (
            supabase.table("meeting_types")
            .select("*")
            .eq("id", meeting_type_id)
            .single()
            .execute()
        )
        if not mt_result.data:
            return jsonify({"error": "Meeting type not found"}), 404
        meeting_type = mt_result.data
        prompt_template = meeting_type["prompt_template"]

        # Mark as summarizing
        supabase.table("meetings").update({"status": "summarizing"}).eq("id", meeting_id).execute()

    except Exception as exc:
        logger.error("DB error before summarization: %s", exc)
        return _supabase_error(f"Database error: {exc}")

    # Run summarization
    try:
        summary = summarize_transcript(transcript, prompt_template)
    except Exception as exc:
        logger.error("Summarization failed: %s", exc)
        try:
            supabase.table("meetings").update({
                "status": "error",
                "error_message": str(exc),
            }).eq("id", meeting_id).execute()
        except Exception:
            pass
        return jsonify({
            "error": "Summarization failed",
            "detail": str(exc),
            "hint": "If the free model is unavailable, update OPENROUTER_MODEL in /api/settings/model",
        }), 502

    # Save results
    try:
        update_data = {
            "summary": summary,
            "meeting_type_id": meeting_type_id,
            "status": "complete",
        }
        if title:
            update_data["title"] = title
        if folder_id:
            update_data["folder_id"] = folder_id

        result = (
            supabase.table("meetings")
            .update(update_data)
            .eq("id", meeting_id)
            .execute()
        )
        return jsonify({"meeting": result.data[0]})
    except Exception as exc:
        logger.error("DB error saving summary: %s", exc)
        return _supabase_error(f"Failed to save summary: {exc}")


# ---------------------------------------------------------------------------
# PUT /api/recordings/<id>
# ---------------------------------------------------------------------------
@recordings_bp.route("/<meeting_id>", methods=["PUT"])
def update_recording(meeting_id):
    """Update a meeting (title, folder_id, meeting_type_id)."""
    data = request.get_json(force=True) or {}
    allowed = {"title", "folder_id", "meeting_type_id"}
    update_data = {k: v for k, v in data.items() if k in allowed}

    if not update_data:
        return jsonify({"error": "No valid fields provided"}), 400

    try:
        supabase = get_supabase()
        result = (
            supabase.table("meetings")
            .update(update_data)
            .eq("id", meeting_id)
            .execute()
        )
        if not result.data:
            return jsonify({"error": "Meeting not found"}), 404
        return jsonify({"meeting": result.data[0]})
    except Exception as exc:
        logger.error("Failed to update meeting %s: %s", meeting_id, exc)
        return _supabase_error(f"Failed to update meeting: {exc}")


# ---------------------------------------------------------------------------
# DELETE /api/recordings/<id>
# ---------------------------------------------------------------------------
@recordings_bp.route("/<meeting_id>", methods=["DELETE"])
def delete_recording(meeting_id):
    """Delete a meeting record."""
    try:
        supabase = get_supabase()
        supabase.table("meetings").delete().eq("id", meeting_id).execute()
        return jsonify({"message": "Meeting deleted"}), 200
    except Exception as exc:
        logger.error("Failed to delete meeting %s: %s", meeting_id, exc)
        return _supabase_error(f"Failed to delete meeting: {exc}")
