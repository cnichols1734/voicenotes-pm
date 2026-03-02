"""
VoiceNotes PM - Folders CRUD routes.
"""
import logging

from flask import Blueprint, jsonify, request

from services.supabase_client import get_supabase

logger = logging.getLogger(__name__)

folders_bp = Blueprint("folders", __name__, url_prefix="/api/folders")


def _supabase_error(message, status=503):
    return jsonify({"error": message}), status


# ---------------------------------------------------------------------------
# GET /api/folders
# ---------------------------------------------------------------------------
@folders_bp.route("/", methods=["GET"])
def list_folders():
    """List all folders ordered by sort_order."""
    try:
        supabase = get_supabase()
        result = supabase.table("folders").select("*").order("sort_order").execute()
        return jsonify({"folders": result.data})
    except Exception as exc:
        logger.error("Failed to list folders: %s", exc)
        return _supabase_error(f"Failed to fetch folders: {exc}")


# ---------------------------------------------------------------------------
# POST /api/folders
# ---------------------------------------------------------------------------
@folders_bp.route("/", methods=["POST"])
def create_folder():
    """Create a new folder."""
    data = request.get_json(force=True) or {}
    name = data.get("name", "").strip()
    if not name:
        return jsonify({"error": "Folder name is required"}), 400

    insert_data = {
        "name": name,
        "color": data.get("color", "#6366f1"),
        "icon": data.get("icon", "📁"),
        "sort_order": data.get("sort_order", 0),
    }

    try:
        supabase = get_supabase()
        result = supabase.table("folders").insert(insert_data).execute()
        return jsonify({"folder": result.data[0]}), 201
    except Exception as exc:
        logger.error("Failed to create folder: %s", exc)
        return _supabase_error(f"Failed to create folder: {exc}")


# ---------------------------------------------------------------------------
# PUT /api/folders/<id>
# ---------------------------------------------------------------------------
@folders_bp.route("/<folder_id>", methods=["PUT"])
def update_folder(folder_id):
    """Update a folder (name, color, icon, sort_order)."""
    data = request.get_json(force=True) or {}
    allowed = {"name", "color", "icon", "sort_order"}
    update_data = {k: v for k, v in data.items() if k in allowed}

    if not update_data:
        return jsonify({"error": "No valid fields provided"}), 400

    try:
        supabase = get_supabase()
        result = (
            supabase.table("folders")
            .update(update_data)
            .eq("id", folder_id)
            .execute()
        )
        if not result.data:
            return jsonify({"error": "Folder not found"}), 404
        return jsonify({"folder": result.data[0]})
    except Exception as exc:
        logger.error("Failed to update folder %s: %s", folder_id, exc)
        return _supabase_error(f"Failed to update folder: {exc}")


# ---------------------------------------------------------------------------
# DELETE /api/folders/<id>
# ---------------------------------------------------------------------------
@folders_bp.route("/<folder_id>", methods=["DELETE"])
def delete_folder(folder_id):
    """
    Delete a folder. Meetings in it have their folder_id set to NULL
    automatically via the ON DELETE SET NULL FK constraint.
    """
    try:
        supabase = get_supabase()
        supabase.table("folders").delete().eq("id", folder_id).execute()
        return jsonify({"message": "Folder deleted"}), 200
    except Exception as exc:
        logger.error("Failed to delete folder %s: %s", folder_id, exc)
        return _supabase_error(f"Failed to delete folder: {exc}")
