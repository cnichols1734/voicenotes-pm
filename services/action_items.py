"""
Action item CRUD and history tracking.

Shared logic used by both authenticated (recordings) and public (share) routes.
Action items live inside meetings.summary JSONB as an array. Each item gets a
stable UUID 'id' field so we can reference it in history and API calls.
"""
import logging
import uuid

from services.supabase_client import get_supabase

logger = logging.getLogger(__name__)

EDITABLE_FIELDS = {"task", "owner", "deadline", "completed", "priority"}


def ensure_action_item_ids(summary: dict) -> bool:
    """Add a UUID 'id' to every action item that lacks one. Returns True if any were added."""
    items = summary.get("action_items")
    if not items:
        return False
    changed = False
    for item in items:
        if not item.get("id"):
            item["id"] = str(uuid.uuid4())
            changed = True
    return changed


def _save_summary(meeting_id: str, summary: dict):
    sb = get_supabase()
    sb.table("meetings").update({"summary": summary}).eq("id", meeting_id).execute()


def _log_history(meeting_id: str, action_item_id: str, field: str,
                 old_value, new_value, changed_by_type: str,
                 changed_by_user_id=None, changed_by_name=None):
    sb = get_supabase()
    sb.table("action_item_history").insert({
        "meeting_id": meeting_id,
        "action_item_id": action_item_id,
        "field_changed": field,
        "old_value": str(old_value) if old_value is not None else None,
        "new_value": str(new_value) if new_value is not None else None,
        "changed_by_type": changed_by_type,
        "changed_by_user_id": changed_by_user_id,
        "changed_by_name": changed_by_name,
    }).execute()


def update_action_item(meeting: dict, item_id: str, updates: dict,
                       changed_by_type: str, changed_by_user_id=None,
                       changed_by_name=None):
    """
    Update fields on a single action item inside the meeting's summary JSONB.
    Logs a history entry for each changed field. Returns the updated meeting summary.
    """
    summary = meeting.get("summary")
    if not summary or not summary.get("action_items"):
        raise ValueError("Meeting has no action items")

    ensure_action_item_ids(summary)

    target = None
    for item in summary["action_items"]:
        if item.get("id") == item_id:
            target = item
            break

    if target is None:
        raise KeyError(f"Action item {item_id} not found")

    for field, new_value in updates.items():
        if field not in EDITABLE_FIELDS:
            continue
        old_value = target.get(field)
        if str(old_value) == str(new_value):
            continue
        target[field] = new_value
        _log_history(
            meeting["id"], item_id, field,
            old_value, new_value,
            changed_by_type, changed_by_user_id, changed_by_name,
        )

    _save_summary(meeting["id"], summary)
    return summary


def create_action_item(meeting: dict, data: dict,
                       changed_by_type: str, changed_by_user_id=None,
                       changed_by_name=None):
    """
    Append a new action item to the meeting's summary JSONB.
    Returns (new_item, updated_summary).
    """
    summary = meeting.get("summary")
    if not summary:
        raise ValueError("Meeting has no summary")

    ensure_action_item_ids(summary)

    if "action_items" not in summary:
        summary["action_items"] = []

    new_item = {
        "id": str(uuid.uuid4()),
        "task": data.get("task", "").strip() or "New action item",
        "owner": data.get("owner", "").strip() or "",
        "deadline": data.get("deadline", "").strip() or "",
        "priority": data.get("priority", "").strip() or "medium",
        "completed": False,
    }
    summary["action_items"].append(new_item)

    _log_history(
        meeting["id"], new_item["id"], "created",
        None, new_item["task"],
        changed_by_type, changed_by_user_id, changed_by_name,
    )

    _save_summary(meeting["id"], summary)
    return new_item, summary


def reorder_action_items(meeting: dict, ordered_ids: list):
    """
    Rearrange action_items to match the given ID order.
    Returns the updated summary.
    """
    summary = meeting.get("summary")
    if not summary or not summary.get("action_items"):
        raise ValueError("Meeting has no action items")

    ensure_action_item_ids(summary)

    items_by_id = {item["id"]: item for item in summary["action_items"]}
    reordered = []
    for item_id in ordered_ids:
        if item_id in items_by_id:
            reordered.append(items_by_id.pop(item_id))
    for remaining in items_by_id.values():
        reordered.append(remaining)

    summary["action_items"] = reordered
    _save_summary(meeting["id"], summary)
    return summary


def get_history(meeting_id: str, limit: int = 50):
    """Fetch recent action item history entries for a meeting."""
    sb = get_supabase()
    result = (
        sb.table("action_item_history")
        .select("*")
        .eq("meeting_id", meeting_id)
        .order("created_at", desc=True)
        .limit(limit)
        .execute()
    )
    return result.data or []
