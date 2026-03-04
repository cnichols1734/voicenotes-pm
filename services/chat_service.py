"""
VoiceNotes PM - Meeting chat service.
Provides streaming chat with AI about a specific meeting's transcript and summary.

Supports two backends (same strategy as summarizer_service):
  1. Local LLM (via LM Studio / OpenAI-compatible) — tried first if LLM_BASE_URL is set
  2. OpenRouter API — used as fallback, or as primary if no local URL configured
"""
import json
import logging

import openai
import requests

from config import Config
from services.supabase_client import get_supabase

logger = logging.getLogger(__name__)

OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"

CHAT_SYSTEM_PROMPT = """You are a meeting assistant for the VoiceNotes PM app. You have been given the full transcript and AI-generated summary of a specific meeting. Your role is to answer questions about this meeting accurately and helpfully.

CONTEXT:
- Meeting Title: {title}
- Meeting Date: {date}
- Meeting Type: {meeting_type}

TRANSCRIPT:
{transcript}

SUMMARY:
{summary}

RULES:
1. ONLY answer based on information present in the transcript and summary above.
2. If the answer is not in the transcript or summary, say so clearly — e.g., "That wasn't discussed in this meeting" or "I don't have enough information from this meeting to answer that."
3. NEVER fabricate, guess, or infer information that isn't explicitly stated in the transcript or summary.
4. When referencing specific points, quote or closely paraphrase the relevant part of the transcript.
5. Be concise and direct. Use bullet points for lists.
6. You may help organize, clarify, or reframe information from the meeting, but do not add new information.
7. If asked to do something unrelated to the meeting (e.g., write code, tell a joke), politely redirect by saying you are here to help with questions about this meeting."""


def _build_system_prompt(meeting: dict) -> str:
    """Build the system prompt with meeting context injected."""
    summary = meeting.get("summary") or {}
    if isinstance(summary, str):
        summary_text = summary
    else:
        summary_text = json.dumps(summary, indent=2)

    meeting_type = ""
    type_id = meeting.get("meeting_type_id")
    if type_id:
        try:
            sb = get_supabase()
            result = sb.table("meeting_types").select("name").eq("id", type_id).execute()
            if result.data:
                meeting_type = result.data[0].get("name", "")
        except Exception:
            pass

    return CHAT_SYSTEM_PROMPT.format(
        title=meeting.get("title", "Untitled"),
        date=meeting.get("recorded_at", "Unknown"),
        meeting_type=meeting_type or "General",
        transcript=meeting.get("transcript", "(No transcript available)"),
        summary=summary_text,
    )


def build_messages(meeting: dict, chat_history: list, user_message: str) -> list:
    """
    Build the full messages array for OpenRouter.
    System prompt + chat history + new user message.
    """
    messages = [{"role": "system", "content": _build_system_prompt(meeting)}]

    for msg in chat_history:
        messages.append({"role": msg["role"], "content": msg["content"]})

    messages.append({"role": "user", "content": user_message})
    return messages


def _stream_local(messages: list):
    """
    Stream chat from local LM Studio (OpenAI-compatible API).
    Yields text chunks.
    """
    client = openai.OpenAI(
        api_key="lm-studio",
        base_url=Config.LLM_BASE_URL,
        timeout=300,
    )

    stream = client.chat.completions.create(
        model=Config.LLM_MODEL,
        messages=messages,
        temperature=0.3,
        stream=True,
    )

    for chunk in stream:
        delta = chunk.choices[0].delta if chunk.choices else None
        if delta and delta.content:
            yield delta.content


def _stream_openrouter(messages: list):
    """
    Stream chat from OpenRouter API.
    Yields text chunks.
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
        "stream": True,
    }

    response = requests.post(
        OPENROUTER_ENDPOINT,
        headers=headers,
        json=payload,
        timeout=120,
        stream=True,
    )
    response.raise_for_status()

    response.encoding = "utf-8"
    for line in response.iter_lines(decode_unicode=True):
        if not line or not line.startswith("data: "):
            continue
        data_str = line[6:]
        if data_str.strip() == "[DONE]":
            break
        try:
            chunk = json.loads(data_str)
            delta = chunk.get("choices", [{}])[0].get("delta", {})
            content = delta.get("content")
            if content:
                yield content
        except (json.JSONDecodeError, IndexError, KeyError):
            continue


def stream_chat_response(meeting: dict, chat_history: list, user_message: str):
    """
    Generator that yields text chunks from the chat model.

    Strategy:
      1. Try OpenRouter first (handles large context better).
      2. If OpenRouter fails and LLM_BASE_URL is configured, fall back to local LLM.
    """
    messages = build_messages(meeting, chat_history, user_message)

    try:
        logger.info("Chat: using OpenRouter (%s)...", Config.OPENROUTER_MODEL)
        yield from _stream_openrouter(messages)
        return
    except Exception as exc:
        logger.warning("Chat: OpenRouter failed: %s.", exc)

    if Config.LLM_BASE_URL:
        try:
            logger.info("Chat: falling back to local LLM (%s) at %s...", Config.LLM_MODEL, Config.LLM_BASE_URL)
            yield from _stream_local(messages)
            return
        except Exception as exc:
            logger.error("Chat: local LLM also failed: %s", exc)

    raise RuntimeError("All chat backends failed.")


def save_message(meeting_id: str, user_id: str, role: str, content: str) -> dict:
    """Save a chat message to the database."""
    sb = get_supabase()
    result = (
        sb.table("chat_messages")
        .insert({
            "meeting_id": meeting_id,
            "user_id": user_id,
            "role": role,
            "content": content,
        })
        .execute()
    )
    return result.data[0] if result.data else {}


def get_chat_history(meeting_id: str, user_id: str) -> list:
    """Fetch all chat messages for a meeting, ordered by creation time."""
    sb = get_supabase()
    result = (
        sb.table("chat_messages")
        .select("id, role, content, created_at")
        .eq("meeting_id", meeting_id)
        .eq("user_id", user_id)
        .order("created_at", desc=False)
        .execute()
    )
    return result.data or []


def clear_chat_history(meeting_id: str, user_id: str) -> None:
    """Delete all chat messages for a meeting."""
    sb = get_supabase()
    sb.table("chat_messages").delete().eq("meeting_id", meeting_id).eq("user_id", user_id).execute()
