-- VoiceNotes PM - Supabase Database Schema
-- Run this in your Supabase SQL Editor

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- USERS
-- Application users with email/password auth
-- ============================================
CREATE TABLE users (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);

-- ============================================
-- MOBILE AUTH SESSIONS
-- Refresh-token-backed mobile sessions
-- ============================================
CREATE TABLE mobile_auth_sessions (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token_hash TEXT NOT NULL UNIQUE,
    device_name TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);

CREATE INDEX idx_mobile_auth_sessions_user_id ON mobile_auth_sessions(user_id);
CREATE INDEX idx_mobile_auth_sessions_expires_at ON mobile_auth_sessions(expires_at);

-- ============================================
-- FOLDERS
-- User-created folders for organizing meetings
-- ============================================
CREATE TABLE folders (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT DEFAULT '#6366f1',
    icon TEXT DEFAULT '📁',
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_folders_user_id ON folders(user_id);

-- ============================================
-- MEETING TYPES
-- Configurable meeting types with editable AI prompts
-- ============================================
CREATE TABLE meeting_types (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    icon TEXT DEFAULT 'file-text',
    description TEXT,
    prompt_template TEXT NOT NULL,
    is_default BOOLEAN DEFAULT FALSE,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_meeting_types_user_id ON meeting_types(user_id);

-- ============================================
-- MEETINGS
-- Individual recorded meetings with transcripts and summaries
-- ============================================
CREATE TABLE meetings (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    folder_id UUID REFERENCES folders(id) ON DELETE SET NULL,
    meeting_type_id UUID REFERENCES meeting_types(id) ON DELETE SET NULL,
    transcript TEXT,
    summary JSONB,
    duration_seconds INTEGER,
    status TEXT DEFAULT 'recording' CHECK (status IN ('recording', 'transcribing', 'selecting_type', 'summarizing', 'complete', 'error')),
    error_message TEXT,
    recorded_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- INDEXES
-- ============================================
CREATE INDEX idx_meetings_user_id ON meetings(user_id);
CREATE INDEX idx_meetings_folder_id ON meetings(folder_id);
CREATE INDEX idx_meetings_meeting_type_id ON meetings(meeting_type_id);
CREATE INDEX idx_meetings_status ON meetings(status);
CREATE INDEX idx_meetings_recorded_at ON meetings(recorded_at DESC);

-- Substring search on title + transcript (dashboard); requires pg_trgm
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX idx_meetings_title_trgm ON meetings USING GIN (title gin_trgm_ops);
CREATE INDEX idx_meetings_transcript_trgm ON meetings USING GIN (transcript gin_trgm_ops);

CREATE OR REPLACE FUNCTION escape_like_pattern(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT replace(replace(replace(COALESCE(p_text, ''), E'\\', E'\\\\'), E'%', E'\%'), E'_', E'\_');
$$;

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
    -- NULL when no search or title matched (show executive_summary on client).
    -- TEXT excerpt when transcript matched but title didn't.
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

-- ============================================
-- UPDATED_AT TRIGGER
-- Auto-update updated_at on row changes
-- ============================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER mobile_auth_sessions_updated_at
    BEFORE UPDATE ON mobile_auth_sessions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER folders_updated_at
    BEFORE UPDATE ON folders
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER meeting_types_updated_at
    BEFORE UPDATE ON meeting_types
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER meetings_updated_at
    BEFORE UPDATE ON meetings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================
-- CHAT MESSAGES
-- Per-meeting chat history with AI assistant
-- ============================================
CREATE TABLE chat_messages (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_chat_messages_meeting ON chat_messages(meeting_id, created_at);
CREATE INDEX idx_chat_messages_user ON chat_messages(user_id);

-- ============================================
-- NOTE: Default meeting types are seeded per-user
-- on first registration via services/seed_defaults.py
-- ============================================
