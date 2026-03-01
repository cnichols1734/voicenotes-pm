"""
API routes - Upload audio, trigger transcription, trigger summary.
"""
from flask import Blueprint, jsonify, request

api_bp = Blueprint("api", __name__, url_prefix="/api")


@api_bp.route("/upload", methods=["POST"])
def upload_audio():
    """Upload audio file and store for transcription."""
    return jsonify({"id": None, "message": "TODO: Implement"}), 201


@api_bp.route("/transcribe", methods=["POST"])
def trigger_transcription():
    """Trigger transcription for an uploaded recording."""
    return jsonify({"transcript": "", "message": "TODO: Implement"})


@api_bp.route("/summarize", methods=["POST"])
def trigger_summary():
    """Trigger AI summarization for a transcript."""
    return jsonify({"summary": {}, "message": "TODO: Implement"})
