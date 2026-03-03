"""
VoiceNotes PM - Summarization service.

Supports two backends:
  1. Local LLM (via LM Studio) — tried first if LLM_BASE_URL is set
  2. OpenRouter API — used as fallback, or as primary if no local URL configured

Both backends use the OpenAI chat completions format.
"""
import json
import logging
import re
import time

import openai
import requests

from config import Config

logger = logging.getLogger(__name__)

OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"

FALLBACK_SUMMARY = {
    "executive_summary": "",
    "action_items": [],
    "decisions_made": [],
    "key_discussion_points": [],
    "follow_ups": [],
    "raw_transcript_available": True,
}


def _extract_json(text: str) -> dict:
    """
    Try to parse JSON from the model response.
    Strips markdown code fences if present, then falls back to
    a regex search for the outermost JSON object.
    """
    text = text.strip()

    # Strip markdown fences: ```json ... ``` or ``` ... ```
    fenced = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
    fenced = re.sub(r"\s*```$", "", fenced).strip()
    try:
        return json.loads(fenced)
    except (json.JSONDecodeError, ValueError):
        pass

    # Try to find the first {...} block
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group())
        except (json.JSONDecodeError, ValueError):
            pass

    return None


def _build_messages(transcript: str, prompt_template: str) -> list:
    """Build the chat messages for summarization."""
    system_content = prompt_template.replace("{transcript}", transcript)
    return [
        {"role": "system", "content": system_content},
        {
            "role": "user",
            "content": (
                "Analyze this meeting transcript and provide the structured summary as specified."
            ),
        },
    ]


def _summarize_local(messages: list) -> str:
    """
    Summarize using local LM Studio (OpenAI-compatible API).
    Returns the raw response text.
    """
    client = openai.OpenAI(
        api_key="lm-studio",
        base_url=Config.LLM_BASE_URL,
        timeout=300,  # local models can be slower
    )

    response = client.chat.completions.create(
        model=Config.LLM_MODEL,
        messages=messages,
        temperature=0.3,
    )

    return response.choices[0].message.content


def _summarize_openrouter(messages: list) -> str:
    """
    Summarize using OpenRouter API.
    Returns the raw response text.
    """
    headers = {
        "Authorization": f"Bearer {Config.OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://voicenotes-pm.railway.app",
        "X-Title": "VoiceNotes PM",
    }

    payload = {
        "model": Config.OPENROUTER_MODEL,
        "messages": messages,
        "temperature": 0.3,
    }

    response = requests.post(
        OPENROUTER_ENDPOINT,
        headers=headers,
        json=payload,
        timeout=120,
    )
    response.raise_for_status()

    return response.json()["choices"][0]["message"]["content"]


def summarize_transcript(transcript: str, prompt_template: str) -> dict:
    """
    Summarize a meeting transcript.

    Strategy:
      1. If LLM_BASE_URL is configured, try local LM Studio (Qwen) first.
      2. If local fails, fall back to OpenRouter (Minimax).
      3. If no local URL, go straight to OpenRouter.

    Returns a structured summary dict.
    """
    messages = _build_messages(transcript, prompt_template)
    raw_content = None

    # --- Try local LLM first ---
    if Config.LLM_BASE_URL:
        try:
            logger.info("Trying local LLM (%s) at %s...", Config.LLM_MODEL, Config.LLM_BASE_URL)
            start = time.time()
            raw_content = _summarize_local(messages)
            elapsed = time.time() - start
            logger.info("Local LLM succeeded in %.1fs.", elapsed)
        except Exception as exc:
            logger.warning("Local LLM failed: %s. Falling back to OpenRouter.", exc)
            raw_content = None

    # --- Fallback: OpenRouter ---
    if raw_content is None:
        try:
            logger.info("Using OpenRouter (%s)...", Config.OPENROUTER_MODEL)
            start = time.time()
            raw_content = _summarize_openrouter(messages)
            elapsed = time.time() - start
            logger.info("OpenRouter succeeded in %.1fs.", elapsed)
        except requests.RequestException as exc:
            raise RuntimeError(
                f"OpenRouter API request failed: {exc}. "
                "If the free model is unavailable, try updating OPENROUTER_MODEL in settings."
            ) from exc

    logger.debug("LLM raw response: %s", raw_content[:500] if raw_content else "(empty)")

    parsed = _extract_json(raw_content)
    if parsed is not None:
        result = {**FALLBACK_SUMMARY, **parsed}
        result["raw_transcript_available"] = True
        return result

    # Fallback: put raw text into executive_summary
    logger.warning("Could not parse JSON from model response. Using fallback summary.")
    fallback = {**FALLBACK_SUMMARY}
    fallback["executive_summary"] = raw_content
    return fallback
