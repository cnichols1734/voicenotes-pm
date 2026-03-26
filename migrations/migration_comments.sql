-- Migration: Add meeting_comments table for collaborative commenting
-- Run this in your Supabase SQL Editor

CREATE TABLE IF NOT EXISTS meeting_comments (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    commenter_type TEXT NOT NULL CHECK (commenter_type IN ('user', 'shared')),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    commenter_name TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_comments_meeting ON meeting_comments(meeting_id, created_at);
