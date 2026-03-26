-- Migration: Add action_item_history table for tracking changes to action items.
-- Run this in your Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS action_item_history (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    action_item_id TEXT NOT NULL,
    field_changed TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    changed_by_type TEXT NOT NULL CHECK (changed_by_type IN ('user', 'shared')),
    changed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    changed_by_name TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_action_item_history_meeting ON action_item_history(meeting_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_item_history_item ON action_item_history(action_item_id);
