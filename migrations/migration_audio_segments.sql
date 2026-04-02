-- VoiceNotes PM - Audio playback & timestamped transcript segments
-- Adds columns for persisting audio files and segment-level timestamps.
-- All columns are nullable so existing meetings are unaffected.

ALTER TABLE meetings ADD COLUMN IF NOT EXISTS audio_path TEXT;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS audio_mime_type TEXT;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS transcript_segments JSONB;
