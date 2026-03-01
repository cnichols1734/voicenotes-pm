"""
Summarizer service.
Sends transcripts to OpenRouter API for AI-powered meeting summarization.
"""


def summarize_transcript(transcript: str, meeting_type_prompt: str) -> dict:
    """
    Send transcript to OpenRouter API and return AI-generated summary.

    Args:
        transcript: Raw transcript text
        meeting_type_prompt: Prompt template for meeting type (e.g., standup, sprint planning)

    Returns:
        Dict with summary fields (e.g., key_points, action_items, decisions)
    """
    raise NotImplementedError("TODO: Implement OpenRouter summarization")
