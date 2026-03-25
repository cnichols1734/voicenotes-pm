-- Migration: Add shared_links table for public meeting sharing
-- Run this in your Supabase SQL Editor

-- ============================================
-- SHARED LINKS
-- Public read-only share tokens for meetings
-- ============================================
CREATE TABLE shared_links (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_shared_links_meeting ON shared_links(meeting_id);
CREATE INDEX idx_shared_links_user ON shared_links(user_id);
