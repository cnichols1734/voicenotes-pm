-- ============================================
-- VoiceNotes PM - Auth Migration
-- Run this in your Supabase SQL Editor to add
-- authentication to an existing database.
-- ============================================

-- 1. Create users table
CREATE TABLE IF NOT EXISTS users (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- 2. Add user_id columns (nullable initially so existing rows don't break)
ALTER TABLE folders ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE meeting_types ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;

-- 3. Add indexes
CREATE INDEX IF NOT EXISTS idx_folders_user_id ON folders(user_id);
CREATE INDEX IF NOT EXISTS idx_meeting_types_user_id ON meeting_types(user_id);
CREATE INDEX IF NOT EXISTS idx_meetings_user_id ON meetings(user_id);

-- 4. Add updated_at trigger for users
CREATE TRIGGER users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================
-- NOTE: After running this migration, register your
-- admin account through the app. The first registered
-- user is automatically promoted to admin.
-- Existing data (meetings, folders, meeting_types)
-- will be claimed by the admin account on first login.
-- ============================================
