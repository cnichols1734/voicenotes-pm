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
    OPENROUTER_MODEL = os.environ.get("OPENROUTER_MODEL", "deepseek/deepseek-v3.2")
    WHISPER_LANGUAGE = os.environ.get("WHISPER_LANGUAGE", "en")
    LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "")  # e.g. https://your-tunnel.trycloudflare.com/v1
    LLM_MODEL = os.environ.get("LLM_MODEL", "qwen3.5-4b")  # model loaded in LM Studio
    MOBILE_ACCESS_TOKEN_TTL_SECONDS = int(
        os.environ.get("MOBILE_ACCESS_TOKEN_TTL_SECONDS", "3600")
    )
    MOBILE_REFRESH_TOKEN_TTL_DAYS = int(
        os.environ.get("MOBILE_REFRESH_TOKEN_TTL_DAYS", "45")
    )
    MOBILE_ACCESS_TOKEN_SALT = os.environ.get(
        "MOBILE_ACCESS_TOKEN_SALT", "mobile-access-token"
    )
    MAX_CONTENT_LENGTH = 200 * 1024 * 1024  # 200 MB max upload (Flask will 413 anything larger)
    SECRET_KEY = os.environ.get("SECRET_KEY", "dev-secret-key-change-in-production")
    FLASK_ENV = os.environ.get("FLASK_ENV", "development")
    ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "chrisnichols17@gmail.com").lower().strip()
