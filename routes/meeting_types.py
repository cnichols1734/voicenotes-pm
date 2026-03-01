"""
Meeting types routes - CRUD for meeting type prompts.
"""
from flask import Blueprint, jsonify, request

meeting_types_bp = Blueprint("meeting_types", __name__, url_prefix="/api/meeting-types")


@meeting_types_bp.route("/", methods=["GET"])
def list_meeting_types():
    """List all meeting type prompts (API)."""
    return jsonify({"meeting_types": [], "message": "TODO: Implement"})


@meeting_types_bp.route("/", methods=["POST"])
def create_meeting_type():
    """Create a new meeting type with prompt template."""
    return jsonify({"meeting_type": {}, "message": "TODO: Implement"}), 201


@meeting_types_bp.route("/<int:meeting_type_id>", methods=["GET"])
def get_meeting_type(meeting_type_id):
    """Get a single meeting type."""
    return jsonify({"meeting_type": {}, "message": "TODO: Implement"})


@meeting_types_bp.route("/<int:meeting_type_id>", methods=["PUT"])
def update_meeting_type(meeting_type_id):
    """Update a meeting type prompt."""
    return jsonify({"meeting_type": {}, "message": "TODO: Implement"})


@meeting_types_bp.route("/<int:meeting_type_id>", methods=["DELETE"])
def delete_meeting_type(meeting_type_id):
    """Delete a meeting type."""
    return jsonify({"message": "TODO: Implement"}), 204
