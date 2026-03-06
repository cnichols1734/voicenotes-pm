"""
VoiceNotes PM - Stateless mobile API routes.

These endpoints let the iOS app use the same AI backend stack as the web app
without requiring Supabase meeting records or session auth.
"""
import hmac
import json
import logging
from functools import wraps

from flask import Blueprint, Response, jsonify, request, stream_with_context

from config import Config
from services.chat_service import stream_chat_response
from services.summarizer_service import summarize_transcript
from services.title_service import generate_title
from services.whisper_service import transcribe_audio

logger = logging.getLogger(__name__)

mobile_bp = Blueprint("mobile", __name__, url_prefix="/api/mobile")


def require_api_key(func):
    """Protect mobile routes with a shared API key."""

    @wraps(func)
    def wrapper(*args, **kwargs):
        expected = Config.MOBILE_API_KEY.strip()
        provided = (request.headers.get("X-API-Key") or "").strip()

        if not expected:
            logger.error("MOBILE_API_KEY is not configured.")
            return jsonify({"error": "Mobile API is not configured"}), 503

        if not provided or not hmac.compare_digest(provided, expected):
            return jsonify({"error": "Invalid API key"}), 401

        return func(*args, **kwargs)

    return wrapper


@mobile_bp.route("/transcribe", methods=["POST"])
@require_api_key
def transcribe():
    """Transcribe a mobile-uploaded audio blob and return text."""
    if "audio" not in request.files:
        return jsonify({"error": "No audio file provided"}), 400

    audio_file = request.files["audio"]
    audio_bytes = audio_file.read()

    if len(audio_bytes) < 500:
        return jsonify({"text": ""})

    file_format = request.form.get("format", "webm")

    try:
        transcript = transcribe_audio(audio_bytes, file_format=file_format)
        return jsonify({"text": transcript})
    except Exception as exc:
        logger.error("Mobile transcription failed: %s", exc)
        return jsonify({"error": "Transcription failed", "detail": str(exc)}), 502


@mobile_bp.route("/summarize", methods=["POST"])
@require_api_key
def summarize():
    """Summarize a transcript using the shared backend LLM stack."""
    data = request.get_json(force=True) or {}
    transcript = (data.get("transcript") or "").strip()
    prompt_template = (data.get("prompt_template") or "").strip()

    if not transcript or not prompt_template:
        return jsonify({"error": "transcript and prompt_template are required"}), 400

    try:
        summary = summarize_transcript(transcript, prompt_template)
        return jsonify({"summary": summary})
    except Exception as exc:
        logger.error("Mobile summarization failed: %s", exc)
        return jsonify({
            "error": "Summarization failed",
            "detail": str(exc),
            "hint": "If the free model is unavailable, update OPENROUTER_MODEL in /api/settings/model",
        }), 502


@mobile_bp.route("/generate-title", methods=["POST"])
@require_api_key
def generate_meeting_title():
    """Generate a title for a transcript without a database meeting record."""
    data = request.get_json(force=True) or {}
    transcript = (data.get("transcript") or "").strip()

    if not transcript:
        return jsonify({"error": "transcript is required"}), 400

    try:
        title = generate_title(transcript)
        return jsonify({"title": title})
    except Exception as exc:
        logger.error("Mobile title generation failed: %s", exc)
        return jsonify({"error": f"Failed to generate title: {exc}"}), 502


@mobile_bp.route("/chat", methods=["POST"])
@require_api_key
def chat():
    """Stream a meeting chat response without persisting anything server-side."""
    data = request.get_json(force=True) or {}
    transcript = (data.get("transcript") or "").strip()
    message = (data.get("message") or "").strip()

    if not transcript:
        return jsonify({"error": "transcript is required"}), 400
    if not message:
        return jsonify({"error": "message is required"}), 400

    raw_history = data.get("history") or []
    history = []
    for item in raw_history:
        if not isinstance(item, dict):
            continue
        role = (item.get("role") or "").strip()
        content = (item.get("content") or "").strip()
        if role in {"user", "assistant"} and content:
            history.append({"role": role, "content": content})

    meeting = {
        "title": (data.get("title") or "Untitled").strip() or "Untitled",
        "recorded_at": (data.get("recorded_at") or "Unknown").strip() or "Unknown",
        "meeting_type": (data.get("meeting_type") or "General").strip() or "General",
        "transcript": transcript,
        "summary": data.get("summary") or {},
    }

    def generate():
        try:
            for chunk in stream_chat_response(meeting, history, message):
                yield f"data: {json.dumps(chunk)}\n\n"
        except RuntimeError as exc:
            logger.error("Mobile chat stream error: %s", exc)
            error_msg = "Sorry, I encountered an error processing your question. Please try again."
            yield f"data: {json.dumps(error_msg)}\n\n"

        yield "data: [DONE]\n\n"

    return Response(
        stream_with_context(generate()),
        content_type="text/event-stream; charset=utf-8",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
