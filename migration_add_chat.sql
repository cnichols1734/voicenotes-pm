-- Migration: Add chat_messages table for meeting chat feature
-- Run this in your Supabase SQL Editor

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
