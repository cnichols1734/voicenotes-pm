"""
VoiceNotes PM - Settings and utility API routes.
"""
import logging
import os

from flask import Blueprint, jsonify, request
from flask_login import login_required

from config import Config

logger = logging.getLogger(__name__)

api_bp = Blueprint("api", __name__, url_prefix="/api")


# ---------------------------------------------------------------------------
# GET /api/health
# ---------------------------------------------------------------------------
@api_bp.route("/health", methods=["GET"])
def health():
    """Health check endpoint. Returns 200 if the app is running."""
    return jsonify({"status": "ok", "version": "1.1.0"})


# ---------------------------------------------------------------------------
# GET /api/settings
# ---------------------------------------------------------------------------
@api_bp.route("/settings", methods=["GET"])
@login_required
def get_settings():
    """Return current non-sensitive app configuration."""
    return jsonify({
        "openrouter_model": Config.OPENROUTER_MODEL,
        "flask_env": Config.FLASK_ENV,
        "supabase_configured": bool(Config.SUPABASE_URL and Config.SUPABASE_KEY),
        "openai_configured": bool(Config.OPENAI_API_KEY),
        "openrouter_configured": bool(Config.OPENROUTER_API_KEY),
    })


# ---------------------------------------------------------------------------
# POST /api/settings/model
# ---------------------------------------------------------------------------
@api_bp.route("/settings/model", methods=["POST"])
@login_required
def update_model():
    """Update the OpenRouter model used for summarization (runtime only)."""
    data = request.get_json(force=True) or {}
    model = data.get("model", "").strip()
    if not model:
        return jsonify({"error": "model is required"}), 400

    # Update at runtime (persists for the lifetime of this process)
    Config.OPENROUTER_MODEL = model
    os.environ["OPENROUTER_MODEL"] = model
    logger.info("OpenRouter model updated to: %s", model)
    return jsonify({"message": f"Model updated to {model}", "model": model})
