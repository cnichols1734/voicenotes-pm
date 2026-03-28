# VoiceNotes PM

AI-powered voice recording and meeting summarization tool for Technical Product Managers. Users record meetings, which are transcribed (Whisper) and summarized (OpenRouter/local LLM) with structured extraction of action items, decisions, and discussion points.

## Tech Stack

- **Backend:** Python 3.10+ / Flask 3.1.x, Gunicorn
- **Database:** Supabase (PostgreSQL with UUID, JSONB, RLS)
- **Auth:** Flask-Login + bcrypt (web); JWT-style tokens (mobile)
- **Transcription:** OpenAI Whisper API (`whisper-1`) with local whisper.cpp fallback
- **Summarization:** OpenRouter API (default: `deepseek/deepseek-v3.2`) with local LM Studio fallback
- **Audio:** pydub + ffmpeg (chunking for files >24MB, WAV conversion)
- **Frontend:** Jinja2 templates, vanilla JS (ES6 modules), Web Audio API, Canvas waveform
- **Deployment:** Railway.app via Nixpacks

## Project Structure

```
app.py                      # Flask app factory (12 blueprints registered)
config.py                   # Env-based configuration class
requirements.txt            # Python dependencies
Procfile / railway.toml     # Railway.app deployment config
migrations/                 # SQL migration files (chronological)
  schema.sql                # Full baseline schema
  migration_add_auth.sql
  migration_add_sharing.sql
  migration_add_chat.sql
  migration_mobile_auth_sessions.sql
  migration_action_item_history.sql
  migration_comments.sql
  migration_presence.sql
  migration_meeting_search.sql
  migration_search_snippets.sql
routes/                     # Flask blueprints
  auth.py                   # Login, register, logout, account settings
  main.py                   # Landing page, dashboard, meeting detail
  recordings.py             # Meeting CRUD, upload, transcribe, summarize
  folders.py                # Folder management API
  meeting_types.py          # Meeting type prompt CRUD
  api.py                    # Health check, settings, runtime model switching
  admin.py                  # Admin panel, user management (enable/disable)
  chat.py                   # Streaming AI chat about meetings (SSE)
  share.py                  # Public share links
  mobile.py                 # Stateless mobile API (transcribe/summarize/title, no DB)
  mobile_auth.py            # Mobile JWT/refresh token auth
  presence.py               # Live viewer tracking (polling-based)
services/                   # Business logic
  supabase_client.py        # Supabase connection factory
  auth_service.py           # User model (Flask-Login), password hashing, CRUD
  whisper_service.py        # Transcription: local whisper.cpp → OpenAI fallback
  summarizer_service.py     # Summarization: local LM Studio → OpenRouter fallback
  chat_service.py           # Streaming chat context & history management
  title_service.py          # AI-generated meeting titles (local LLM → OpenRouter)
  audio_processing.py       # pydub chunking for Whisper's 25MB limit
  action_items.py           # Action item CRUD, reordering, change history
  mobile_auth_service.py    # Mobile JWT session management
  seed_defaults.py          # 6 default meeting type prompt templates
templates/                  # Jinja2 HTML templates
  base.html                 # Layout (cache-busting timestamp injected)
  landing.html              # Public landing page
  login.html / register.html / account.html
  dashboard.html            # Main meeting list (search, filters, folders)
  recording.html            # Meeting detail (transcript + summary + chat)
  meeting_types.html        # Prompt template editor
  admin.html                # Admin panel (user list, toggle active)
  shared.html / shared_404.html  # Public share view
  components/
    recorder.html           # Web Audio API recorder UI
    folder_sidebar.html     # Folder nav component
    meeting_card.html       # Meeting list card
static/css/styles.css       # Responsive mobile-first CSS (no framework)
static/js/                  # Vanilla JS modules
  app.js                    # Core routing & navigation
  recorder.js               # Web Audio API + canvas waveform visualization
  meetings.js               # Dashboard list, status polling
  chat.js                   # SSE streaming chat interface
  folders.js                # Folder CRUD
  shared.js                 # Public share view + comments
  admin.js                  # User list, enable/disable toggles
  prompt_editor.js          # Meeting type template editor
tests/                      # pytest suite (placeholder)
```

## Key Commands

```bash
# Run locally (http://localhost:5050)
python app.py

# Run tests
pytest tests/

# Production (Railway.app)
gunicorn app:app --bind 0.0.0.0:$PORT --workers 2 --worker-class gthread --threads 4 --timeout 300
```

## Environment Variables

All settings come from `.env` (see `.env.example`):

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SUPABASE_URL` | Yes | — | Supabase project URL |
| `SUPABASE_KEY` | Yes | — | Supabase anon/service key |
| `OPENAI_API_KEY` | Yes | — | Whisper transcription |
| `OPENROUTER_API_KEY` | Yes | — | AI summarization |
| `SECRET_KEY` | Yes | — | Flask session secret |
| `FLASK_ENV` | Yes | — | `development` or `production` |
| `ADMIN_EMAIL` | Yes | — | First registered user with this email becomes admin |
| `OPENROUTER_MODEL` | No | `deepseek/deepseek-v3.2` | LLM model for summarization/chat |
| `WHISPER_BASE_URL` | No | — | Local whisper.cpp server URL (used first if set) |
| `LLM_BASE_URL` | No | — | Local LM Studio server URL |
| `LLM_MODEL` | No | — | Local LLM model name |
| `MOBILE_ACCESS_TOKEN_TTL_SECONDS` | No | `3600` | Mobile access token TTL |
| `MOBILE_REFRESH_TOKEN_TTL_DAYS` | No | `45` | Mobile refresh token TTL |
| `MAX_CONTENT_LENGTH` | No | `200MB` | Max upload file size |

## Architecture & Patterns

### Core Patterns

- **User-scoped data:** ALL queries filter by `user_id` — never query without this filter
- **Role-based access:** `@login_required` on all protected routes; `@admin_required` for admin endpoints
- **First user = admin:** First registered user matching `ADMIN_EMAIL` gets admin role; subsequent matches do not
- **Error responses:** Always return `{"error": "message"}` JSON with correct HTTP status (400/401/403/404/500/503)
- **No async:** All processing is synchronous — no background workers, no Celery, no async/await

### Dual-Backend Strategy (Transcription & Summarization)

All AI services follow the same fallback pattern:
1. Try local server if `WHISPER_BASE_URL` / `LLM_BASE_URL` is configured
2. Log warning on local failure
3. Fall back to API service (OpenAI / OpenRouter)
4. Never fail silently — propagate errors to the route

This applies to: `whisper_service.py`, `summarizer_service.py`, `title_service.py`, `chat_service.py`.

### Meeting Workflow

```
Record audio (Web Audio API)
  → POST /api/recordings/upload (Whisper transcription)
  → Select meeting type on detail page
  → POST /api/recordings/<id>/summarize (OpenRouter → JSONB summary)
  → [Optional] POST /api/recordings/<id>/generate-title (AI title)
  → Meeting status: recording → transcribing → selecting_type → summarizing → complete
```

### Summary Schema (JSONB)

Web summary:
```json
{
  "executive_summary": "...",
  "action_items": [{"id": "uuid", "text": "...", "owner": "...", "deadline": "..."}],
  "decisions_made": ["..."],
  "key_discussion_points": ["..."],
  "follow_ups": ["..."]
}
```

Mobile summary adds: `participant_updates[]`, `blockers[]`, `open_questions[]`, `notable_details[]`.

### Action Item Lifecycle

- UUIDs assigned server-side; `ensure_action_item_ids()` backfills missing IDs
- Editable by meeting owner (web) and share link viewer (public access)
- Every field change logged in `action_item_history` with who changed it (user ID or "public")
- Supports drag-to-reorder (persisted server-side)

## Database

PostgreSQL via Supabase. UUIDs as primary keys, cascading deletes, auto-updated `updated_at` triggers.

| Table | Purpose |
|-------|---------|
| `users` | Users: id, email, password_hash, display_name, role (admin/user), is_active |
| `folders` | User-created folders: id, user_id, name, color, icon, sort_order |
| `meeting_types` | AI prompt templates: id, user_id, name, icon, prompt_template, is_default |
| `meetings` | Meetings: id, user_id, folder_id, title, transcript, summary (JSONB), status, duration_seconds |
| `mobile_auth_sessions` | Mobile JWT sessions: refresh_token_hash, device_name, expires_at, revoked_at |
| `shared_links` | Public share links: meeting_id, user_id, is_active |
| `meeting_comments` | Collaborative comments on meetings |
| `action_item_history` | Audit trail: field_changed, old_value, new_value, changed_by_type, changed_by_user_id |
| `meeting_presence` | Real-time viewer tracking: viewer_id, display_name, avatar_color, last_seen_at (15s TTL) |

**Full-text search:** Stored procedure `list_user_meetings()` with `pg_trgm` index on title + transcript, returns pagination + snippet extraction.

**Schema source:** `migrations/schema.sql` (baseline), plus chronological migration files.

## Routes Reference

### Auth (`routes/auth.py`)
- `GET/POST /login` — Session login
- `GET/POST /register` — Registration (seeds 6 default meeting types)
- `POST /logout`
- `GET /account` — Account settings
- `POST /account/profile` — Update email/display name
- `POST /account/password` — Change password

### Main (`routes/main.py`)
- `GET /` — Landing (unauthenticated) or dashboard (authenticated)
- `GET /meeting/<id>` — Meeting detail page
- `GET /meeting-types` — Prompt editor

### Recordings (`routes/recordings.py`)
- `GET /api/recordings/` — List meetings (uses `list_user_meetings()` RPC with search/pagination)
- `GET /api/recordings/<id>` — Single meeting
- `POST /api/recordings/upload` — Create meeting from audio file (triggers transcription)
- `POST /api/recordings/transcribe-chunk` — Streaming transcription
- `POST /api/recordings/<id>/transcribe` — Re-transcribe
- `POST /api/recordings/<id>/summarize` — Generate summary
- `POST /api/recordings/<id>/generate-title` — AI title generation
- `DELETE /api/recordings/<id>` — Delete meeting

### Chat (`routes/chat.py`)
- `GET /api/meetings/<id>/chat` — Chat history
- `POST /api/meetings/<id>/chat` — Stream AI response (SSE); requires `status = complete`
- `DELETE /api/meetings/<id>/chat` — Clear history

### Share (`routes/share.py`)
- `POST /api/recordings/<id>/share` — Create public share link
- `DELETE /api/recordings/<id>/share` — Revoke link
- `GET /share/<share_id>` — Public view (no auth required); supports action item editing

### Presence (`routes/presence.py`)
- `POST /api/meetings/<id>/presence/update` — Register/refresh viewer (15s TTL)
- `GET /api/meetings/<id>/presence` — Get active viewers

### Admin (`routes/admin.py`)
- `GET /admin` — Admin panel
- `GET /api/admin/users` — All users with meeting counts
- `POST /api/admin/users/<id>/toggle` — Enable/disable user

### API Utility (`routes/api.py`)
- `GET /api/health` — Health check (returns version)
- `GET /api/settings` — Configuration status
- `POST /api/settings/model` — Runtime model switching

### Mobile (`routes/mobile.py`, `routes/mobile_auth.py`)
Stateless endpoints — no DB meeting records created, just AI service calls:
- `POST /api/mobile/transcribe` — Transcribe audio, return text
- `POST /api/mobile/summarize` — Summarize transcript, return JSON
- `POST /api/mobile/generate-title` — Generate title from transcript
- `POST /api/mobile/auth/register` — Create account + issue tokens
- `POST /api/mobile/auth/login` — Authenticate + issue tokens
- `POST /api/mobile/auth/refresh` — Refresh access token
- `POST /api/mobile/auth/logout` — Revoke session

Mobile auth: Bearer token in `Authorization` header. Access tokens expire in 1h, refresh tokens in 45 days.

## Important Notes

- Audio files >24MB auto-chunked; whisper.cpp requires WAV (ffmpeg conversion happens automatically)
- Meeting types: 6 defaults seeded per user on registration; default types cannot be deleted, only reset
- Presence polling is client-driven (no WebSocket) — viewers expire after 15s without a ping
- `claim_orphan_data()` in auth_service: admin feature to reassign pre-existing data to a user
- Lucide icons loaded from CDN
- `.env` contains secrets — never commit it
- Cache-busting: `app.py` injects a timestamp into all Jinja2 templates at startup
- ProxyFix middleware handles Railway.app reverse proxy headers
