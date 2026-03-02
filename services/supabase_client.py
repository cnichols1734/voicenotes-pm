"""
VoiceNotes PM - Supabase client factory.
Returns a configured Supabase client for database access.
"""
from supabase import create_client, Client
from config import Config


def get_supabase() -> Client:
    """Create and return a Supabase client using environment-configured credentials."""
    return create_client(Config.SUPABASE_URL, Config.SUPABASE_KEY)
