"""
VoiceNotes PM - AI meeting title generation service.

Supports two backends (same pattern as summarizer_service):
  1. Local LLM (via LM Studio) — tried first if LLM_BASE_URL is set
  2. OpenRouter API — used as fallback, or as primary if no local URL configured
"""
import logging
import time

import openai
import requests

from config import Config

logger = logging.getLogger(__name__)

OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"

TITLE_PROMPT = """Generate a short, descriptive title for this meeting based on the transcript excerpts below. The title should:
- Be 3-8 words long
- Capture the OVERALL main topic or purpose of the entire meeting
- Be professional and clear
- NOT include the word "Meeting" unless it's essential for clarity
- NOT use quotes around the title
- Reflect the full scope of the discussion, not just what was said at the beginning

Respond with ONLY the title text, nothing else.

TRANSCRIPT EXCERPTS:
{transcript}"""

MAX_PROMPT_CHARS = 3000


def _build_messages(transcript: str) -> list:
    """Build the chat messages for title generation.

    Samples from beginning, middle, and end of the transcript so the LLM
    gets a holistic view of the meeting rather than just the opening remarks.
    """
    if len(transcript) <= MAX_PROMPT_CHARS:
        sample = transcript
    else:
        section_budget = MAX_PROMPT_CHARS // 3
        beginning = transcript[:section_budget]
        mid_start = (len(transcript) - section_budget) // 2
        middle = transcript[mid_start:mid_start + section_budget]
        ending = transcript[-section_budget:]
        sample = (
            beginning.rstrip()
            + "\n\n[...]\n\n"
            + middle.strip()
            + "\n\n[...]\n\n"
            + ending.lstrip()
        )

    return [
        {"role": "system", "content": TITLE_PROMPT.replace("{transcript}", sample)},
        {"role": "user", "content": "Generate a title for this meeting."},
    ]


def _clean_title(raw: str) -> str:
    """Clean up and enforce length on a generated title."""
    title = raw.strip().strip('"').strip("'").strip()
    if len(title) > 80:
        title = title[:77] + "..."
    return title


def _generate_local(messages: list) -> str:
    """Generate title using local LM Studio (OpenAI-compatible API)."""
    client = openai.OpenAI(
        api_key="lm-studio",
        base_url=Config.LLM_BASE_URL,
        timeout=30,
    )
    response = client.chat.completions.create(
        model=Config.LLM_MODEL,
        messages=messages,
        temperature=0.5,
    )
    return response.choices[0].message.content


def _generate_openrouter(messages: list) -> str:
    """Generate title using OpenRouter API."""
    headers = {
        "Authorization": f"Bearer {Config.OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://voicenotes-pm.railway.app",
        "X-Title": "VoiceNotes PM",
    }
    payload = {
        "model": Config.OPENROUTER_MODEL,
        "messages": messages,
        "temperature": 0.5,
    }
    response = requests.post(
        OPENROUTER_ENDPOINT,
        headers=headers,
        json=payload,
        timeout=30,
    )
    response.raise_for_status()
    return response.json()["choices"][0]["message"]["content"]


def generate_title(transcript: str) -> str:
    """
    Generate a concise meeting title from a transcript.

    Strategy:
      1. If LLM_BASE_URL is configured, try local LM Studio first.
      2. If local fails, fall back to OpenRouter.
      3. If no local URL, go straight to OpenRouter.
    """
    messages = _build_messages(transcript)
    raw_title = None

    # --- Try local LLM first ---
    if Config.LLM_BASE_URL:
        try:
            logger.info("Generating title via local LLM (%s)...", Config.LLM_MODEL)
            start = time.time()
            raw_title = _generate_local(messages)
            elapsed = time.time() - start
            logger.info("Local LLM title generated in %.1fs.", elapsed)
        except Exception as exc:
            logger.warning("Local LLM title failed: %s. Falling back to OpenRouter.", exc)
            raw_title = None

    # --- Fallback: OpenRouter ---
    if raw_title is None:
        try:
            logger.info("Generating title via OpenRouter (%s)...", Config.OPENROUTER_MODEL)
            start = time.time()
            raw_title = _generate_openrouter(messages)
            elapsed = time.time() - start
            logger.info("OpenRouter title generated in %.1fs.", elapsed)
        except Exception as exc:
            logger.error("OpenRouter title generation failed: %s", exc)
            raise RuntimeError(f"Title generation failed: {exc}") from exc

    title = _clean_title(raw_title)
    logger.info("Generated title: %s", title)
    return title
