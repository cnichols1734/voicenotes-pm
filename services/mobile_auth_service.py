"""
VoiceNotes PM - Mobile authentication service.

Issues short-lived access tokens and refresh-token-backed sessions for iOS clients.
"""
from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from config import Config
from services.auth_service import (
    User,
    check_password,
    create_user,
    get_user_by_email,
    get_user_by_id,
)
from services.seed_defaults import seed_meeting_types_for_user
from services.supabase_client import get_supabase


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _isoformat(dt: datetime) -> str:
    return dt.isoformat()


def _serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(
        secret_key=Config.SECRET_KEY,
        salt=Config.MOBILE_ACCESS_TOKEN_SALT,
    )


def _hash_refresh_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _serialize_user(user: User) -> dict:
    return {
        "id": str(user.id),
        "email": user.email,
        "display_name": user.display_name,
        "role": user.role,
    }


def _access_token_for(user_id: str, session_id: str) -> str:
    payload = {"sub": str(user_id), "sid": str(session_id), "type": "access"}
    return _serializer().dumps(payload)


def _access_payload(token: str) -> dict:
    try:
        payload = _serializer().loads(
            token, max_age=Config.MOBILE_ACCESS_TOKEN_TTL_SECONDS
        )
    except SignatureExpired as exc:
        raise ValueError("Access token expired.") from exc
    except BadSignature as exc:
        raise ValueError("Invalid access token.") from exc

    if payload.get("type") != "access":
        raise ValueError("Invalid access token.")
    return payload


def _get_session_by_id(session_id: str) -> dict | None:
    supabase = get_supabase()
    result = (
        supabase.table("mobile_auth_sessions")
        .select("*")
        .eq("id", str(session_id))
        .execute()
    )
    return result.data[0] if result.data else None


def _get_active_session_by_refresh_token(refresh_token: str) -> dict | None:
    supabase = get_supabase()
    refresh_hash = _hash_refresh_token(refresh_token)
    result = (
        supabase.table("mobile_auth_sessions")
        .select("*")
        .eq("refresh_token_hash", refresh_hash)
        .is_("revoked_at", "null")
        .execute()
    )
    return result.data[0] if result.data else None


def _session_is_expired(session: dict) -> bool:
    expires_at = session.get("expires_at")
    if not expires_at:
        return True
    try:
        expiry = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
    except ValueError:
        return True
    return expiry <= _utcnow()


def _issue_session_tokens(user: User, session: dict, refresh_token: str) -> dict:
    return {
        "access_token": _access_token_for(user.id, session["id"]),
        "refresh_token": refresh_token,
        "token_type": "Bearer",
        "expires_in": Config.MOBILE_ACCESS_TOKEN_TTL_SECONDS,
        "user": _serialize_user(user),
    }


def _create_session(user: User, device_name: str | None = None) -> dict:
    supabase = get_supabase()
    refresh_token = secrets.token_urlsafe(48)
    now = _utcnow()
    expires_at = now + timedelta(days=Config.MOBILE_REFRESH_TOKEN_TTL_DAYS)

    result = (
        supabase.table("mobile_auth_sessions")
        .insert(
            {
                "user_id": str(user.id),
                "refresh_token_hash": _hash_refresh_token(refresh_token),
                "device_name": (device_name or "").strip() or None,
                "expires_at": _isoformat(expires_at),
                "last_used_at": _isoformat(now),
            }
        )
        .execute()
    )
    session = result.data[0]
    return _issue_session_tokens(user, session, refresh_token)


def register_mobile_user(
    email: str, password: str, display_name: str, device_name: str | None = None
) -> dict:
    email = email.lower().strip()
    display_name = display_name.strip()

    if not email:
        raise ValueError("Email is required.")
    if not display_name:
        raise ValueError("Display name is required.")
    if not password or len(password) < 6:
        raise ValueError("Password must be at least 6 characters.")
    if get_user_by_email(email):
        raise ValueError("An account with that email already exists.")

    user = create_user(email, password, display_name, role="user")
    seed_meeting_types_for_user(user.id)
    return _create_session(user, device_name=device_name)


def login_mobile_user(
    email: str, password: str, device_name: str | None = None
) -> dict:
    user = get_user_by_email(email)
    if user is None or not check_password(password, user._data.get("password_hash", "")):
        raise ValueError("Invalid email or password.")
    if not user.is_active:
        raise ValueError("Your account has been disabled.")
    return _create_session(user, device_name=device_name)


def refresh_mobile_session(refresh_token: str) -> dict:
    session = _get_active_session_by_refresh_token(refresh_token)
    if not session or _session_is_expired(session):
        raise ValueError("Refresh token is invalid or expired.")

    user = get_user_by_id(session["user_id"])
    if user is None or not user.is_active:
        raise ValueError("User account is not available.")

    new_refresh_token = secrets.token_urlsafe(48)
    now = _utcnow()
    expires_at = now + timedelta(days=Config.MOBILE_REFRESH_TOKEN_TTL_DAYS)

    supabase = get_supabase()
    result = (
        supabase.table("mobile_auth_sessions")
        .update(
            {
                "refresh_token_hash": _hash_refresh_token(new_refresh_token),
                "expires_at": _isoformat(expires_at),
                "last_used_at": _isoformat(now),
            }
        )
        .eq("id", session["id"])
        .execute()
    )
    updated_session = result.data[0]
    return _issue_session_tokens(user, updated_session, new_refresh_token)


def authenticate_mobile_access_token(token: str) -> tuple[User, dict]:
    payload = _access_payload(token)
    session = _get_session_by_id(payload["sid"])
    if not session or session.get("revoked_at") or _session_is_expired(session):
        raise ValueError("Session is no longer valid.")

    user = get_user_by_id(payload["sub"])
    if user is None or not user.is_active:
        raise ValueError("User account is not available.")

    supabase = get_supabase()
    supabase.table("mobile_auth_sessions").update(
        {"last_used_at": _isoformat(_utcnow())}
    ).eq("id", session["id"]).execute()

    return user, session


def revoke_mobile_session(session_id: str) -> None:
    supabase = get_supabase()
    supabase.table("mobile_auth_sessions").update(
        {"revoked_at": _isoformat(_utcnow())}
    ).eq("id", str(session_id)).is_("revoked_at", "null").execute()
