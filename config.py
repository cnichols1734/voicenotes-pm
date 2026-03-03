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
    WHISPER_BASE_URL = os.environ.get("WHISPER_BASE_URL", "")  # e.g. http://localhost:8178 or https://your-tunnel.trycloudflare.com
    WHISPER_API_KEY = os.environ.get("WHISPER_API_KEY", "lm-studio")  # LM Studio doesn't need a real key
    OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
    OPENROUTER_MODEL = os.environ.get("OPENROUTER_MODEL", "minimax/minimax-m2.5")
    LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "")  # e.g. https://your-tunnel.trycloudflare.com/v1
    LLM_MODEL = os.environ.get("LLM_MODEL", "qwen3.5-4b")  # model loaded in LM Studio
    SECRET_KEY = os.environ.get("SECRET_KEY", "dev-secret-key-change-in-production")
    FLASK_ENV = os.environ.get("FLASK_ENV", "development")
    ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "chrisnichols17@gmail.com").lower().strip()
