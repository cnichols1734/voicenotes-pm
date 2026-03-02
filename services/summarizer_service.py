"""
VoiceNotes PM - OpenRouter summarization service.
Sends a transcript to OpenRouter and returns a structured summary dict.
"""
import json
import logging
import re

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


def summarize_transcript(transcript: str, prompt_template: str) -> dict:
    """
    Summarize a meeting transcript using OpenRouter API.

    Injects the transcript into prompt_template via the {transcript} placeholder,
    sends it to the configured model, and returns a structured summary dict.

    If parsing fails, returns a fallback dict with the raw text in executive_summary.
    """
    system_content = prompt_template.replace("{transcript}", transcript)

    headers = {
        "Authorization": f"Bearer {Config.OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://voicenotes-pm.railway.app",
        "X-Title": "VoiceNotes PM",
    }

    payload = {
        "model": Config.OPENROUTER_MODEL,
        "messages": [
            {"role": "system", "content": system_content},
            {
                "role": "user",
                "content": (
                    "Analyze this meeting transcript and provide the structured summary as specified."
                ),
            },
        ],
        "temperature": 0.3,
    }

    try:
        response = requests.post(
            OPENROUTER_ENDPOINT,
            headers=headers,
            json=payload,
            timeout=120,
        )
        response.raise_for_status()
    except requests.RequestException as exc:
        raise RuntimeError(
            f"OpenRouter API request failed: {exc}. "
            "If the free model is unavailable, try updating OPENROUTER_MODEL in settings."
        ) from exc

    raw_content = response.json()["choices"][0]["message"]["content"]
    logger.debug("OpenRouter raw response: %s", raw_content[:500])

    parsed = _extract_json(raw_content)
    if parsed is not None:
        # Ensure required keys exist
        result = {**FALLBACK_SUMMARY, **parsed}
        result["raw_transcript_available"] = True
        return result

    # Fallback: put raw text into executive_summary
    logger.warning("Could not parse JSON from model response. Using fallback summary.")
    fallback = {**FALLBACK_SUMMARY}
    fallback["executive_summary"] = raw_content
    return fallback
