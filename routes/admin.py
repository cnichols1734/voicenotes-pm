"""
VoiceNotes PM - Admin routes.
Admin-only panel for managing users and viewing usage stats.
"""
import logging
from functools import wraps

from flask import Blueprint, jsonify, render_template, request
from flask_login import login_required, current_user

from services.supabase_client import get_supabase

logger = logging.getLogger(__name__)

admin_bp = Blueprint("admin", __name__)


def admin_required(f):
    """Decorator that requires the user to be an admin."""
    @wraps(f)
    @login_required
    def decorated(*args, **kwargs):
        if not current_user.is_admin:
            return jsonify({"error": "Admin access required"}), 403
        return f(*args, **kwargs)
    return decorated


@admin_bp.route("/admin")
@admin_required
def admin_page():
    """Render the admin panel page."""
    return render_template("admin.html")


@admin_bp.route("/api/admin/users", methods=["GET"])
@admin_required
def list_users():
    """List all users with their meeting counts."""
    try:
        supabase = get_supabase()

        # Get all users
        users_result = supabase.table("users").select(
            "id, email, display_name, role, is_active, created_at"
        ).order("created_at").execute()

        users = users_result.data or []

        # Get meeting counts per user
        meetings_result = supabase.table("meetings").select(
            "user_id"
        ).execute()

        # Count meetings per user_id
        meeting_counts = {}
        for m in (meetings_result.data or []):
            uid = m.get("user_id")
            if uid:
                meeting_counts[uid] = meeting_counts.get(uid, 0) + 1

        # Attach counts to users
        for user in users:
            user["meeting_count"] = meeting_counts.get(user["id"], 0)

        return jsonify({"users": users})

    except Exception as exc:
        logger.error("Failed to list users: %s", exc)
        return jsonify({"error": f"Failed to list users: {exc}"}), 503


@admin_bp.route("/api/admin/users/<user_id>/toggle", methods=["POST"])
@admin_required
def toggle_user(user_id):
    """Enable or disable a user account."""
    # Prevent admin from disabling themselves
    if user_id == str(current_user.id):
        return jsonify({"error": "You cannot disable your own account"}), 400

    try:
        supabase = get_supabase()

        # Get current status
        result = supabase.table("users").select("is_active").eq("id", user_id).single().execute()
        if not result.data:
            return jsonify({"error": "User not found"}), 404

        new_status = not result.data["is_active"]
        supabase.table("users").update({"is_active": new_status}).eq("id", user_id).execute()

        action = "enabled" if new_status else "disabled"
        logger.info("Admin %s %s user %s", current_user.email, action, user_id)

        return jsonify({"message": f"User {action}", "is_active": new_status})

    except Exception as exc:
        logger.error("Failed to toggle user %s: %s", user_id, exc)
        return jsonify({"error": f"Failed to toggle user: {exc}"}), 503
