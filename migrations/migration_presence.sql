-- Migration: Add meeting_presence table for real-time viewer tracking
-- Run this in your Supabase SQL Editor

CREATE TABLE meeting_presence (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    viewer_type TEXT NOT NULL CHECK (viewer_type IN ('user', 'shared')),
    viewer_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    avatar_color TEXT NOT NULL,
    last_seen_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (meeting_id, viewer_id)
);

CREATE INDEX idx_presence_meeting ON meeting_presence(meeting_id);
CREATE INDEX idx_presence_last_seen ON meeting_presence(last_seen_at);
