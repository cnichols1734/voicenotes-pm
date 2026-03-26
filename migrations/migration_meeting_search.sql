-- VoiceNotes PM: fast meeting list search (title + transcript) + slim list rows
-- Run in Supabase SQL Editor after backing up if needed.
--
-- Uses pg_trgm GIN indexes so ILIKE '%term%' can use bitmap index scans
-- instead of sequential scans on large transcript text.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_meetings_title_trgm
  ON meetings USING GIN (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_meetings_transcript_trgm
  ON meetings USING GIN (transcript gin_trgm_ops);

-- Escape \, %, _ for use in ILIKE ... ESCAPE '\'
CREATE OR REPLACE FUNCTION escape_like_pattern(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT replace(replace(replace(COALESCE(p_text, ''), E'\\', E'\\\\'), E'%', E'\%'), E'_', E'\_');
$$;

-- Slim meeting list for dashboard: never returns transcript (large payload).
-- p_search NULL or blank: all meetings for user (respecting folder/type filters).
-- Otherwise: title OR transcript matches (case-insensitive substring).
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
  updated_at timestamptz
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
    m.updated_at
  FROM meetings m
  WHERE m.user_id = p_user_id
    AND (p_folder_id IS NULL OR m.folder_id = p_folder_id)
    AND (p_meeting_type_id IS NULL OR m.meeting_type_id = p_meeting_type_id)
    AND (
      p_search IS NULL
      OR length(trim(p_search)) = 0
      OR (
        m.title ILIKE (
          '%' || escape_like_pattern(trim(p_search)) || '%'
        ) ESCAPE '\'
        OR (
          m.transcript IS NOT NULL
          AND m.transcript ILIKE (
            '%' || escape_like_pattern(trim(p_search)) || '%'
          ) ESCAPE '\'
        )
      )
    )
  ORDER BY m.recorded_at DESC;
$$;

COMMENT ON FUNCTION list_user_meetings(uuid, uuid, uuid, text) IS
  'Dashboard meeting list: optional text search on title+transcript; omits transcript column for bandwidth.';

-- Backend uses service role; grant explicitly for clarity.
GRANT EXECUTE ON FUNCTION list_user_meetings(uuid, uuid, uuid, text) TO service_role;
