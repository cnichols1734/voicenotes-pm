-- VoiceNotes PM - Supabase Database Schema
-- Run this in your Supabase SQL Editor

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- FOLDERS
-- User-created folders for organizing meetings
-- ============================================
CREATE TABLE folders (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT DEFAULT '#6366f1',
    icon TEXT DEFAULT '📁',
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- MEETING TYPES
-- Configurable meeting types with editable AI prompts
-- ============================================
CREATE TABLE meeting_types (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT DEFAULT 'file-text',
    description TEXT,
    prompt_template TEXT NOT NULL,
    is_default BOOLEAN DEFAULT FALSE,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- MEETINGS
-- Individual recorded meetings with transcripts and summaries
-- ============================================
CREATE TABLE meetings (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
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
-- NOTE: Meeting type seed data is inserted by the Flask
-- app on first boot via services/seed_defaults.py
-- ============================================
