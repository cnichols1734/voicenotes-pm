"""
VoiceNotes PM - Meeting chat routes.
Provides streaming AI chat about a specific meeting's transcript and summary.
"""
import logging

from flask import Blueprint, Response, jsonify, request, stream_with_context
from flask_login import login_required, current_user

from services.supabase_client import get_supabase
from services.chat_service import (
    stream_chat_response,
    save_message,
    get_chat_history,
    clear_chat_history,
)

logger = logging.getLogger(__name__)

chat_bp = Blueprint("chat", __name__, url_prefix="/api/meetings")


def _get_meeting_for_user(meeting_id: str, user_id: str):
    """Fetch a meeting and verify ownership."""
    sb = get_supabase()
    result = (
        sb.table("meetings")
        .select("*")
        .eq("id", meeting_id)
        .eq("user_id", user_id)
        .execute()
    )
    if not result.data:
        return None
    return result.data[0]


# ---------------------------------------------------------------------------
# GET /api/meetings/<meeting_id>/chat
# ---------------------------------------------------------------------------
@chat_bp.route("/<meeting_id>/chat", methods=["GET"])
@login_required
def get_chat(meeting_id):
    """Return chat history for a meeting."""
    meeting = _get_meeting_for_user(meeting_id, current_user.id)
    if not meeting:
        return jsonify({"error": "Meeting not found"}), 404

    messages = get_chat_history(meeting_id, current_user.id)
    return jsonify({"messages": messages})


# ---------------------------------------------------------------------------
# POST /api/meetings/<meeting_id>/chat
# ---------------------------------------------------------------------------
@chat_bp.route("/<meeting_id>/chat", methods=["POST"])
@login_required
def post_chat(meeting_id):
    """
    Send a message and stream the AI response via SSE.
    Request body: { "message": "user's question" }
    Response: text/event-stream with data chunks, ending with [DONE].
    """
    meeting = _get_meeting_for_user(meeting_id, current_user.id)
    if not meeting:
        return jsonify({"error": "Meeting not found"}), 404

    if meeting.get("status") != "complete":
        return jsonify({"error": "Meeting must be fully summarized before chatting"}), 400

    data = request.get_json(force=True) or {}
    user_message = (data.get("message") or "").strip()
    if not user_message:
        return jsonify({"error": "Message is required"}), 400

    # Save user message
    save_message(meeting_id, current_user.id, "user", user_message)

    # Load chat history (excluding the message we just saved, it's passed separately)
    history = get_chat_history(meeting_id, current_user.id)
    # Remove the last entry (the user message we just saved) so it's passed as the new message
    if history and history[-1]["role"] == "user":
        history = history[:-1]

    user_id = current_user.id

    def generate():
        full_response = []
        try:
            for chunk in stream_chat_response(meeting, history, user_message):
                full_response.append(chunk)
                yield f"data: {chunk}\n\n"
        except RuntimeError as exc:
            logger.error("Chat stream error: %s", exc)
            error_msg = "Sorry, I encountered an error processing your question. Please try again."
            yield f"data: {error_msg}\n\n"
            full_response.append(error_msg)

        # Save the complete assistant response
        assistant_content = "".join(full_response)
        if assistant_content:
            save_message(meeting_id, user_id, "assistant", assistant_content)

        yield "data: [DONE]\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ---------------------------------------------------------------------------
# DELETE /api/meetings/<meeting_id>/chat
# ---------------------------------------------------------------------------
@chat_bp.route("/<meeting_id>/chat", methods=["DELETE"])
@login_required
def delete_chat(meeting_id):
    """Clear all chat history for a meeting."""
    meeting = _get_meeting_for_user(meeting_id, current_user.id)
    if not meeting:
        return jsonify({"error": "Meeting not found"}), 404

    clear_chat_history(meeting_id, current_user.id)
    return jsonify({"message": "Chat history cleared"})
