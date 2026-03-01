"""
Folders routes - CRUD for folders.
"""
from flask import Blueprint, jsonify, request

folders_bp = Blueprint("folders", __name__, url_prefix="/api/folders")


@folders_bp.route("/", methods=["GET"])
def list_folders():
    """List all folders."""
    return jsonify({"folders": [], "message": "TODO: Implement"})


@folders_bp.route("/", methods=["POST"])
def create_folder():
    """Create a new folder."""
    return jsonify({"folder": {}, "message": "TODO: Implement"}), 201


@folders_bp.route("/<int:folder_id>", methods=["GET"])
def get_folder(folder_id):
    """Get a single folder with its recordings."""
    return jsonify({"folder": {}, "message": "TODO: Implement"})


@folders_bp.route("/<int:folder_id>", methods=["PUT"])
def update_folder(folder_id):
    """Update a folder (e.g., name)."""
    return jsonify({"folder": {}, "message": "TODO: Implement"})


@folders_bp.route("/<int:folder_id>", methods=["DELETE"])
def delete_folder(folder_id):
    """Delete a folder."""
    return jsonify({"message": "TODO: Implement"}), 204
