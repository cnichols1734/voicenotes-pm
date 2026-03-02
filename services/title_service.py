"""
VoiceNotes PM - AI meeting title generation service.
Generates a concise meeting title from a transcript using OpenRouter.
"""
import logging

import requests

from config import Config

logger = logging.getLogger(__name__)

OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"

TITLE_PROMPT = """Generate a short, descriptive title for this meeting based on the transcript below. The title should:
- Be 3-8 words long
- Capture the main topic or purpose of the meeting
- Be professional and clear
- NOT include the word "Meeting" unless it's essential for clarity
- NOT use quotes around the title

Respond with ONLY the title text, nothing else.

TRANSCRIPT:
{transcript}"""


def generate_title(transcript: str) -> str:
    """
    Generate a concise meeting title from a transcript using OpenRouter.
    Uses only the first ~2000 chars of the transcript to keep the request fast.
    """
    # Truncate transcript to keep the call fast
    truncated = transcript[:2000] if len(transcript) > 2000 else transcript

    headers = {
        "Authorization": f"Bearer {Config.OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://voicenotes-pm.railway.app",
        "X-Title": "VoiceNotes PM",
    }

    payload = {
        "model": Config.OPENROUTER_MODEL,
        "messages": [
            {"role": "system", "content": TITLE_PROMPT.replace("{transcript}", truncated)},
            {"role": "user", "content": "Generate a title for this meeting."},
        ],
        "temperature": 0.5,
        "max_tokens": 30,
    }

    try:
        response = requests.post(
            OPENROUTER_ENDPOINT,
            headers=headers,
            json=payload,
            timeout=30,
        )
        response.raise_for_status()
        title = response.json()["choices"][0]["message"]["content"].strip()
        # Clean up any quotes the model might add
        title = title.strip('"').strip("'").strip()
        # Enforce reasonable length
        if len(title) > 80:
            title = title[:77] + "..."
        return title
    except Exception as exc:
        logger.error("Title generation failed: %s", exc)
        raise RuntimeError(f"Title generation failed: {exc}") from exc
