"""
VoiceNotes PM - Recordings CRUD + upload/transcribe/summarize routes.
"""
import logging
import threading
import uuid
from datetime import datetime

from flask import Blueprint, jsonify, request
from flask_login import login_required, current_user

from services.supabase_client import get_supabase
from services.whisper_service import transcribe_audio, diarize_audio
from services.summarizer_service import summarize_transcript
from services.title_service import generate_title

logger = logging.getLogger(__name__)

recordings_bp = Blueprint("recordings", __name__, url_prefix="/api/recordings")

MAX_AUDIO_BYTES = 100 * 1024 * 1024  # 100 MB hard limit

# In-memory store for async diarization jobs (shared across gthread workers)
_diarize_jobs = {}  # job_id -> {"status": "processing"|"complete"|"error", "transcript": str, "error": str}


def _supabase_error(message, status=503):
    return jsonify({"error": message}), status


# ---------------------------------------------------------------------------
# GET /api/recordings
# ---------------------------------------------------------------------------
@recordings_bp.route("/", methods=["GET"])
@login_required
def list_recordings():
    """List all meetings for the current user, with optional filters."""
    try:
        supabase = get_supabase()
        query = (
            supabase.table("meetings")
            .select("*")
            .eq("user_id", str(current_user.id))
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
@login_required
def get_recording(meeting_id):
    """Get a single meeting with full details (must belong to current user)."""
    try:
        supabase = get_supabase()
        result = (
            supabase.table("meetings")
            .select("*")
            .eq("id", meeting_id)
            .eq("user_id", str(current_user.id))
            .single()
            .execute()
        )
        if not result.data:
            return jsonify({"error": "Meeting not found"}), 404
        return jsonify({"meeting": result.data})
    except Exception as exc:
        logger.error("Failed to get recording %s: %s", meeting_id, exc)
        return _supabase_error(f"Failed to fetch meeting: {exc}")


# ---------------------------------------------------------------------------
# POST /api/recordings/transcribe-chunk
# ---------------------------------------------------------------------------
@recordings_bp.route("/transcribe-chunk", methods=["POST"])
@login_required
def transcribe_chunk():
    """
    Accept a small audio blob, transcribe it via Whisper, and return the text.
    Used for streaming transcription during recording — no DB write.
    """
    if "audio" not in request.files:
        return jsonify({"error": "No audio file provided"}), 400

    audio_file = request.files["audio"]
    audio_bytes = audio_file.read()

    if len(audio_bytes) < 500:
        # Very short chunk, likely silence — return empty
        return jsonify({"text": ""})

    file_format = request.form.get("format", "webm")

    try:
        transcript = transcribe_audio(audio_bytes, file_format=file_format)
    except Exception as exc:
        logger.error("Chunk transcription failed: %s", exc)
        return jsonify({"error": "Transcription failed", "detail": str(exc)}), 502

    return jsonify({"text": transcript})


# ---------------------------------------------------------------------------
# POST /api/recordings/diarize  (async job submission)
# ---------------------------------------------------------------------------
@recordings_bp.route("/diarize", methods=["POST"])
@login_required
def submit_diarize():
    """
    Accept full audio recording, start background diarization + transcription.
    Returns a job_id immediately for polling via /diarize-status/<job_id>.
    """
    if "audio" not in request.files:
        return jsonify({"error": "No audio file provided"}), 400

    audio_file = request.files["audio"]
    audio_bytes = audio_file.read()

    if len(audio_bytes) < 1000:
        return jsonify({"error": "Recording too short"}), 400

    if len(audio_bytes) > MAX_AUDIO_BYTES:
        return jsonify({"error": "Audio file exceeds 100 MB limit"}), 413

    file_format = request.form.get("format", "webm")
    job_id = str(uuid.uuid4())
    _diarize_jobs[job_id] = {"status": "processing", "transcript": None, "error": None}

    def run_diarization():
        try:
            transcript = diarize_audio(audio_bytes, file_format)
            _diarize_jobs[job_id]["transcript"] = transcript
            _diarize_jobs[job_id]["status"] = "complete"
        except Exception as exc:
            logger.error("Diarization job %s failed: %s", job_id, exc)
            _diarize_jobs[job_id]["error"] = str(exc)
            _diarize_jobs[job_id]["status"] = "error"

    thread = threading.Thread(target=run_diarization, daemon=True)
    thread.start()

    logger.info("Diarization job %s started (%.1f MB audio)", job_id, len(audio_bytes) / (1024 * 1024))
    return jsonify({"job_id": job_id})


# ---------------------------------------------------------------------------
# GET /api/recordings/diarize-status/<job_id>
# ---------------------------------------------------------------------------
@recordings_bp.route("/diarize-status/<job_id>", methods=["GET"])
@login_required
def diarize_status(job_id):
    """Poll for diarization job result."""
    job = _diarize_jobs.get(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404

    if job["status"] == "complete":
        transcript = job["transcript"]
        del _diarize_jobs[job_id]
        return jsonify({"status": "complete", "transcript": transcript})
    elif job["status"] == "error":
        error = job["error"]
        del _diarize_jobs[job_id]
        return jsonify({"status": "error", "error": error}), 502
    else:
        return jsonify({"status": "processing"})


# ---------------------------------------------------------------------------
# POST /api/recordings/upload
# ---------------------------------------------------------------------------
@recordings_bp.route("/upload", methods=["POST"])
@login_required
def upload_recording():
    """
    Create a meeting record from either:
      1. Pre-built transcript (from streaming chunks) — just saves to DB
      2. Audio blob (legacy/fallback) — transcribes then saves
    """
    # Check for pre-built transcript (streaming mode)
    transcript = request.form.get("transcript", "").strip()

    if not transcript:
        # Legacy mode: audio blob upload
        if "audio" not in request.files:
            return jsonify({"error": "No audio file or transcript provided"}), 400

        audio_file = request.files["audio"]
        audio_bytes = audio_file.read()

        if len(audio_bytes) < 1000:
            return jsonify({"error": "Recording too short. Please record at least a few seconds."}), 400

        if len(audio_bytes) > MAX_AUDIO_BYTES:
            return jsonify({"error": "Audio file exceeds 100 MB limit."}), 413

        file_format = request.form.get("format", "webm")

        try:
            transcript = transcribe_audio(audio_bytes, file_format=file_format)
        except Exception as exc:
            logger.error("Whisper transcription failed: %s", exc)
            return jsonify({"error": "Transcription failed", "detail": str(exc)}), 502

    if not transcript:
        return jsonify({"error": "No transcript could be generated."}), 400

    # Use a generic placeholder title (user can name it or use AI generate)
    title_text = f"Meeting - {datetime.now().strftime('%Y-%m-%d %H:%M')}"

    # Save meeting record
    try:
        supabase = get_supabase()
        insert_data = {
            "title": title_text,
            "transcript": transcript,
            "status": "selecting_type",
            "user_id": str(current_user.id),
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
# POST /api/recordings/generate-title
# ---------------------------------------------------------------------------
@recordings_bp.route("/generate-title", methods=["POST"])
@login_required
def generate_meeting_title():
    """Use AI to generate a concise meeting title from the transcript."""
    data = request.get_json(force=True) or {}
    meeting_id = data.get("meeting_id")

    if not meeting_id:
        return jsonify({"error": "meeting_id is required"}), 400

    try:
        supabase = get_supabase()
        result = (
            supabase.table("meetings")
            .select("transcript")
            .eq("id", meeting_id)
            .eq("user_id", str(current_user.id))
            .single()
            .execute()
        )
        if not result.data:
            return jsonify({"error": "Meeting not found"}), 404

        transcript = result.data.get("transcript", "")
        if not transcript:
            return jsonify({"error": "No transcript available"}), 400

        title = generate_title(transcript)

        # Save the title to the meeting
        supabase.table("meetings").update({"title": title}).eq("id", meeting_id).execute()

        return jsonify({"title": title})
    except Exception as exc:
        logger.error("Failed to generate title: %s", exc)
        return jsonify({"error": f"Failed to generate title: {exc}"}), 502


# ---------------------------------------------------------------------------
# POST /api/recordings/summarize
# ---------------------------------------------------------------------------
@recordings_bp.route("/summarize", methods=["POST"])
@login_required
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

        # Fetch meeting transcript (must belong to current user)
        mtg_result = (
            supabase.table("meetings")
            .select("*")
            .eq("id", meeting_id)
            .eq("user_id", str(current_user.id))
            .single()
            .execute()
        )
        if not mtg_result.data:
            return jsonify({"error": "Meeting not found"}), 404
        meeting = mtg_result.data
        transcript = meeting.get("transcript", "")

        # Fetch meeting type prompt (must belong to current user)
        mt_result = (
            supabase.table("meeting_types")
            .select("*")
            .eq("id", meeting_type_id)
            .eq("user_id", str(current_user.id))
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
@login_required
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
            .eq("user_id", str(current_user.id))
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
@login_required
def delete_recording(meeting_id):
    """Delete a meeting record (must belong to current user)."""
    try:
        supabase = get_supabase()
        supabase.table("meetings").delete().eq("id", meeting_id).eq("user_id", str(current_user.id)).execute()
        return jsonify({"message": "Meeting deleted"}), 200
    except Exception as exc:
        logger.error("Failed to delete meeting %s: %s", meeting_id, exc)
        return _supabase_error(f"Failed to delete meeting: {exc}")
