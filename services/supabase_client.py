"""
VoiceNotes PM - Supabase client factory.
Returns a cached Supabase client for database access.
"""
import threading

from supabase import create_client, Client
from config import Config

_client: Client | None = None
_lock = threading.Lock()


def get_supabase() -> Client:
    """Return a shared Supabase client, creating it once on first call."""
    global _client
    if _client is None:
        with _lock:
            if _client is None:
                _client = create_client(Config.SUPABASE_URL, Config.SUPABASE_KEY)
    return _client
