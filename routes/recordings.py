"""
Recordings routes - CRUD for meetings/recordings.
"""
from flask import Blueprint, jsonify, request

recordings_bp = Blueprint("recordings", __name__, url_prefix="/api/recordings")


@recordings_bp.route("/", methods=["GET"])
def list_recordings():
    """List all recordings/meetings."""
    return jsonify({"recordings": [], "message": "TODO: Implement"})


@recordings_bp.route("/", methods=["POST"])
def create_recording():
    """Create a new recording entry."""
    return jsonify({"recording": {}, "message": "TODO: Implement"}), 201


@recordings_bp.route("/<int:recording_id>", methods=["GET"])
def get_recording(recording_id):
    """Get a single recording with transcript and summary."""
    return jsonify({"recording": {}, "message": "TODO: Implement"})


@recordings_bp.route("/<int:recording_id>", methods=["PUT"])
def update_recording(recording_id):
    """Update a recording (e.g., title, folder)."""
    return jsonify({"recording": {}, "message": "TODO: Implement"})


@recordings_bp.route("/<int:recording_id>", methods=["DELETE"])
def delete_recording(recording_id):
    """Delete a recording."""
    return jsonify({"message": "TODO: Implement"}), 204
