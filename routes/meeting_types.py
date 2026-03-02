"""
VoiceNotes PM - Meeting types CRUD + reset routes.
"""
import logging

from flask import Blueprint, jsonify, request

from services.supabase_client import get_supabase

logger = logging.getLogger(__name__)

meeting_types_bp = Blueprint("meeting_types", __name__, url_prefix="/api/meeting-types")


def _supabase_error(message, status=503):
    return jsonify({"error": message}), status


def _get_default_prompt(name: str) -> str:
    """Look up the original seed prompt for a default meeting type by name."""
    from services.seed_defaults import MEETING_TYPE_DEFAULTS
    for mt in MEETING_TYPE_DEFAULTS:
        if mt["name"] == name:
            return mt["prompt_template"]
    return None


# ---------------------------------------------------------------------------
# GET /api/meeting-types
# ---------------------------------------------------------------------------
@meeting_types_bp.route("/", methods=["GET"])
def list_meeting_types():
    """List all meeting types ordered by sort_order."""
    try:
        supabase = get_supabase()
        result = supabase.table("meeting_types").select("*").order("sort_order").execute()
        return jsonify({"meeting_types": result.data})
    except Exception as exc:
        logger.error("Failed to list meeting types: %s", exc)
        return _supabase_error(f"Failed to fetch meeting types: {exc}")


# ---------------------------------------------------------------------------
# GET /api/meeting-types/<id>
# ---------------------------------------------------------------------------
@meeting_types_bp.route("/<meeting_type_id>", methods=["GET"])
def get_meeting_type(meeting_type_id):
    """Get a single meeting type with its full prompt template."""
    try:
        supabase = get_supabase()
        result = (
            supabase.table("meeting_types")
            .select("*")
            .eq("id", meeting_type_id)
            .single()
            .execute()
        )
        if not result.data:
            return jsonify({"error": "Meeting type not found"}), 404
        return jsonify({"meeting_type": result.data})
    except Exception as exc:
        logger.error("Failed to get meeting type %s: %s", meeting_type_id, exc)
        return _supabase_error(f"Failed to fetch meeting type: {exc}")


# ---------------------------------------------------------------------------
# POST /api/meeting-types
# ---------------------------------------------------------------------------
@meeting_types_bp.route("/", methods=["POST"])
def create_meeting_type():
    """Create a new meeting type."""
    data = request.get_json(force=True) or {}
    name = data.get("name", "").strip()
    prompt_template = data.get("prompt_template", "").strip()

    if not name:
        return jsonify({"error": "Name is required"}), 400
    if not prompt_template:
        return jsonify({"error": "Prompt template is required"}), 400

    insert_data = {
        "name": name,
        "icon": data.get("icon", "📋"),
        "description": data.get("description", ""),
        "prompt_template": prompt_template,
        "is_default": False,
        "sort_order": data.get("sort_order", 99),
    }

    try:
        supabase = get_supabase()
        result = supabase.table("meeting_types").insert(insert_data).execute()
        return jsonify({"meeting_type": result.data[0]}), 201
    except Exception as exc:
        logger.error("Failed to create meeting type: %s", exc)
        return _supabase_error(f"Failed to create meeting type: {exc}")


# ---------------------------------------------------------------------------
# PUT /api/meeting-types/<id>
# ---------------------------------------------------------------------------
@meeting_types_bp.route("/<meeting_type_id>", methods=["PUT"])
def update_meeting_type(meeting_type_id):
    """Update a meeting type (name, icon, description, prompt_template)."""
    data = request.get_json(force=True) or {}
    allowed = {"name", "icon", "description", "prompt_template", "sort_order"}
    update_data = {k: v for k, v in data.items() if k in allowed}

    if not update_data:
        return jsonify({"error": "No valid fields provided"}), 400

    try:
        supabase = get_supabase()
        result = (
            supabase.table("meeting_types")
            .update(update_data)
            .eq("id", meeting_type_id)
            .execute()
        )
        if not result.data:
            return jsonify({"error": "Meeting type not found"}), 404
        return jsonify({"meeting_type": result.data[0]})
    except Exception as exc:
        logger.error("Failed to update meeting type %s: %s", meeting_type_id, exc)
        return _supabase_error(f"Failed to update meeting type: {exc}")


# ---------------------------------------------------------------------------
# DELETE /api/meeting-types/<id>
# ---------------------------------------------------------------------------
@meeting_types_bp.route("/<meeting_type_id>", methods=["DELETE"])
def delete_meeting_type(meeting_type_id):
    """Delete a meeting type. Only non-default types can be deleted."""
    try:
        supabase = get_supabase()
        result = (
            supabase.table("meeting_types")
            .select("is_default")
            .eq("id", meeting_type_id)
            .single()
            .execute()
        )
        if not result.data:
            return jsonify({"error": "Meeting type not found"}), 404
        if result.data.get("is_default"):
            return jsonify({"error": "Cannot delete a default meeting type"}), 403

        supabase.table("meeting_types").delete().eq("id", meeting_type_id).execute()
        return jsonify({"message": "Meeting type deleted"}), 200
    except Exception as exc:
        logger.error("Failed to delete meeting type %s: %s", meeting_type_id, exc)
        return _supabase_error(f"Failed to delete meeting type: {exc}")


# ---------------------------------------------------------------------------
# POST /api/meeting-types/<id>/reset
# ---------------------------------------------------------------------------
@meeting_types_bp.route("/<meeting_type_id>/reset", methods=["POST"])
def reset_meeting_type(meeting_type_id):
    """Reset a default meeting type's prompt back to the original seed value."""
    try:
        supabase = get_supabase()
        result = (
            supabase.table("meeting_types")
            .select("*")
            .eq("id", meeting_type_id)
            .single()
            .execute()
        )
        if not result.data:
            return jsonify({"error": "Meeting type not found"}), 404

        meeting_type = result.data
        if not meeting_type.get("is_default"):
            return jsonify({"error": "Only default meeting types can be reset"}), 400

        original_prompt = _get_default_prompt(meeting_type["name"])
        if original_prompt is None:
            return jsonify({"error": "Could not find original prompt for this meeting type"}), 500

        updated = (
            supabase.table("meeting_types")
            .update({"prompt_template": original_prompt})
            .eq("id", meeting_type_id)
            .execute()
        )
        return jsonify({"meeting_type": updated.data[0]})
    except Exception as exc:
        logger.error("Failed to reset meeting type %s: %s", meeting_type_id, exc)
        return _supabase_error(f"Failed to reset meeting type: {exc}")
