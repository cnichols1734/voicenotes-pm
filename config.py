"""
VoiceNotes PM - Configuration.
Loads settings from environment variables.
"""
import os


class Config:
    """Application configuration loaded from environment variables."""

    SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
    SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")
    OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
    OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
    OPENROUTER_MODEL = os.environ.get("OPENROUTER_MODEL", "qwen/qwen3-235b-a22b:free")
    SECRET_KEY = os.environ.get("SECRET_KEY", "dev-secret-key-change-in-production")
    FLASK_ENV = os.environ.get("FLASK_ENV", "development")
