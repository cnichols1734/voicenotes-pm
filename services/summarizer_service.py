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

WEB_FALLBACK_SUMMARY = {
    "executive_summary": "",
    "action_items": [],
    "decisions_made": [],
    "key_discussion_points": [],
    "follow_ups": [],
    "raw_transcript_available": True,
}

MOBILE_FALLBACK_SUMMARY = {
    "executive_summary": "",
    "action_items": [],
    "decisions_made": [],
    "participant_updates": [],
    "blockers": [],
    "open_questions": [],
    "notable_details": [],
    "key_discussion_points": [],
    "follow_ups": [],
    "raw_transcript_available": True,
}

MOBILE_SUMMARY_SCHEMA = """
{
  "executive_summary": "Concise factual summary of the meeting",
  "action_items": [
    {
      "task": "specific task description",
      "owner": "explicit owner or Unknown",
      "deadline": "YYYY-MM-DD if stated, otherwise TBD",
      "priority": "high | medium | low"
    }
  ],
  "decisions_made": [
    {
      "decision": "what was decided",
      "context": "why or in what context it was decided",
      "decided_by": "who made the call or Unknown"
    }
  ],
  "participant_updates": [
    {
      "participant": "person or team name",
      "recent_progress": "what they reported completing or progressing",
      "next_work": "what they said they will do next",
      "blocker": "blocking issue, otherwise empty string",
      "dependencies": ["named dependencies"],
      "asks": ["specific asks made of others"]
    }
  ],
  "blockers": ["explicit blockers or risks"],
  "open_questions": ["unresolved questions"],
  "notable_details": ["important factual details, dates, metrics, systems, constraints"],
  "key_discussion_points": ["significant topics discussed"],
  "follow_ups": ["follow-up items that are not direct action items"],
  "raw_transcript_available": true
}
""".strip()


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


def _flatten_value(value) -> str:
    """Convert loose LLM values into a readable string."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float, bool)):
        return str(value).strip()
    if isinstance(value, list):
        parts = [_flatten_value(item) for item in value]
        return " | ".join(part for part in parts if part)
    if isinstance(value, dict):
        preferred_keys = ["task", "item", "text", "description", "decision", "question", "topic"]
        for key in preferred_keys:
            flattened = _flatten_value(value.get(key))
            if flattened:
                extras = []
                for extra_key, extra_value in value.items():
                    if extra_key == key:
                        continue
                    extra_text = _flatten_value(extra_value)
                    if extra_text:
                        extras.append(f"{extra_key}: {extra_text}")
                return flattened if not extras else f"{flattened} ({', '.join(extras)})"

        parts = []
        for key, inner_value in value.items():
            flattened = _flatten_value(inner_value)
            if flattened:
                parts.append(f"{key}: {flattened}")
        return ", ".join(parts)
    return ""


def _dedupe_strings(values: list[str]) -> list[str]:
    seen = set()
    result = []
    for value in values:
        text = (value or "").strip()
        if not text:
            continue
        key = re.sub(r"\s+", " ", text).strip().lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(text)
    return result


def _normalize_string_list(value) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        value = [value]

    flattened = []
    for item in value:
        if isinstance(item, list):
            flattened.extend(_normalize_string_list(item))
            continue
        text = _flatten_value(item)
        if text:
            flattened.append(text)
    return _dedupe_strings(flattened)


def _normalize_priority(value) -> str:
    priority = (_flatten_value(value) or "medium").lower()
    if priority not in {"high", "medium", "low"}:
        return "medium"
    return priority


def _normalize_action_items(value) -> list[dict]:
    if value is None:
        return []
    if not isinstance(value, list):
        value = [value]

    items = []
    for item in value:
        if isinstance(item, dict):
            task = (
                _flatten_value(item.get("task"))
                or _flatten_value(item.get("item"))
                or _flatten_value(item.get("action"))
                or _flatten_value(item.get("description"))
                or _flatten_value(item.get("title"))
            )
            owner = (
                _flatten_value(item.get("owner"))
                or _flatten_value(item.get("assignee"))
                or _flatten_value(item.get("assigned_to"))
                or "Unknown"
            )
            deadline = (
                _flatten_value(item.get("deadline"))
                or _flatten_value(item.get("due_date"))
                or _flatten_value(item.get("due"))
                or "TBD"
            )
            priority = _normalize_priority(item.get("priority"))
        else:
            task = _flatten_value(item)
            owner = "Unknown"
            deadline = "TBD"
            priority = "medium"

        if not task:
            continue
        items.append(
            {
                "task": task,
                "owner": owner,
                "deadline": deadline,
                "priority": priority,
            }
        )

    deduped = []
    seen = set()
    for item in items:
        key = re.sub(r"\s+", " ", f"{item['owner']} {item['task']}").strip().lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped


def _normalize_decisions(value) -> list[dict]:
    if value is None:
        return []
    if not isinstance(value, list):
        value = [value]

    decisions = []
    for item in value:
        if isinstance(item, dict):
            decision = (
                _flatten_value(item.get("decision"))
                or _flatten_value(item.get("item"))
                or _flatten_value(item.get("summary"))
            )
            context = _flatten_value(item.get("context"))
            decided_by = (
                _flatten_value(item.get("decided_by"))
                or _flatten_value(item.get("owner"))
                or _flatten_value(item.get("decision_maker"))
                or "Unknown"
            )
        else:
            decision = _flatten_value(item)
            context = ""
            decided_by = "Unknown"

        if not decision:
            continue
        decisions.append(
            {
                "decision": decision,
                "context": context,
                "decided_by": decided_by,
            }
        )

    deduped = []
    seen = set()
    for item in decisions:
        key = re.sub(r"\s+", " ", f"{item['decided_by']} {item['decision']}").strip().lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped


def _normalize_participant_updates(value) -> list[dict]:
    if value is None:
        return []
    if not isinstance(value, list):
        value = [value]

    updates = []
    for item in value:
        if isinstance(item, dict):
            participant = (
                _flatten_value(item.get("participant"))
                or _flatten_value(item.get("owner"))
                or _flatten_value(item.get("speaker"))
                or "Unknown"
            )
            recent_progress = (
                _flatten_value(item.get("recent_progress"))
                or _flatten_value(item.get("progress"))
                or _flatten_value(item.get("update"))
                or _flatten_value(item.get("status"))
            )
            next_work = (
                _flatten_value(item.get("next_work"))
                or _flatten_value(item.get("next"))
                or _flatten_value(item.get("next_steps"))
            )
            blocker = _flatten_value(item.get("blocker"))
            dependencies = _normalize_string_list(item.get("dependencies"))
            asks = _normalize_string_list(item.get("asks"))
        else:
            participant = "Unknown"
            recent_progress = _flatten_value(item)
            next_work = ""
            blocker = ""
            dependencies = []
            asks = []

        if not any([participant, recent_progress, next_work, blocker, dependencies, asks]):
            continue
        updates.append(
            {
                "participant": participant or "Unknown",
                "recent_progress": recent_progress,
                "next_work": next_work,
                "blocker": blocker,
                "dependencies": dependencies,
                "asks": asks,
            }
        )

    deduped = []
    seen = set()
    for item in updates:
        key = re.sub(
            r"\s+",
            " ",
            f"{item['participant']} {item['recent_progress']} {item['next_work']}",
        ).strip().lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped


def _normalize_mobile_summary(parsed: dict) -> dict:
    """Normalize model output into the exact JSON shape expected by iOS."""
    result = {**MOBILE_FALLBACK_SUMMARY}

    result["executive_summary"] = (
        _flatten_value(parsed.get("executive_summary"))
        or _flatten_value(parsed.get("summary"))
        or _flatten_value(parsed.get("overview"))
    )
    result["action_items"] = _normalize_action_items(
        parsed.get("action_items")
        or parsed.get("actionItems")
        or parsed.get("tasks")
        or parsed.get("todos")
    )
    result["decisions_made"] = _normalize_decisions(
        parsed.get("decisions_made")
        or parsed.get("decisionsMade")
        or parsed.get("decisions")
    )
    result["participant_updates"] = _normalize_participant_updates(
        parsed.get("participant_updates") or parsed.get("participantUpdates")
    )
    result["blockers"] = _normalize_string_list(parsed.get("blockers"))
    result["open_questions"] = _normalize_string_list(
        parsed.get("open_questions") or parsed.get("openQuestions") or parsed.get("questions")
    )
    result["notable_details"] = _normalize_string_list(
        parsed.get("notable_details") or parsed.get("notableDetails")
    )
    result["key_discussion_points"] = _normalize_string_list(
        parsed.get("key_discussion_points")
        or parsed.get("keyDiscussionPoints")
        or parsed.get("key_points")
        or parsed.get("discussion_points")
    )
    result["follow_ups"] = _normalize_string_list(
        parsed.get("follow_ups") or parsed.get("followUps")
    )
    result["raw_transcript_available"] = True

    return result


def _build_messages(transcript: str, prompt_template: str, schema: str = "web") -> list:
    """Build the chat messages for summarization."""
    if schema == "mobile":
        guidance = (prompt_template or "").replace("{transcript}", "").strip()
        system_content = f"""
You are an expert meeting analyst for the VoiceNotez iOS app.

Your task is to analyze the meeting transcript and return ONLY a valid JSON object that matches the exact schema below. Do not include markdown fences, commentary, or any extra prose.

Supplemental meeting-type guidance:
{guidance or "General meeting context. Focus on concrete facts, action items, decisions, blockers, open questions, notable details, discussion points, and follow-ups."}

Rules:
- Use only facts supported by the transcript.
- If a field has no content, return an empty string or empty array.
- Use "Unknown" when a person or owner is not explicit.
- `action_items` must always be objects with `task`, `owner`, `deadline`, and `priority`.
- `decisions_made` must always be objects with `decision`, `context`, and `decided_by`.
- `participant_updates` must always be objects with `participant`, `recent_progress`, `next_work`, `blocker`, `dependencies`, and `asks`.
- `blockers`, `open_questions`, `notable_details`, `key_discussion_points`, and `follow_ups` must always be arrays of strings.
- `raw_transcript_available` must be `true`.

Exact JSON schema:
{MOBILE_SUMMARY_SCHEMA}

Transcript:
---
{transcript}
---
""".strip()
        return [
            {"role": "system", "content": system_content},
            {
                "role": "user",
                "content": "Analyze this meeting transcript and return the exact JSON schema.",
            },
        ]

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


def summarize_transcript(transcript: str, prompt_template: str, schema: str = "web") -> dict:
    """
    Summarize a meeting transcript.

    Strategy:
      1. If LLM_BASE_URL is configured, try local LM Studio (Qwen) first.
      2. If local fails, fall back to OpenRouter (Minimax).
      3. If no local URL, go straight to OpenRouter.

    Returns a structured summary dict.
    """
    messages = _build_messages(transcript, prompt_template, schema=schema)
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
        if schema == "mobile":
            return _normalize_mobile_summary(parsed)

        result = {**WEB_FALLBACK_SUMMARY, **parsed}
        result["raw_transcript_available"] = True
        return result

    # Fallback: put raw text into executive_summary
    logger.warning("Could not parse JSON from model response. Using fallback summary.")
    fallback = {**(MOBILE_FALLBACK_SUMMARY if schema == "mobile" else WEB_FALLBACK_SUMMARY)}
    fallback["executive_summary"] = raw_content
    return fallback
