# VoiceNotes PM

AI-powered voice recording and meeting summarization tool for Technical Product Managers. Users record meetings, which are transcribed (Whisper) and summarized (OpenRouter) with structured extraction of action items, decisions, and discussion points.

## Tech Stack

- **Backend:** Python / Flask 3.1.x, Gunicorn
- **Database:** Supabase (PostgreSQL with UUID, JSONB)
- **Auth:** Flask-Login + bcrypt
- **Transcription:** OpenAI Whisper API (`whisper-1`)
- **Summarization:** OpenRouter API (default model: `minimax/minimax-m2.5`)
- **Audio:** pydub + ffmpeg (chunking for files >24MB)
- **Frontend:** Jinja2 templates, vanilla JS, Web Audio API, Canvas waveform visualization
- **Deployment:** Railway.app via Nixpacks

## Project Structure

```
app.py                  # Flask app factory & init
config.py               # Env-based configuration
schema.sql              # Full database schema
migration_add_auth.sql  # Auth migration for existing DBs
routes/                 # Flask blueprints
  auth.py               # Login, register, logout, account settings
  main.py               # Dashboard, detail pages
  recordings.py         # Meeting CRUD, upload, transcribe, summarize
  folders.py            # Folder management
  meeting_types.py      # Meeting type prompt CRUD
  api.py                # Health check, settings
  admin.py              # Admin panel, user management
services/               # Business logic
  supabase_client.py    # Supabase client factory
  auth_service.py       # User model, password hashing, CRUD
  whisper_service.py    # Whisper transcription (with chunking)
  summarizer_service.py # OpenRouter summarization, JSON extraction
  audio_processing.py   # Audio file chunking via pydub
  seed_defaults.py      # 6 default meeting type prompts
templates/              # Jinja2 HTML (base, dashboard, recording, etc.)
  components/           # Reusable partials (folder_sidebar, meeting_card)
static/css/styles.css   # Responsive mobile-first CSS
static/js/              # Vanilla JS modules (recorder, meetings, folders, etc.)
tests/                  # pytest suite
```

## Key Commands

```bash
# Run locally
python app.py                    # Starts on http://localhost:5050

# Run tests
pytest tests/

# Production (Railway)
gunicorn app:app --bind 0.0.0.0:$PORT
```

## Environment Variables

Required in `.env` (see `.env.example`):
- `SUPABASE_URL`, `SUPABASE_KEY` — Database connection
- `OPENAI_API_KEY` — Whisper transcription
- `OPENROUTER_API_KEY` — AI summarization
- `SECRET_KEY` — Flask session secret
- `FLASK_ENV` — `development` or `production`
- `ADMIN_EMAIL` — First registered user with this email becomes admin
- `OPENROUTER_MODEL` — Optional, defaults to `minimax/minimax-m2.5`

## Architecture & Patterns

- **User-scoped data:** All queries filter by `user_id` for data isolation
- **Role-based access:** `@login_required` on protected routes, `@admin_required` for admin endpoints
- **First user = admin:** First registered user matching `ADMIN_EMAIL` gets admin role
- **RESTful API:** JSON request/response, consistent error handling
- **Meeting workflow:** Record audio → POST upload (Whisper transcription) → Select meeting type → POST summarize (OpenRouter) → Structured JSONB summary
- **Summary schema:** `executive_summary`, `action_items[]`, `decisions_made[]`, `key_discussion_points[]`, `follow_ups[]`
- **Prompt templates:** Each meeting type has a `prompt_template` with `{transcript}` placeholder

## Database

PostgreSQL via Supabase. Tables: `users`, `folders`, `meeting_types`, `meetings`. UUIDs as primary keys, cascading deletes, auto-updated `updated_at` triggers. See `schema.sql` for full schema.

## Important Notes

- Audio files >24MB are automatically chunked for Whisper's 25MB limit
- All processing is synchronous (no async/background workers)
- Frontend uses no JS framework — vanilla JS with server-rendered templates
- Lucide icons loaded from CDN
- `.env` contains secrets — never commit it
