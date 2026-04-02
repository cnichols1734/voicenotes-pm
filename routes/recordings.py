"""
VoiceNotes PM - Recordings CRUD + upload/transcribe/summarize routes.
"""
import json
import logging
import uuid
from datetime import datetime

import bleach
from flask import Blueprint, jsonify, request
from flask_login import login_required, current_user

from services.supabase_client import get_supabase
from services.whisper_service import transcribe_audio, segments_to_text
from services.summarizer_service import summarize_transcript
from services.storage_service import upload_audio, get_signed_url, delete_audio
from services.title_service import generate_title
from services.action_items import (
    ensure_action_item_ids, update_action_item, create_action_item,
    reorder_action_items, get_history as get_action_item_history,
)

COMMENT_ALLOWED_TAGS = ["b", "i", "em", "strong", "ul", "ol", "li", "br", "p"]

logger = logging.getLogger(__name__)

recordings_bp = Blueprint("recordings", __name__, url_prefix="/api/recordings")

MAX_AUDIO_BYTES = 100 * 1024 * 1024  # 100 MB hard limit
# Dashboard search: bound length to keep queries predictable (DB still uses trigram indexes)
MAX_MEETING_SEARCH_LEN = 200


def _supabase_error(message, status=503):
    return jsonify({"error": message}), status


# ---------------------------------------------------------------------------
# GET /api/recordings
# ---------------------------------------------------------------------------
@recordings_bp.route("/", methods=["GET"])
@login_required
def list_recordings():
    """
    List meetings for the current user (dashboard).

    Uses Postgres RPC list_user_meetings: omits transcript from the payload for
    bandwidth, and applies optional q= search across title + transcript with
    pg_trgm-backed ILIKE (see migration_meeting_search.sql).
    """
    try:
        supabase = get_supabase()

        folder_id = request.args.get("folder_id") or None
        meeting_type_id = request.args.get("meeting_type_id") or None
        search_q = (request.args.get("q") or "").strip()
        if len(search_q) > MAX_MEETING_SEARCH_LEN:
            search_q = search_q[:MAX_MEETING_SEARCH_LEN]

        for name, raw in (("folder_id", folder_id), ("meeting_type_id", meeting_type_id)):
            if raw:
                try:
                    uuid.UUID(str(raw))
                except ValueError:
                    return jsonify({"error": f"Invalid {name}"}), 400

        rpc_params = {
            "p_user_id": str(current_user.id),
            "p_folder_id": folder_id,
            "p_meeting_type_id": meeting_type_id,
            "p_search": search_q if search_q else None,
        }
        result = supabase.rpc("list_user_meetings", rpc_params).execute()
        return jsonify({"meetings": result.data or []})
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
        meeting = result.data
        # Backfill stable IDs on action items for existing meetings
        summary = meeting.get("summary")
        if summary and ensure_action_item_ids(summary):
            supabase.table("meetings").update({"summary": summary}).eq("id", meeting_id).execute()
            meeting["summary"] = summary
        # Generate signed audio URL for playback
        if meeting.get("audio_path"):
            try:
                meeting["audio_url"] = get_signed_url(meeting["audio_path"])
            except Exception as exc:
                logger.warning("Failed to generate audio URL: %s", exc)
            meeting.pop("audio_path", None)
        return jsonify({"meeting": meeting})
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
        segments = transcribe_audio(audio_bytes, file_format=file_format)
    except Exception as exc:
        logger.error("Chunk transcription failed: %s", exc)
        return jsonify({"error": "Transcription failed", "detail": str(exc)}), 502

    text = segments_to_text(segments)
    return jsonify({"text": text, "segments": segments})


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
    transcript = request.form.get("transcript", "").strip()
    segments_json = request.form.get("segments", "").strip()
    duration_str = request.form.get("duration", "").strip()
    file_format = request.form.get("format", "webm")

    # Parse pre-built segments from streaming transcription
    transcript_segments = None
    if segments_json:
        try:
            transcript_segments = json.loads(segments_json)
            if not isinstance(transcript_segments, list):
                transcript_segments = None
        except (json.JSONDecodeError, TypeError):
            transcript_segments = None

    if not transcript:
        if transcript_segments:
            transcript = segments_to_text(transcript_segments)

    if not transcript:
        # Legacy mode: audio blob upload with server-side transcription
        if "audio" not in request.files:
            return jsonify({"error": "No audio file or transcript provided"}), 400

        audio_file = request.files["audio"]
        audio_bytes = audio_file.read()

        if len(audio_bytes) < 1000:
            return jsonify({"error": "Recording too short. Please record at least a few seconds."}), 400

        if len(audio_bytes) > MAX_AUDIO_BYTES:
            return jsonify({"error": "Audio file exceeds 100 MB limit."}), 413

        try:
            segments = transcribe_audio(audio_bytes, file_format=file_format)
            transcript_segments = segments
            transcript = segments_to_text(segments)
        except Exception as exc:
            logger.error("Whisper transcription failed: %s", exc)
            return jsonify({"error": "Transcription failed", "detail": str(exc)}), 502

    if not transcript:
        return jsonify({"error": "No transcript could be generated."}), 400

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
        if transcript_segments:
            insert_data["transcript_segments"] = transcript_segments
        if duration_str:
            try:
                insert_data["duration_seconds"] = int(float(duration_str))
            except (ValueError, TypeError):
                pass

        result = supabase.table("meetings").insert(insert_data).execute()
        meeting = result.data[0]
    except Exception as exc:
        logger.error("Failed to save meeting after transcription: %s", exc)
        return _supabase_error(f"Failed to save meeting: {exc}")

    # Upload audio to storage (non-blocking: meeting is saved even if storage fails)
    audio_file = request.files.get("audio")
    if audio_file:
        audio_file.seek(0)
        audio_bytes = audio_file.read()
        if len(audio_bytes) >= 1000:
            mime_type = audio_file.content_type or f"audio/{file_format}"
            try:
                audio_path = upload_audio(
                    str(current_user.id), meeting["id"], audio_bytes, mime_type,
                )
                supabase.table("meetings").update({
                    "audio_path": audio_path,
                    "audio_mime_type": mime_type,
                }).eq("id", meeting["id"]).execute()
            except Exception as exc:
                logger.error("Audio storage failed for meeting %s: %s", meeting["id"], exc)

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
            "hint": "If the configured model is unavailable, update OPENROUTER_MODEL in /api/settings/model",
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
    allowed = {"title", "folder_id", "meeting_type_id", "summary"}
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
# PATCH /api/recordings/<meeting_id>/action-items/<item_id>
# ---------------------------------------------------------------------------
@recordings_bp.route("/<meeting_id>/action-items/<item_id>", methods=["PATCH"])
@login_required
def patch_action_item(meeting_id, item_id):
    """Update a single action item (task, owner, deadline, completed)."""
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

        meeting = result.data
        data = request.get_json(force=True) or {}
        summary = update_action_item(
            meeting, item_id, data,
            changed_by_type="user",
            changed_by_user_id=str(current_user.id),
            changed_by_name=current_user.display_name,
        )
        return jsonify({"summary": summary})
    except KeyError as exc:
        return jsonify({"error": str(exc)}), 404
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.error("Failed to update action item: %s", exc)
        return _supabase_error(f"Failed to update action item: {exc}")


# ---------------------------------------------------------------------------
# POST /api/recordings/<meeting_id>/action-items
# ---------------------------------------------------------------------------
@recordings_bp.route("/<meeting_id>/action-items", methods=["POST"])
@login_required
def post_action_item(meeting_id):
    """Create a new action item on a meeting."""
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

        meeting = result.data
        data = request.get_json(force=True) or {}
        new_item, summary = create_action_item(
            meeting, data,
            changed_by_type="user",
            changed_by_user_id=str(current_user.id),
            changed_by_name=current_user.display_name,
        )
        return jsonify({"item": new_item, "summary": summary}), 201
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.error("Failed to create action item: %s", exc)
        return _supabase_error(f"Failed to create action item: {exc}")


# ---------------------------------------------------------------------------
# GET /api/recordings/<meeting_id>/action-items/history
# ---------------------------------------------------------------------------
@recordings_bp.route("/<meeting_id>/action-items/history", methods=["GET"])
@login_required
def get_action_items_history(meeting_id):
    """Fetch action item change history for a meeting the user owns."""
    try:
        supabase = get_supabase()
        result = (
            supabase.table("meetings")
            .select("id")
            .eq("id", meeting_id)
            .eq("user_id", str(current_user.id))
            .execute()
        )
        if not result.data:
            return jsonify({"error": "Meeting not found"}), 404

        history = get_action_item_history(meeting_id)
        return jsonify({"history": history})
    except Exception as exc:
        logger.error("Failed to fetch action item history: %s", exc)
        return _supabase_error(f"Failed to fetch history: {exc}")


# ---------------------------------------------------------------------------
# PUT /api/recordings/<meeting_id>/action-items/reorder
# ---------------------------------------------------------------------------
@recordings_bp.route("/<meeting_id>/action-items/reorder", methods=["PUT"])
@login_required
def reorder_action_items_route(meeting_id):
    """Reorder action items for a meeting the user owns."""
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

        data = request.get_json(force=True) or {}
        ordered_ids = data.get("ordered_ids")
        if not ordered_ids or not isinstance(ordered_ids, list):
            return jsonify({"error": "ordered_ids array required"}), 400

        summary = reorder_action_items(result.data, ordered_ids)
        return jsonify({"summary": summary})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.error("Failed to reorder action items: %s", exc)
        return _supabase_error(f"Failed to reorder: {exc}")


# ---------------------------------------------------------------------------
# DELETE /api/recordings/<id>
# ---------------------------------------------------------------------------
@recordings_bp.route("/<meeting_id>", methods=["DELETE"])
@login_required
def delete_recording(meeting_id):
    """Delete a meeting record (must belong to current user)."""
    try:
        supabase = get_supabase()
        # Clean up stored audio before deleting the row
        try:
            row = supabase.table("meetings").select("audio_path").eq(
                "id", meeting_id
            ).eq("user_id", str(current_user.id)).execute()
            if row.data and row.data[0].get("audio_path"):
                delete_audio(row.data[0]["audio_path"])
        except Exception as exc:
            logger.warning("Audio cleanup failed for meeting %s: %s", meeting_id, exc)
        supabase.table("meetings").delete().eq("id", meeting_id).eq("user_id", str(current_user.id)).execute()
        return jsonify({"message": "Meeting deleted"}), 200
    except Exception as exc:
        logger.error("Failed to delete meeting %s: %s", meeting_id, exc)
        return _supabase_error(f"Failed to delete meeting: {exc}")


# ---------------------------------------------------------------------------
# GET /api/recordings/<meeting_id>/comments
# ---------------------------------------------------------------------------
@recordings_bp.route("/<meeting_id>/comments", methods=["GET"])
@login_required
def get_comments(meeting_id):
    """List comments for a meeting the user owns."""
    try:
        supabase = get_supabase()
        meeting = (
            supabase.table("meetings")
            .select("id")
            .eq("id", meeting_id)
            .eq("user_id", str(current_user.id))
            .execute()
        )
        if not meeting.data:
            return jsonify({"error": "Meeting not found"}), 404

        result = (
            supabase.table("meeting_comments")
            .select("*")
            .eq("meeting_id", meeting_id)
            .order("created_at")
            .execute()
        )
        return jsonify({"comments": result.data or []})
    except Exception as exc:
        logger.error("Failed to fetch comments: %s", exc)
        return _supabase_error(f"Failed to fetch comments: {exc}")


# ---------------------------------------------------------------------------
# POST /api/recordings/<meeting_id>/comments
# ---------------------------------------------------------------------------
@recordings_bp.route("/<meeting_id>/comments", methods=["POST"])
@login_required
def post_comment(meeting_id):
    """Create a comment on a meeting the user owns."""
    try:
        supabase = get_supabase()
        meeting = (
            supabase.table("meetings")
            .select("id")
            .eq("id", meeting_id)
            .eq("user_id", str(current_user.id))
            .execute()
        )
        if not meeting.data:
            return jsonify({"error": "Meeting not found"}), 404

        data = request.get_json(force=True) or {}
        raw_content = (data.get("content") or "").strip()
        if not raw_content:
            return jsonify({"error": "Comment content is required"}), 400

        clean_content = bleach.clean(raw_content, tags=COMMENT_ALLOWED_TAGS, strip=True)
        if not clean_content.strip():
            return jsonify({"error": "Comment content is required"}), 400

        result = (
            supabase.table("meeting_comments")
            .insert({
                "meeting_id": meeting_id,
                "commenter_type": "user",
                "user_id": str(current_user.id),
                "commenter_name": current_user.display_name,
                "content": clean_content,
            })
            .execute()
        )
        return jsonify({"comment": result.data[0]}), 201
    except Exception as exc:
        logger.error("Failed to create comment: %s", exc)
        return _supabase_error(f"Failed to create comment: {exc}")


# ---------------------------------------------------------------------------
# PATCH /api/recordings/<meeting_id>/comments/<comment_id>
# ---------------------------------------------------------------------------
@recordings_bp.route("/<meeting_id>/comments/<comment_id>", methods=["PATCH"])
@login_required
def patch_comment(meeting_id, comment_id):
    """Edit a comment. Only the comment author can edit their own comment."""
    try:
        supabase = get_supabase()
        meeting = (
            supabase.table("meetings")
            .select("id")
            .eq("id", meeting_id)
            .eq("user_id", str(current_user.id))
            .execute()
        )
        if not meeting.data:
            return jsonify({"error": "Meeting not found"}), 404

        comment = (
            supabase.table("meeting_comments")
            .select("*")
            .eq("id", comment_id)
            .eq("meeting_id", meeting_id)
            .execute()
        )
        if not comment.data:
            return jsonify({"error": "Comment not found"}), 404

        c = comment.data[0]
        if c.get("user_id") != str(current_user.id):
            return jsonify({"error": "You can only edit your own comments"}), 403

        data = request.get_json(force=True) or {}
        raw_content = (data.get("content") or "").strip()
        if not raw_content:
            return jsonify({"error": "Comment content is required"}), 400

        clean_content = bleach.clean(raw_content, tags=COMMENT_ALLOWED_TAGS, strip=True)
        if not clean_content.strip():
            return jsonify({"error": "Comment content is required"}), 400

        result = (
            supabase.table("meeting_comments")
            .update({"content": clean_content})
            .eq("id", comment_id)
            .execute()
        )
        return jsonify({"comment": result.data[0]})
    except Exception as exc:
        logger.error("Failed to update comment: %s", exc)
        return _supabase_error(f"Failed to update comment: {exc}")


# ---------------------------------------------------------------------------
# DELETE /api/recordings/<meeting_id>/comments/<comment_id>
# ---------------------------------------------------------------------------
@recordings_bp.route("/<meeting_id>/comments/<comment_id>", methods=["DELETE"])
@login_required
def delete_comment(meeting_id, comment_id):
    """
    Delete a comment. The meeting owner can delete any comment on their meeting.
    """
    try:
        supabase = get_supabase()
        meeting = (
            supabase.table("meetings")
            .select("id")
            .eq("id", meeting_id)
            .eq("user_id", str(current_user.id))
            .execute()
        )
        if not meeting.data:
            return jsonify({"error": "Meeting not found"}), 404

        supabase.table("meeting_comments").delete().eq(
            "id", comment_id
        ).eq("meeting_id", meeting_id).execute()
        return jsonify({"message": "Comment deleted"})
    except Exception as exc:
        logger.error("Failed to delete comment: %s", exc)
        return _supabase_error(f"Failed to delete comment: {exc}")
