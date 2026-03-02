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
