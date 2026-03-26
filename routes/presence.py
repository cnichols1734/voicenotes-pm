"""
VoiceNotes PM - Presence and live-update polling routes.
Tracks who is viewing a meeting and provides lightweight version checks
so clients can detect when meeting data has changed.
"""
import hashlib
import logging
from datetime import datetime, timezone, timedelta

from flask import Blueprint, jsonify, request
from flask_login import login_required, current_user

from services.supabase_client import get_supabase

logger = logging.getLogger(__name__)

presence_bp = Blueprint("presence", __name__)

PRESENCE_TTL_SECONDS = 15

AVATAR_COLORS = [
    "#4A90D9", "#E85D75", "#50C878", "#F5A623", "#9B59B6",
    "#1ABC9C", "#E74C3C", "#3498DB", "#2ECC71", "#E67E22",
    "#8E44AD", "#16A085", "#D35400", "#2980B9", "#27AE60",
]


def _color_for_viewer(viewer_id: str) -> str:
    idx = int(hashlib.md5(viewer_id.encode()).hexdigest(), 16) % len(AVATAR_COLORS)
    return AVATAR_COLORS[idx]


def _initials(name: str) -> str:
    parts = name.strip().split()
    if len(parts) >= 2:
        return (parts[0][0] + parts[-1][0]).upper()
    return name[:2].upper() if name else "?"


def _get_active_viewers(meeting_id: str, exclude_viewer_id: str = None):
    sb = get_supabase()
    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=PRESENCE_TTL_SECONDS)).isoformat()
    result = (
        sb.table("meeting_presence")
        .select("viewer_id, viewer_type, display_name, avatar_color")
        .eq("meeting_id", meeting_id)
        .gte("last_seen_at", cutoff)
        .execute()
    )
    viewers = []
    for row in (result.data or []):
        if exclude_viewer_id and row["viewer_id"] == exclude_viewer_id:
            continue
        viewers.append({
            "viewer_id": row["viewer_id"],
            "viewer_type": row["viewer_type"],
            "display_name": row["display_name"],
            "initials": _initials(row["display_name"]),
            "color": row["avatar_color"],
        })
    return viewers


def _upsert_presence(meeting_id: str, viewer_type: str, viewer_id: str, display_name: str):
    sb = get_supabase()
    color = _color_for_viewer(viewer_id)
    now = datetime.now(timezone.utc).isoformat()
    sb.table("meeting_presence").upsert(
        {
            "meeting_id": meeting_id,
            "viewer_type": viewer_type,
            "viewer_id": viewer_id,
            "display_name": display_name,
            "avatar_color": color,
            "last_seen_at": now,
        },
        on_conflict="meeting_id,viewer_id",
    ).execute()


def _get_meeting_updated_at(meeting_id: str):
    sb = get_supabase()
    result = (
        sb.table("meetings")
        .select("updated_at")
        .eq("id", meeting_id)
        .execute()
    )
    if result.data:
        return result.data[0]["updated_at"]
    return None


def _remove_presence(meeting_id: str, viewer_id: str):
    sb = get_supabase()
    sb.table("meeting_presence").delete().eq(
        "meeting_id", meeting_id
    ).eq("viewer_id", viewer_id).execute()


# ---------------------------------------------------------------------------
# Authenticated: heartbeat (combined presence + version poll)
# ---------------------------------------------------------------------------

@presence_bp.route("/api/presence/<meeting_id>/heartbeat", methods=["POST"])
@login_required
def authenticated_heartbeat(meeting_id):
    """
    Heartbeat from an authenticated user viewing a meeting.
    Updates presence and returns active viewers + meeting version.
    """
    sb = get_supabase()
    meeting = (
        sb.table("meetings")
        .select("id, updated_at")
        .eq("id", meeting_id)
        .eq("user_id", current_user.id)
        .execute()
    )
    if not meeting.data:
        return jsonify({"error": "Meeting not found"}), 404

    viewer_id = str(current_user.id)
    _upsert_presence(meeting_id, "user", viewer_id, current_user.display_name)

    viewers = _get_active_viewers(meeting_id, exclude_viewer_id=viewer_id)
    updated_at = meeting.data[0]["updated_at"]

    return jsonify({
        "viewers": viewers,
        "meeting_updated_at": updated_at,
    })


@presence_bp.route("/api/presence/<meeting_id>/leave", methods=["POST"])
@login_required
def authenticated_leave(meeting_id):
    """Remove presence when user navigates away."""
    _remove_presence(meeting_id, str(current_user.id))
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Shared link: heartbeat (combined presence + version poll)
# ---------------------------------------------------------------------------

@presence_bp.route("/api/share/<share_id>/presence/heartbeat", methods=["POST"])
def shared_heartbeat(share_id):
    """
    Heartbeat from a shared-link viewer.
    Expects JSON body: { "viewer_id": "...", "display_name": "..." }
    """
    sb = get_supabase()
    link = (
        sb.table("shared_links")
        .select("meeting_id")
        .eq("id", share_id)
        .eq("is_active", True)
        .execute()
    )
    if not link.data:
        return jsonify({"error": "Share link not found"}), 404

    meeting_id = link.data[0]["meeting_id"]
    data = request.get_json(force=True) or {}
    viewer_id = data.get("viewer_id", "")
    display_name = data.get("display_name", "Guest")

    if not viewer_id:
        return jsonify({"error": "viewer_id required"}), 400

    _upsert_presence(meeting_id, "shared", viewer_id, display_name)

    viewers = _get_active_viewers(meeting_id, exclude_viewer_id=viewer_id)
    updated_at = _get_meeting_updated_at(meeting_id)

    return jsonify({
        "viewers": viewers,
        "meeting_updated_at": updated_at,
    })


@presence_bp.route("/api/share/<share_id>/presence/leave", methods=["POST"])
def shared_leave(share_id):
    """Remove shared-link viewer presence."""
    sb = get_supabase()
    link = (
        sb.table("shared_links")
        .select("meeting_id")
        .eq("id", share_id)
        .eq("is_active", True)
        .execute()
    )
    if not link.data:
        return jsonify({"error": "Share link not found"}), 404

    data = request.get_json(force=True) or {}
    viewer_id = data.get("viewer_id", "")
    if viewer_id:
        _remove_presence(link.data[0]["meeting_id"], viewer_id)
    return jsonify({"ok": True})
