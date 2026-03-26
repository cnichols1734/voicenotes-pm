-- ============================================
-- VoiceNotes PM - Mobile Auth Sessions Migration
-- Run this in your Supabase SQL Editor.
-- ============================================

CREATE TABLE IF NOT EXISTS mobile_auth_sessions (
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

CREATE INDEX IF NOT EXISTS idx_mobile_auth_sessions_user_id
    ON mobile_auth_sessions(user_id);

CREATE INDEX IF NOT EXISTS idx_mobile_auth_sessions_expires_at
    ON mobile_auth_sessions(expires_at);

DROP TRIGGER IF EXISTS mobile_auth_sessions_updated_at ON mobile_auth_sessions;
CREATE TRIGGER mobile_auth_sessions_updated_at
    BEFORE UPDATE ON mobile_auth_sessions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
