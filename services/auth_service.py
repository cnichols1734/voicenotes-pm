"""
VoiceNotes PM - Authentication service.
Handles user creation, password hashing, and user lookup.
"""

import logging
import bcrypt

from services.supabase_client import get_supabase

logger = logging.getLogger(__name__)


class User:
    """Simple user class compatible with Flask-Login."""

    def __init__(self, data: dict):
        self.id = data.get("id")
        self.email = data.get("email")
        self.display_name = data.get("display_name")
        self.role = data.get("role", "user")
        self.is_active = data.get("is_active", True)
        self.created_at = data.get("created_at")
        self._data = data

    # Flask-Login required properties / methods
    @property
    def is_authenticated(self):
        return True

    @property
    def is_anonymous(self):
        return False

    def get_id(self):
        return str(self.id)

    @property
    def is_admin(self):
        return self.role == "admin"


def hash_password(password: str) -> str:
    """Hash a plaintext password using bcrypt."""
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def check_password(password: str, password_hash: str) -> bool:
    """Verify a plaintext password against a bcrypt hash."""
    return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))


def create_user(
    email: str, password: str, display_name: str, role: str = "user"
) -> User:
    """Create a new user in the database. Returns a User object."""
    supabase = get_supabase()
    pw_hash = hash_password(password)
    result = (
        supabase.table("users")
        .insert(
            {
                "email": email.lower().strip(),
                "password_hash": pw_hash,
                "display_name": display_name.strip(),
                "role": role,
            }
        )
        .execute()
    )
    if not result.data:
        raise RuntimeError(
            "Insert returned no data — this usually means Row Level Security (RLS) "
            "is blocking the operation. Use the service_role key instead of the anon key."
        )
    return User(result.data[0])


def get_user_by_email(email: str):
    """Look up a user by email. Returns User or None."""
    try:
        supabase = get_supabase()
        result = (
            supabase.table("users")
            .select("*")
            .eq("email", email.lower().strip())
            .execute()
        )
        if result.data:
            return User(result.data[0])
    except Exception as exc:
        logger.error("Failed to look up user by email: %s", exc)
    return None


def get_user_by_id(user_id: str):
    """Look up a user by UUID. Returns User or None."""
    try:
        supabase = get_supabase()
        result = supabase.table("users").select("*").eq("id", user_id).execute()
        if result.data:
            return User(result.data[0])
    except Exception as exc:
        logger.error("Failed to look up user by id: %s", exc)
    return None


def get_user_count() -> int:
    """Return total number of registered users."""
    try:
        supabase = get_supabase()
        result = supabase.table("users").select("id", count="exact").execute()
        return result.count if result.count is not None else len(result.data)
    except Exception:
        return 0


def claim_orphan_data(user_id: str):
    """Assign any existing rows with NULL user_id to the given user (admin claim)."""
    try:
        supabase = get_supabase()
        for table in ("meetings", "folders", "meeting_types"):
            supabase.table(table).update({"user_id": user_id}).is_(
                "user_id", "null"
            ).execute()
        logger.info("Claimed orphan data for user %s", user_id)
    except Exception as exc:
        logger.warning("Failed to claim orphan data: %s", exc)


def update_user(user_id: str, display_name: str = None, email: str = None) -> User:
    """Update a user's display name and/or email. Returns updated User."""
    supabase = get_supabase()
    updates = {}
    if display_name is not None:
        updates["display_name"] = display_name.strip()
    if email is not None:
        updates["email"] = email.lower().strip()
    if not updates:
        raise ValueError("No fields to update.")

    result = supabase.table("users").update(updates).eq("id", user_id).execute()
    if not result.data:
        raise ValueError("User not found.")
    return User(result.data[0])


def update_user_password(
    user_id: str, current_password: str, new_password: str
) -> bool:
    """Change a user's password after verifying current password. Returns True on success."""
    supabase = get_supabase()
    result = supabase.table("users").select("*").eq("id", user_id).execute()
    if not result.data:
        raise ValueError("User not found.")

    user_data = result.data[0]
    if not check_password(current_password, user_data.get("password_hash", "")):
        raise ValueError("Current password is incorrect.")

    new_hash = hash_password(new_password)
    supabase.table("users").update({"password_hash": new_hash}).eq(
        "id", user_id
    ).execute()
    return True
