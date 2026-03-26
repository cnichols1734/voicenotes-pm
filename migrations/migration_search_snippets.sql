-- VoiceNotes PM: add search_snippet to list_user_meetings
-- Amends the function created in migration_meeting_search.sql.
-- Run in Supabase SQL Editor.
--
-- search_snippet is:
--   NULL  → no search active, or title matched (show executive_summary)
--   TEXT  → transcript matched but title didn't; ~200-char excerpt starting
--           60 chars before the first case-insensitive occurrence of the term.

-- Must drop first because the return type (new search_snippet column) changed.
DROP FUNCTION IF EXISTS list_user_meetings(uuid, uuid, uuid, text);

CREATE OR REPLACE FUNCTION list_user_meetings(
  p_user_id uuid,
  p_folder_id uuid DEFAULT NULL,
  p_meeting_type_id uuid DEFAULT NULL,
  p_search text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  title text,
  folder_id uuid,
  meeting_type_id uuid,
  summary jsonb,
  duration_seconds integer,
  status text,
  error_message text,
  recorded_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  search_snippet text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    m.id,
    m.title,
    m.folder_id,
    m.meeting_type_id,
    m.summary,
    m.duration_seconds,
    m.status,
    m.error_message,
    m.recorded_at,
    m.created_at,
    m.updated_at,
    -- Only produce a snippet when the search term hit the transcript
    -- but NOT the title, so the UI knows to show transcript context.
    CASE
      WHEN p_search IS NOT NULL
           AND length(trim(p_search)) > 0
           AND m.transcript IS NOT NULL
           AND NOT (m.title ILIKE ('%' || escape_like_pattern(trim(p_search)) || '%') ESCAPE '\')
           AND       m.transcript ILIKE ('%' || escape_like_pattern(trim(p_search)) || '%') ESCAPE '\'
      THEN trim(
             substring(
               m.transcript
               FROM GREATEST(1, strpos(lower(m.transcript), lower(trim(p_search))) - 60)
               FOR 200
             )
           )
      ELSE NULL
    END AS search_snippet
  FROM meetings m
  WHERE m.user_id = p_user_id
    AND (p_folder_id IS NULL OR m.folder_id = p_folder_id)
    AND (p_meeting_type_id IS NULL OR m.meeting_type_id = p_meeting_type_id)
    AND (
      p_search IS NULL
      OR length(trim(p_search)) = 0
      OR (
        m.title ILIKE ('%' || escape_like_pattern(trim(p_search)) || '%') ESCAPE '\'
        OR (
          m.transcript IS NOT NULL
          AND m.transcript ILIKE ('%' || escape_like_pattern(trim(p_search)) || '%') ESCAPE '\'
        )
      )
    )
  ORDER BY m.recorded_at DESC;
$$;

GRANT EXECUTE ON FUNCTION list_user_meetings(uuid, uuid, uuid, text) TO service_role;
