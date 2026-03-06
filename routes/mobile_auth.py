"""
VoiceNotes PM - JSON auth routes for mobile clients.
"""
import logging

from flask import Blueprint, jsonify, request, g

from services.mobile_auth_service import (
    authenticate_mobile_access_token,
    login_mobile_user,
    refresh_mobile_session,
    register_mobile_user,
    revoke_mobile_session,
)

logger = logging.getLogger(__name__)

mobile_auth_bp = Blueprint("mobile_auth", __name__, url_prefix="/api/mobile/auth")


def _bearer_token() -> str | None:
    header = (request.headers.get("Authorization") or "").strip()
    if not header.startswith("Bearer "):
        return None
    return header[7:].strip() or None


def _device_name() -> str | None:
    return (request.get_json(silent=True) or {}).get("device_name")


@mobile_auth_bp.route("/register", methods=["POST"])
def register():
    data = request.get_json(force=True) or {}
    email = (data.get("email") or "").strip()
    display_name = (data.get("display_name") or "").strip()
    password = data.get("password") or ""

    try:
        payload = register_mobile_user(
            email=email,
            password=password,
            display_name=display_name,
            device_name=_device_name(),
        )
        return jsonify(payload), 201
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.error("Mobile registration failed: %s", exc)
        return jsonify({"error": "Registration failed."}), 500


@mobile_auth_bp.route("/login", methods=["POST"])
def login():
    data = request.get_json(force=True) or {}
    email = (data.get("email") or "").strip()
    password = data.get("password") or ""

    try:
        payload = login_mobile_user(
            email=email,
            password=password,
            device_name=_device_name(),
        )
        return jsonify(payload)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 401
    except Exception as exc:
        logger.error("Mobile login failed: %s", exc)
        return jsonify({"error": "Login failed."}), 500


@mobile_auth_bp.route("/refresh", methods=["POST"])
def refresh():
    data = request.get_json(force=True) or {}
    refresh_token = (data.get("refresh_token") or "").strip()
    if not refresh_token:
        return jsonify({"error": "refresh_token is required"}), 400

    try:
        payload = refresh_mobile_session(refresh_token)
        return jsonify(payload)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 401
    except Exception as exc:
        logger.error("Mobile token refresh failed: %s", exc)
        return jsonify({"error": "Token refresh failed."}), 500


@mobile_auth_bp.route("/me", methods=["GET"])
def me():
    token = _bearer_token()
    if not token:
        return jsonify({"error": "Missing bearer token."}), 401

    try:
        user, session = authenticate_mobile_access_token(token)
        g.mobile_user = user
        g.mobile_session = session
        return jsonify(
            {
                "user": {
                    "id": str(user.id),
                    "email": user.email,
                    "display_name": user.display_name,
                    "role": user.role,
                }
            }
        )
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 401
    except Exception as exc:
        logger.error("Mobile me lookup failed: %s", exc)
        return jsonify({"error": "Failed to load user."}), 500


@mobile_auth_bp.route("/logout", methods=["POST"])
def logout():
    token = _bearer_token()
    if not token:
        return jsonify({"error": "Missing bearer token."}), 401

    try:
        _, session = authenticate_mobile_access_token(token)
        revoke_mobile_session(session["id"])
        return jsonify({"ok": True})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 401
    except Exception as exc:
        logger.error("Mobile logout failed: %s", exc)
        return jsonify({"error": "Logout failed."}), 500
