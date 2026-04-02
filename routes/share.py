"""
VoiceNotes PM - Public share routes.
Generates UUID-based public links for meetings. Anyone with the link can view
the summary, transcript, and use ephemeral AI chat -- no account required.
All AI calls proxy through the backend so API keys are never exposed.
"""
import json
import logging

import bleach
from flask import Blueprint, Response, jsonify, render_template, request, stream_with_context
from flask_login import login_required, current_user

from services.supabase_client import get_supabase
from services.chat_service import stream_chat_response
from services.storage_service import get_signed_url
from services.action_items import (
    ensure_action_item_ids, update_action_item, create_action_item,
    reorder_action_items, get_history as get_action_item_history,
)

COMMENT_ALLOWED_TAGS = ["b", "i", "em", "strong", "ul", "ol", "li", "br", "p"]

logger = logging.getLogger(__name__)

share_bp = Blueprint("share", __name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_share_link(share_id: str):
    """Fetch an active share link by its UUID."""
    sb = get_supabase()
    result = (
        sb.table("shared_links")
        .select("*")
        .eq("id", share_id)
        .eq("is_active", True)
        .execute()
    )
    return result.data[0] if result.data else None


def _get_meeting_by_id(meeting_id: str):
    """Fetch a meeting by ID (no user scoping -- caller must verify access)."""
    sb = get_supabase()
    result = sb.table("meetings").select("*").eq("id", meeting_id).execute()
    return result.data[0] if result.data else None


# ---------------------------------------------------------------------------
# Authenticated: create / revoke share links
# ---------------------------------------------------------------------------

@share_bp.route("/api/recordings/<meeting_id>/share", methods=["POST"])
@login_required
def create_share(meeting_id):
    """Create or return existing share link for a meeting the user owns."""
    sb = get_supabase()

    meeting = (
        sb.table("meetings")
        .select("id")
        .eq("id", meeting_id)
        .eq("user_id", current_user.id)
        .execute()
    )
    if not meeting.data:
        return jsonify({"error": "Meeting not found"}), 404

    existing = (
        sb.table("shared_links")
        .select("*")
        .eq("meeting_id", meeting_id)
        .eq("user_id", current_user.id)
        .execute()
    )
    if existing.data:
        link = existing.data[0]
        if not link["is_active"]:
            sb.table("shared_links").update({"is_active": True}).eq("id", link["id"]).execute()
            link["is_active"] = True
        return jsonify({"share_id": link["id"], "is_active": True})

    result = (
        sb.table("shared_links")
        .insert({
            "meeting_id": meeting_id,
            "user_id": current_user.id,
        })
        .execute()
    )
    link = result.data[0]
    return jsonify({"share_id": link["id"], "is_active": True}), 201


@share_bp.route("/api/recordings/<meeting_id>/share", methods=["DELETE"])
@login_required
def revoke_share(meeting_id):
    """Revoke (deactivate) the share link for a meeting."""
    sb = get_supabase()
    sb.table("shared_links").update({"is_active": False}).eq(
        "meeting_id", meeting_id
    ).eq("user_id", current_user.id).execute()
    return jsonify({"message": "Share link revoked"})


@share_bp.route("/api/recordings/<meeting_id>/share", methods=["GET"])
@login_required
def get_share_status(meeting_id):
    """Check if a share link exists for a meeting."""
    sb = get_supabase()
    result = (
        sb.table("shared_links")
        .select("id, is_active")
        .eq("meeting_id", meeting_id)
        .eq("user_id", current_user.id)
        .execute()
    )
    if result.data:
        link = result.data[0]
        return jsonify({"share_id": link["id"], "is_active": link["is_active"]})
    return jsonify({"share_id": None, "is_active": False})


# ---------------------------------------------------------------------------
# Public: serve shared page
# ---------------------------------------------------------------------------

@share_bp.route("/share/<share_id>")
def shared_page(share_id):
    """Serve the standalone shared meeting page."""
    link = _get_share_link(share_id)
    if not link:
        return render_template("shared_404.html"), 404

    meeting = _get_meeting_by_id(link["meeting_id"])
    meeting_title = meeting["title"] if meeting else "Shared Meeting"

    return render_template("shared.html", share_id=share_id, meeting_title=meeting_title)


# ---------------------------------------------------------------------------
# Public: meeting data API
# ---------------------------------------------------------------------------

@share_bp.route("/api/share/<share_id>")
def get_shared_meeting(share_id):
    """Return meeting data for a valid share link (no auth required)."""
    link = _get_share_link(share_id)
    if not link:
        return jsonify({"error": "Share link not found or expired"}), 404

    meeting = _get_meeting_by_id(link["meeting_id"])
    if not meeting:
        return jsonify({"error": "Meeting not found"}), 404

    # Resolve meeting type name
    meeting_type_name = None
    if meeting.get("meeting_type_id"):
        sb = get_supabase()
        mt = sb.table("meeting_types").select("name").eq("id", meeting["meeting_type_id"]).execute()
        if mt.data:
            meeting_type_name = mt.data[0]["name"]

    # Resolve owner display name
    sb = get_supabase()
    owner = sb.table("users").select("display_name").eq("id", link["user_id"]).execute()
    owner_name = owner.data[0]["display_name"] if owner.data else "Unknown"

    # Backfill stable IDs on action items for existing meetings
    summary = meeting.get("summary")
    if summary and ensure_action_item_ids(summary):
        sb = get_supabase()
        sb.table("meetings").update({"summary": summary}).eq("id", meeting["id"]).execute()
        meeting["summary"] = summary

    # Generate signed audio URL for playback
    audio_url = None
    if meeting.get("audio_path"):
        try:
            audio_url = get_signed_url(meeting["audio_path"])
        except Exception as exc:
            logger.warning("Failed to generate shared audio URL: %s", exc)

    return jsonify({
        "meeting": {
            "id": meeting["id"],
            "title": meeting["title"],
            "summary": meeting.get("summary"),
            "transcript": meeting.get("transcript"),
            "transcript_segments": meeting.get("transcript_segments"),
            "audio_url": audio_url,
            "duration_seconds": meeting.get("duration_seconds"),
            "recorded_at": meeting.get("recorded_at"),
            "updated_at": meeting.get("updated_at"),
            "status": meeting.get("status"),
            "meeting_type_name": meeting_type_name,
        },
        "shared_by": owner_name,
    })


# ---------------------------------------------------------------------------
# Public: action item editing via share link
# ---------------------------------------------------------------------------

@share_bp.route("/api/share/<share_id>/action-items/<item_id>", methods=["PATCH"])
def patch_shared_action_item(share_id, item_id):
    """Update an action item via a shared link (no auth required)."""
    link = _get_share_link(share_id)
    if not link:
        return jsonify({"error": "Share link not found or expired"}), 404

    meeting = _get_meeting_by_id(link["meeting_id"])
    if not meeting:
        return jsonify({"error": "Meeting not found"}), 404

    data = request.get_json(force=True) or {}
    try:
        summary = update_action_item(
            meeting, item_id, data,
            changed_by_type="shared",
            changed_by_name="Shared link user",
        )
        return jsonify({"summary": summary})
    except KeyError as exc:
        return jsonify({"error": str(exc)}), 404
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.error("Failed to update shared action item: %s", exc)
        return jsonify({"error": f"Failed to update: {exc}"}), 503


@share_bp.route("/api/share/<share_id>/action-items", methods=["POST"])
def post_shared_action_item(share_id):
    """Create a new action item via a shared link (no auth required)."""
    link = _get_share_link(share_id)
    if not link:
        return jsonify({"error": "Share link not found or expired"}), 404

    meeting = _get_meeting_by_id(link["meeting_id"])
    if not meeting:
        return jsonify({"error": "Meeting not found"}), 404

    data = request.get_json(force=True) or {}
    try:
        new_item, summary = create_action_item(
            meeting, data,
            changed_by_type="shared",
            changed_by_name="Shared link user",
        )
        return jsonify({"item": new_item, "summary": summary}), 201
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.error("Failed to create shared action item: %s", exc)
        return jsonify({"error": f"Failed to create: {exc}"}), 503


@share_bp.route("/api/share/<share_id>/action-items/reorder", methods=["PUT"])
def reorder_shared_action_items(share_id):
    """Reorder action items via a shared link."""
    link = _get_share_link(share_id)
    if not link:
        return jsonify({"error": "Share link not found or expired"}), 404

    meeting = _get_meeting_by_id(link["meeting_id"])
    if not meeting:
        return jsonify({"error": "Meeting not found"}), 404

    data = request.get_json(force=True) or {}
    ordered_ids = data.get("ordered_ids")
    if not ordered_ids or not isinstance(ordered_ids, list):
        return jsonify({"error": "ordered_ids array required"}), 400

    try:
        summary = reorder_action_items(meeting, ordered_ids)
        return jsonify({"summary": summary})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.error("Failed to reorder shared action items: %s", exc)
        return jsonify({"error": f"Failed to reorder: {exc}"}), 503


@share_bp.route("/api/share/<share_id>/action-items/history", methods=["GET"])
def get_shared_action_items_history(share_id):
    """Fetch action item history via a shared link."""
    link = _get_share_link(share_id)
    if not link:
        return jsonify({"error": "Share link not found or expired"}), 404

    history = get_action_item_history(link["meeting_id"])
    return jsonify({"history": history})


# ---------------------------------------------------------------------------
# Public: comments via share link
# ---------------------------------------------------------------------------

@share_bp.route("/api/share/<share_id>/comments", methods=["GET"])
def get_shared_comments(share_id):
    """List comments for a shared meeting."""
    link = _get_share_link(share_id)
    if not link:
        return jsonify({"error": "Share link not found or expired"}), 404

    sb = get_supabase()
    result = (
        sb.table("meeting_comments")
        .select("*")
        .eq("meeting_id", link["meeting_id"])
        .order("created_at")
        .execute()
    )
    return jsonify({"comments": result.data or []})


@share_bp.route("/api/share/<share_id>/comments", methods=["POST"])
def post_shared_comment(share_id):
    """Create a comment via a shared link (no auth required)."""
    link = _get_share_link(share_id)
    if not link:
        return jsonify({"error": "Share link not found or expired"}), 404

    data = request.get_json(force=True) or {}
    raw_content = (data.get("content") or "").strip()
    if not raw_content:
        return jsonify({"error": "Comment content is required"}), 400

    clean_content = bleach.clean(raw_content, tags=COMMENT_ALLOWED_TAGS, strip=True)
    if not clean_content.strip():
        return jsonify({"error": "Comment content is required"}), 400

    commenter_name = (data.get("commenter_name") or "").strip() or "Shared User"

    sb = get_supabase()
    try:
        result = (
            sb.table("meeting_comments")
            .insert({
                "meeting_id": link["meeting_id"],
                "commenter_type": "shared",
                "commenter_name": commenter_name,
                "content": clean_content,
            })
            .execute()
        )
        return jsonify({"comment": result.data[0]}), 201
    except Exception as exc:
        logger.error("Failed to create shared comment: %s", exc)
        return jsonify({"error": f"Failed to create comment: {exc}"}), 503


# ---------------------------------------------------------------------------
# Public: ephemeral chat (no persistence, context sent per request)
# ---------------------------------------------------------------------------

@share_bp.route("/api/share/<share_id>/chat", methods=["POST"])
def shared_chat(share_id):
    """
    Ephemeral AI chat for shared meetings.
    Request body: { "message": "...", "history": [{"role":"user","content":"..."},…] }
    Streams SSE response. History is NOT persisted -- the client sends it each time.
    """
    link = _get_share_link(share_id)
    if not link:
        return jsonify({"error": "Share link not found or expired"}), 404

    meeting = _get_meeting_by_id(link["meeting_id"])
    if not meeting:
        return jsonify({"error": "Meeting not found"}), 404

    if meeting.get("status") != "complete":
        return jsonify({"error": "Meeting must be fully summarized before chatting"}), 400

    data = request.get_json(force=True) or {}
    user_message = (data.get("message") or "").strip()
    if not user_message:
        return jsonify({"error": "Message is required"}), 400

    history = data.get("history") or []
    # Sanitize history to only role+content
    clean_history = [
        {"role": h["role"], "content": h["content"]}
        for h in history
        if isinstance(h, dict) and h.get("role") in ("user", "assistant") and h.get("content")
    ]

    def generate():
        try:
            for chunk in stream_chat_response(meeting, clean_history, user_message):
                yield f"data: {json.dumps(chunk)}\n\n"
        except RuntimeError as exc:
            logger.error("Shared chat stream error: %s", exc)
            yield f"data: {json.dumps('Sorry, I encountered an error. Please try again.')}\n\n"
        yield "data: [DONE]\n\n"

    return Response(
        stream_with_context(generate()),
        content_type="text/event-stream; charset=utf-8",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
