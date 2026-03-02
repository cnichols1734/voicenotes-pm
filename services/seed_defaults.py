"""
VoiceNotes PM - Seed default meeting types.
Called on app startup to populate the meeting_types table if empty.
"""
import logging

logger = logging.getLogger(__name__)

MEETING_TYPE_DEFAULTS = [
    {
        "name": "Engineering Kickoff",
        "icon": "🚀",
        "description": "New feature kickoffs and technical discussions with engineering",
        "is_default": True,
        "sort_order": 0,
        "prompt_template": """You are an expert meeting analyst for a Technical Product Manager. You are analyzing the transcript of an Engineering Kickoff meeting where the PM is discussing a new feature or project with the engineering team.

Focus on:
- Technical decisions made about architecture, approach, or implementation
- Questions engineers raised that need answers (these are likely action items for the PM)
- Scope concerns or pushback from engineering
- Dependencies or blockers identified
- Timeline discussions and estimates given
- Any technical debt or risk items mentioned

Here is the meeting transcript:

---
{transcript}
---

Respond ONLY with a valid JSON object (no markdown fences, no preamble, no extra text) matching this exact schema:

{{
    "executive_summary": "2-3 paragraphs summarizing what feature/project was kicked off, the technical approach discussed, key concerns raised, and overall alignment level between PM and engineering",
    "action_items": [
        {{
            "task": "specific task description",
            "owner": "person responsible or 'Me' for the PM",
            "deadline": "mentioned deadline or 'TBD'",
            "priority": "high | medium | low"
        }}
    ],
    "decisions_made": [
        {{
            "decision": "what was decided",
            "context": "why this approach was chosen",
            "decided_by": "who made the call"
        }}
    ],
    "key_discussion_points": ["significant topics discussed as brief bullet descriptions"],
    "follow_ups": ["items to follow up on that are not direct action items, like questions to research or stakeholders to loop in"],
    "raw_transcript_available": true
}}""",
    },
    {
        "name": "Stakeholder Problem-Solving",
        "icon": "🔍",
        "description": "Working sessions with stakeholders to diagnose and solve issues",
        "is_default": True,
        "sort_order": 1,
        "prompt_template": """You are an expert meeting analyst for a Technical Product Manager. You are analyzing the transcript of a Stakeholder Problem-Solving meeting where the PM and stakeholders are diagnosing an issue, discussing root causes, and working toward solutions.

Focus on:
- The problem or issue being discussed (clearly define it)
- Root causes identified or hypothesized
- Solutions proposed and by whom
- Which solution was agreed upon (if any)
- Data or evidence referenced during discussion
- Stakeholder concerns and their priorities
- Impact assessment (who is affected, how severely)
- Interim workarounds vs long-term fixes discussed

Here is the meeting transcript:

---
{transcript}
---

Respond ONLY with a valid JSON object (no markdown fences, no preamble, no extra text) matching this exact schema:

{{
    "executive_summary": "2-3 paragraphs clearly stating the problem discussed, the key root causes identified, the solution(s) agreed upon, and the plan going forward",
    "action_items": [
        {{
            "task": "specific task description",
            "owner": "person responsible or 'Me' for the PM",
            "deadline": "mentioned deadline or 'TBD'",
            "priority": "high | medium | low"
        }}
    ],
    "decisions_made": [
        {{
            "decision": "what was decided",
            "context": "why this approach was chosen or what problem it solves",
            "decided_by": "who made the call"
        }}
    ],
    "key_discussion_points": ["significant topics, root causes, or proposed solutions discussed"],
    "follow_ups": ["monitoring items, data to gather, stakeholders to update, or validation steps"],
    "raw_transcript_available": true
}}""",
    },
    {
        "name": "Boss 1:1",
        "icon": "👔",
        "description": "1-on-1 meetings with Head of Product or direct manager",
        "is_default": True,
        "sort_order": 2,
        "prompt_template": """You are an expert meeting analyst for a Technical Product Manager. You are analyzing the transcript of a 1:1 meeting between the PM and their boss (Head of Product or direct manager).

Focus on:
- Directives or priorities communicated by the boss
- Feedback given to the PM (positive or constructive)
- Strategic context shared (company direction, org changes, priorities shifting)
- Requests or tasks assigned to the PM
- Career development or growth topics discussed
- Status updates the PM gave and boss's reactions
- Concerns the boss raised about projects or team
- Anything the boss explicitly asked the PM to do, even if mentioned casually

Be especially thorough with action items. When the boss says something like "can you look into..." or "we should probably..." or "make sure you...", those are action items for the PM. Capture ALL of them. Mark all boss-assigned tasks as owner "Me" (the PM).

Here is the meeting transcript:

---
{transcript}
---

Respond ONLY with a valid JSON object (no markdown fences, no preamble, no extra text) matching this exact schema:

{{
    "executive_summary": "2-3 paragraphs summarizing the key themes of the 1:1, what the boss communicated as priorities, feedback given, and the overall tone of the meeting",
    "action_items": [
        {{
            "task": "specific task description",
            "owner": "Me",
            "deadline": "mentioned deadline or 'TBD'",
            "priority": "high | medium | low"
        }}
    ],
    "decisions_made": [
        {{
            "decision": "what was decided or directed",
            "context": "strategic context or reasoning the boss shared",
            "decided_by": "Boss / Head of Product"
        }}
    ],
    "key_discussion_points": ["topics covered including status updates, strategic discussions, and feedback"],
    "follow_ups": ["items to follow up on, people to talk to, things to prepare for next 1:1"],
    "raw_transcript_available": true
}}""",
    },
    {
        "name": "Strategy Planning",
        "icon": "bar-chart",
        "description": "Quarterly planning, roadmap reviews, or strategy alignment sessions",
        "is_default": True,
        "sort_order": 3,
        "prompt_template": """You are an expert meeting analyst for a Technical Product Manager. You are analyzing the transcript of a Strategy Planning meeting where the PM and stakeholders are discussing long-term goals, roadmaps, and strategic initiatives.

Focus on:
- Strategic objectives and goals discussed
- Roadmap items or initiatives prioritized
- Key decisions made regarding strategy or direction
- Risks or opportunities identified for the long-term
- Resource allocation discussions
- Alignment or misalignment among stakeholders
- Metrics or KPIs for success

Here is the meeting transcript:

---
{transcript}
---

Respond ONLY with a valid JSON object (no markdown fences, no preamble, no extra text) matching this exact schema:

{{
    "executive_summary": "2-3 paragraphs summarizing the strategic objectives discussed, key decisions made, and the overall direction or alignment achieved in the meeting",
    "action_items": [
        {{
            "task": "specific task description",
            "owner": "person responsible or 'Me' for the PM",
            "deadline": "mentioned deadline or 'TBD'",
            "priority": "high | medium | low"
        }}
    ],
    "decisions_made": [
        {{
            "decision": "what strategic decision was made",
            "context": "why this decision was chosen or its implications",
            "decided_by": "who made the call"
        }}
    ],
    "key_discussion_points": ["strategic objectives, roadmap items, risks, or opportunities discussed"],
    "follow_ups": ["strategic research, stakeholder alignment, or further planning sessions"],
    "raw_transcript_available": true
}}""",
    },
    {
        "name": "Sprint Planning",
        "icon": "kanban",
        "description": "Sprint planning, standups, and iteration ceremonies",
        "is_default": True,
        "sort_order": 4,
        "prompt_template": """You are an expert meeting analyst for a Technical Product Manager. You are analyzing the transcript of a Sprint Planning or Standup meeting with the development team.

Focus on:
- Stories or tickets discussed and their status
- Capacity concerns or overcommitment flags
- Blockers mentioned by team members and who owns unblocking them
- Scope changes or reprioritization decisions
- Carryover items from previous sprint
- Commitments made for the current sprint
- Risks to sprint completion
- Any items the PM needs to provide (requirements, designs, answers, stakeholder input)

Organize action items by who needs to do what. If a developer mentions they are blocked on the PM for something, that is a high-priority action item for "Me" (the PM).

Here is the meeting transcript:

---
{transcript}
---

Respond ONLY with a valid JSON object (no markdown fences, no preamble, no extra text) matching this exact schema:

{{
    "executive_summary": "2-3 paragraphs summarizing sprint scope, team capacity assessment, key risks, and overall confidence in sprint completion",
    "action_items": [
        {{
            "task": "specific task description",
            "owner": "person responsible or 'Me' for the PM",
            "deadline": "end of sprint or specific date or 'TBD'",
            "priority": "high | medium | low"
        }}
    ],
    "decisions_made": [
        {{
            "decision": "what was decided about scope, priority, or approach",
            "context": "why this decision was made",
            "decided_by": "team / PM / tech lead"
        }}
    ],
    "key_discussion_points": ["stories discussed, blockers raised, capacity issues, technical concerns"],
    "follow_ups": ["items to unblock the team, stakeholders to update, requirements to clarify"],
    "raw_transcript_available": true
}}""",
    },
    {
        "name": "General Meeting",
        "icon": "file-text",
        "description": "Standard meeting format capturing key discussion points and action items",
        "is_default": True,
        "sort_order": 5,
        "prompt_template": """You are an expert meeting analyst for a Technical Product Manager. You are analyzing a meeting transcript. This is a general meeting that may cover various topics.

Provide a comprehensive, well-organized summary. Focus on:
- What was the purpose and context of this meeting?
- Who were the key participants and what were their roles/perspectives?
- What were the most important things discussed?
- What was decided?
- What needs to happen next and who is responsible?
- Are there any risks, concerns, or open questions?

Be thorough with action items. Any time someone says they will do something, or asks someone else to do something, capture it as an action item.

Here is the meeting transcript:

---
{transcript}
---

Respond ONLY with a valid JSON object (no markdown fences, no preamble, no extra text) matching this exact schema:

{{
    "executive_summary": "2-3 paragraphs summarizing the meeting purpose, key outcomes, and overall takeaways",
    "action_items": [
        {{
            "task": "specific task description",
            "owner": "person responsible or 'Me' for the PM",
            "deadline": "mentioned deadline or 'TBD'",
            "priority": "high | medium | low"
        }}
    ],
    "decisions_made": [
        {{
            "decision": "what was decided",
            "context": "brief context or reasoning",
            "decided_by": "who made the call"
        }}
    ],
    "key_discussion_points": ["significant topics discussed"],
    "follow_ups": ["items to follow up on that are not direct action items"],
    "raw_transcript_available": true
}}""",
    },
]


def seed_default_meeting_types():
    """Check if meeting_types table is empty and seed defaults if so."""
    try:
        from services.supabase_client import get_supabase
        supabase = get_supabase()

        result = supabase.table("meeting_types").select("id", count="exact").execute()
        count = result.count if result.count is not None else len(result.data)

        if count == 0:
            logger.info("Seeding default meeting types...")
            supabase.table("meeting_types").insert(MEETING_TYPE_DEFAULTS).execute()
            logger.info("Successfully seeded %d default meeting types.", len(MEETING_TYPE_DEFAULTS))
        else:
            logger.info("Meeting types already exist (%d found). Skipping seed.", count)

    except Exception as exc:
        logger.warning(
            "Could not seed default meeting types (Supabase may not be configured yet): %s",
            exc,
        )
