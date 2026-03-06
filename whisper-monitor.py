"""
VoiceNotes PM - Local Whisper Monitor Dashboard

A lightweight proxy + dashboard that sits between Cloudflare Tunnel and whisper.cpp.
Forwards all /inference requests to whisper.cpp, logs them, and serves a live
dashboard at http://localhost:8179 showing real-time transcription activity.

Architecture:
  Cloudflare Tunnel → Monitor (port 8179) → whisper.cpp (port 8178)

Usage:
  python3 whisper-monitor.py
"""

import json
import logging
import os
import time
import threading
from datetime import datetime
from pathlib import Path

from flask import Flask, request, Response, jsonify, render_template_string
import requests

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
WHISPER_SERVER = os.environ.get("WHISPER_SERVER", "http://127.0.0.1:8178")
MONITOR_PORT = int(os.environ.get("MONITOR_PORT", "8179"))
MAX_LOG_ENTRIES = 200

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------
app = Flask(__name__)
log_entries = []
log_lock = threading.Lock()
stats = {
    "total_requests": 0,
    "total_audio_seconds": 0,
    "total_processing_time": 0,
    "errors": 0,
    "start_time": time.time(),
}

# ---------------------------------------------------------------------------
# Proxy /inference to whisper.cpp
# ---------------------------------------------------------------------------
@app.route("/inference", methods=["POST"])
def proxy_inference():
    """Forward inference requests to whisper.cpp and log everything."""
    start = time.time()
    entry = {
        "timestamp": datetime.now().isoformat(),
        "status": "processing",
        "error": None,
        "transcript": None,
        "duration_s": 0,
        "file_size_kb": 0,
        "audio_duration_s": 0,
        "source_ip": request.headers.get("CF-Connecting-IP", request.remote_addr),
    }

    try:
        # Get the uploaded file
        file = request.files.get("file")
        if file:
            file_bytes = file.read()
            entry["file_size_kb"] = round(len(file_bytes) / 1024, 1)
            entry["filename"] = file.filename or "unknown"

            # Estimate audio duration from WAV: size / (16000 Hz * 2 bytes * 1 channel)
            if file.filename and file.filename.endswith(".wav"):
                entry["audio_duration_s"] = round(len(file_bytes) / (16000 * 2), 1)

            # Forward to whisper.cpp
            files = {"file": (file.filename, file_bytes, file.content_type)}
            data = {k: v for k, v in request.form.items()}

            resp = requests.post(
                f"{WHISPER_SERVER}/inference",
                files=files,
                data=data,
                timeout=120,
            )

            elapsed = time.time() - start
            entry["duration_s"] = round(elapsed, 2)
            entry["status"] = "success" if resp.status_code == 200 else "error"

            if resp.status_code == 200:
                result = resp.json()
                text = result.get("text", "").strip()
                entry["transcript"] = text
                with log_lock:
                    stats["total_requests"] += 1
                    stats["total_audio_seconds"] += entry.get("audio_duration_s", 0)
                    stats["total_processing_time"] += elapsed
            else:
                entry["error"] = f"HTTP {resp.status_code}"
                with log_lock:
                    stats["errors"] += 1

            # Return the original response
            return Response(
                resp.content,
                status=resp.status_code,
                content_type=resp.headers.get("Content-Type", "application/json"),
            )
        else:
            entry["status"] = "error"
            entry["error"] = "No file in request"
            with log_lock:
                stats["errors"] += 1
            return jsonify({"error": "No file provided"}), 400

    except requests.exceptions.ConnectionError:
        entry["status"] = "error"
        entry["error"] = "whisper.cpp server not reachable"
        entry["duration_s"] = round(time.time() - start, 2)
        with log_lock:
            stats["errors"] += 1
        return jsonify({"error": "Whisper server not reachable"}), 502

    except Exception as exc:
        entry["status"] = "error"
        entry["error"] = str(exc)[:200]
        entry["duration_s"] = round(time.time() - start, 2)
        with log_lock:
            stats["errors"] += 1
        return jsonify({"error": str(exc)}), 500

    finally:
        with log_lock:
            log_entries.insert(0, entry)
            if len(log_entries) > MAX_LOG_ENTRIES:
                log_entries.pop()


# ---------------------------------------------------------------------------
# Diarize endpoint — async speaker-labeled transcription
# ---------------------------------------------------------------------------
import uuid as _uuid

# In-memory job store for async diarization (single process, so dict is fine)
_diarize_jobs = {}


@app.route("/diarize", methods=["POST"])
def diarize_endpoint():
    """
    Accept audio, start diarization in background, return job_id immediately.
    Poll /diarize-status/<job_id> for the result.

    This avoids Cloudflare tunnel timeouts (~100s) on long recordings.
    """
    file = request.files.get("file")
    if not file:
        return jsonify({"error": "No file provided"}), 400

    file_bytes = file.read()
    file_size_kb = round(len(file_bytes) / 1024, 1)
    filename = file.filename or "unknown"
    audio_duration_s = 0
    if filename.endswith(".wav"):
        audio_duration_s = round(len(file_bytes) / (16000 * 2), 1)

    # Parse optional speaker hints
    min_speakers = request.form.get("min_speakers", type=int)
    max_speakers = request.form.get("max_speakers", type=int)

    job_id = str(_uuid.uuid4())
    _diarize_jobs[job_id] = {"status": "processing", "text": None, "error": None}

    # Log entry for dashboard
    entry = {
        "timestamp": datetime.now().isoformat(),
        "status": "processing",
        "error": None,
        "transcript": None,
        "duration_s": 0,
        "file_size_kb": file_size_kb,
        "audio_duration_s": audio_duration_s,
        "source_ip": request.headers.get("CF-Connecting-IP", request.remote_addr),
        "type": "diarize",
        "job_id": job_id,
    }
    with log_lock:
        log_entries.insert(0, entry)
        if len(log_entries) > MAX_LOG_ENTRIES:
            log_entries.pop()

    def run_diarization():
        start = time.time()
        try:
            from diarize_service import diarize_and_transcribe
            text = diarize_and_transcribe(
                file_bytes, WHISPER_SERVER,
                min_speakers=min_speakers,
                max_speakers=max_speakers,
            )
        except ImportError:
            # Diarization not available, fall back to plain whisper
            logger.warning("diarize_service not available, using plain whisper")
            files = {"file": (filename, file_bytes, "audio/wav")}
            data = {"response_format": "json"}
            resp = requests.post(
                f"{WHISPER_SERVER}/inference", files=files, data=data, timeout=600,
            )
            resp.raise_for_status()
            text = resp.json().get("text", "").strip()
        except Exception as exc:
            elapsed = time.time() - start
            _diarize_jobs[job_id] = {"status": "error", "text": None, "error": str(exc)[:500]}
            entry["status"] = "error"
            entry["error"] = str(exc)[:200]
            entry["duration_s"] = round(elapsed, 2)
            with log_lock:
                stats["errors"] += 1
            return

        elapsed = time.time() - start
        _diarize_jobs[job_id] = {"status": "complete", "text": text, "error": None}
        entry["status"] = "success"
        entry["transcript"] = text
        entry["duration_s"] = round(elapsed, 2)
        with log_lock:
            stats["total_requests"] += 1
            stats["total_audio_seconds"] += audio_duration_s
            stats["total_processing_time"] += elapsed

    thread = threading.Thread(target=run_diarization, daemon=True)
    thread.start()

    logger.info("Diarize job %s started (%.1f KB, ~%.0fs audio)", job_id, file_size_kb, audio_duration_s)
    return jsonify({"job_id": job_id})


@app.route("/diarize-status/<job_id>", methods=["GET"])
def diarize_status(job_id):
    """Poll for diarization job result."""
    job = _diarize_jobs.get(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404

    if job["status"] == "complete":
        text = job["text"]
        del _diarize_jobs[job_id]
        return jsonify({"status": "complete", "text": text})
    elif job["status"] == "error":
        error = job["error"]
        del _diarize_jobs[job_id]
        return jsonify({"status": "error", "error": error}), 500
    else:
        return jsonify({"status": "processing"})


# ---------------------------------------------------------------------------
# API for the dashboard
# ---------------------------------------------------------------------------
@app.route("/api/logs")
def api_logs():
    """Return recent log entries as JSON."""
    with log_lock:
        return jsonify({
            "logs": log_entries[:50],
            "stats": {
                **stats,
                "uptime_s": round(time.time() - stats["start_time"]),
                "avg_processing_time": round(
                    stats["total_processing_time"] / max(stats["total_requests"], 1), 2
                ),
            },
        })


# ---------------------------------------------------------------------------
# Dashboard HTML
# ---------------------------------------------------------------------------
DASHBOARD_HTML = """
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Whisper Monitor</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  :root {
    --bg: #0a0a0b;
    --bg-card: #141418;
    --bg-card-hover: #1a1a20;
    --border: #2a2a33;
    --text: #e4e4e7;
    --text-dim: #71717a;
    --text-faint: #52525b;
    --accent: #818cf8;
    --accent-glow: rgba(129, 140, 248, 0.15);
    --green: #4ade80;
    --green-dim: rgba(74, 222, 128, 0.12);
    --red: #f87171;
    --red-dim: rgba(248, 113, 113, 0.12);
    --yellow: #fbbf24;
    --radius: 12px;
    --mono: 'JetBrains Mono', monospace;
    --sans: 'Inter', -apple-system, sans-serif;
  }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--sans);
    min-height: 100vh;
    overflow-x: hidden;
  }

  /* Header */
  .header {
    padding: 28px 32px 20px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    backdrop-filter: blur(12px);
    position: sticky;
    top: 0;
    z-index: 10;
    background: rgba(10, 10, 11, 0.85);
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 14px;
  }

  .logo-icon {
    width: 40px;
    height: 40px;
    border-radius: 10px;
    background: linear-gradient(135deg, var(--accent), #6366f1);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 20px;
    box-shadow: 0 0 20px var(--accent-glow);
  }

  .header h1 {
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.02em;
  }

  .header h1 span {
    color: var(--text-dim);
    font-weight: 400;
  }

  .status-pill {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 14px;
    border-radius: 20px;
    font-size: 12px;
    font-weight: 600;
    border: 1px solid;
  }

  .status-pill.online {
    color: var(--green);
    border-color: rgba(74, 222, 128, 0.3);
    background: var(--green-dim);
  }

  .status-pill.offline {
    color: var(--red);
    border-color: rgba(248, 113, 113, 0.3);
    background: var(--red-dim);
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: currentColor;
    animation: pulse-dot 2s infinite;
  }

  @keyframes pulse-dot {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  /* Stats grid */
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px;
    padding: 24px 32px;
  }

  .stat-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 18px 20px;
    transition: border-color 0.2s, transform 0.2s;
  }

  .stat-card:hover {
    border-color: var(--accent);
    transform: translateY(-1px);
  }

  .stat-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-dim);
    margin-bottom: 8px;
  }

  .stat-value {
    font-size: 28px;
    font-weight: 700;
    font-family: var(--mono);
    letter-spacing: -0.02em;
    color: var(--text);
  }

  .stat-value.accent { color: var(--accent); }
  .stat-value.green { color: var(--green); }

  .stat-unit {
    font-size: 14px;
    font-weight: 400;
    color: var(--text-dim);
    margin-left: 2px;
  }

  /* Log section */
  .log-section {
    padding: 0 32px 32px;
  }

  .log-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
  }

  .log-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--text-dim);
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .log-count {
    background: var(--accent-glow);
    color: var(--accent);
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 600;
    font-family: var(--mono);
  }

  /* Log entries */
  .log-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .log-entry {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px 20px;
    transition: border-color 0.2s, background 0.2s;
    animation: slideIn 0.3s ease-out;
  }

  .log-entry:hover {
    border-color: var(--text-faint);
    background: var(--bg-card-hover);
  }

  @keyframes slideIn {
    from { opacity: 0; transform: translateY(-8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .log-meta {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 8px;
    flex-wrap: wrap;
  }

  .log-time {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text-faint);
  }

  .log-badge {
    padding: 2px 8px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 600;
    font-family: var(--mono);
  }

  .log-badge.success {
    background: var(--green-dim);
    color: var(--green);
  }

  .log-badge.error {
    background: var(--red-dim);
    color: var(--red);
  }

  .log-badge.processing {
    background: var(--accent-glow);
    color: var(--accent);
  }

  .log-badge.info {
    background: rgba(113, 113, 122, 0.15);
    color: var(--text-dim);
  }

  .log-transcript {
    font-family: var(--mono);
    font-size: 13px;
    color: var(--text);
    line-height: 1.6;
    background: rgba(255,255,255,0.03);
    padding: 10px 14px;
    border-radius: 8px;
    border-left: 3px solid var(--accent);
    margin-top: 8px;
    white-space: pre-wrap;
    max-height: 120px;
    overflow-y: auto;
  }

  .log-error {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--red);
    margin-top: 6px;
    padding: 8px 12px;
    background: var(--red-dim);
    border-radius: 6px;
  }

  .empty-state {
    text-align: center;
    padding: 60px 20px;
    color: var(--text-faint);
  }

  .empty-state-icon {
    font-size: 48px;
    margin-bottom: 16px;
    opacity: 0.5;
  }

  .empty-state h3 {
    font-size: 16px;
    color: var(--text-dim);
    margin-bottom: 6px;
  }

  .empty-state p {
    font-size: 13px;
  }

  /* Responsive */
  @media (max-width: 640px) {
    .header { padding: 20px 16px; }
    .stats-grid { padding: 16px; gap: 8px; }
    .log-section { padding: 0 16px 16px; }
    .stat-value { font-size: 22px; }
  }
</style>
</head>
<body>

<div class="header">
  <div class="header-left">
    <div class="logo-icon">🎙️</div>
    <h1>Whisper Monitor <span>· local</span></h1>
  </div>
  <div class="status-pill online" id="status-pill">
    <div class="status-dot"></div>
    <span id="status-text">Online</span>
  </div>
</div>

<div class="stats-grid">
  <div class="stat-card">
    <div class="stat-label">Total Requests</div>
    <div class="stat-value accent" id="stat-requests">0</div>
  </div>
  <div class="stat-card">
    <div class="stat-label">Audio Processed</div>
    <div class="stat-value green" id="stat-audio">0<span class="stat-unit">min</span></div>
  </div>
  <div class="stat-card">
    <div class="stat-label">Avg Processing</div>
    <div class="stat-value" id="stat-avg">0<span class="stat-unit">s</span></div>
  </div>
  <div class="stat-card">
    <div class="stat-label">Errors</div>
    <div class="stat-value" id="stat-errors">0</div>
  </div>
  <div class="stat-card">
    <div class="stat-label">Uptime</div>
    <div class="stat-value" id="stat-uptime">0<span class="stat-unit">m</span></div>
  </div>
  <div class="stat-card">
    <div class="stat-label">Cost Saved</div>
    <div class="stat-value green" id="stat-saved">$0<span class="stat-unit">.00</span></div>
  </div>
</div>

<div class="log-section">
  <div class="log-header">
    <div class="log-title">
      Recent Activity
      <span class="log-count" id="log-count">0</span>
    </div>
  </div>
  <div class="log-list" id="log-list">
    <div class="empty-state">
      <div class="empty-state-icon">🎧</div>
      <h3>Waiting for requests...</h3>
      <p>Transcription activity will appear here in real time.</p>
    </div>
  </div>
</div>

<script>
let previousCount = 0;
let lastLogHash = '';

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatUptime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function renderLogEntry(entry) {
  const badgeClass = entry.status === 'success' ? 'success' :
                      entry.status === 'error' ? 'error' : 'processing';
  const transcript = entry.transcript
    ? `<div class="log-transcript">${escapeHtml(entry.transcript)}</div>` : '';
  const error = entry.error
    ? `<div class="log-error">⚠ ${escapeHtml(entry.error)}</div>` : '';

  return `
    <div class="log-entry">
      <div class="log-meta">
        <span class="log-time">${formatTime(entry.timestamp)}</span>
        <span class="log-badge ${badgeClass}">${entry.status.toUpperCase()}</span>
        <span class="log-badge info">${entry.file_size_kb} KB</span>
        ${entry.audio_duration_s ? `<span class="log-badge info">${entry.audio_duration_s}s audio</span>` : ''}
        <span class="log-badge info">${entry.duration_s}s</span>
      </div>
      ${transcript}
      ${error}
    </div>`;
}

async function fetchLogs() {
  try {
    const resp = await fetch('/api/logs');
    const data = await resp.json();

    // Update stats (these are simple text swaps, no flicker)
    const s = data.stats;
    document.getElementById('stat-requests').textContent = s.total_requests;
    document.getElementById('stat-audio').innerHTML =
      `${(s.total_audio_seconds / 60).toFixed(1)}<span class="stat-unit">min</span>`;
    document.getElementById('stat-avg').innerHTML =
      `${s.avg_processing_time}<span class="stat-unit">s</span>`;
    document.getElementById('stat-errors').textContent = s.errors;
    document.getElementById('stat-uptime').innerHTML = formatUptime(s.uptime_s);

    // Cost saved: OpenAI charges $0.006/min
    const savedDollars = (s.total_audio_seconds / 60) * 0.006;
    document.getElementById('stat-saved').innerHTML = `$${savedDollars.toFixed(2)}`;

    // Update status pill
    const pill = document.getElementById('status-pill');
    const statusText = document.getElementById('status-text');
    pill.className = 'status-pill online';
    statusText.textContent = 'Online';

    // Only re-render logs if data actually changed
    const logHash = s.total_requests + '-' + s.errors + '-' + data.logs.length;
    if (logHash === lastLogHash) return; // nothing changed, skip DOM update
    lastLogHash = logHash;

    document.getElementById('log-count').textContent = data.logs.length;

    const list = document.getElementById('log-list');
    if (data.logs.length === 0) {
      list.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🎧</div>
          <h3>Waiting for requests...</h3>
          <p>Transcription activity will appear here in real time.</p>
        </div>`;
      return;
    }

    list.innerHTML = data.logs.map(renderLogEntry).join('');

    // Flash effect on new entries
    if (s.total_requests > previousCount && previousCount > 0) {
      const firstEntry = list.querySelector('.log-entry');
      if (firstEntry) {
        firstEntry.style.borderColor = 'var(--accent)';
        setTimeout(() => { firstEntry.style.borderColor = ''; }, 2000);
      }
    }
    previousCount = s.total_requests;

  } catch (err) {
    const pill = document.getElementById('status-pill');
    const statusText = document.getElementById('status-text');
    pill.className = 'status-pill offline';
    statusText.textContent = 'Offline';
  }
}

// Poll every 2 seconds
fetchLogs();
setInterval(fetchLogs, 2000);
</script>

</body>
</html>
"""


@app.route("/")
def dashboard():
    """Serve the monitoring dashboard."""
    return render_template_string(DASHBOARD_HTML)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import socket
    hostname = socket.gethostname()
    local_ip = socket.gethostbyname(hostname)

    print()
    print("  ╔══════════════════════════════════════════════╗")
    print("  ║   🎙️  Whisper Monitor Dashboard              ║")
    print("  ╚══════════════════════════════════════════════╝")
    print()
    print(f"  Dashboard:  http://localhost:{MONITOR_PORT}")
    print(f"  Network:    http://{local_ip}:{MONITOR_PORT}")
    print(f"  Proxying:   {WHISPER_SERVER}")
    print()
    print("  Point your Cloudflare Tunnel to this port instead:")
    print(f"  cloudflared tunnel --url http://127.0.0.1:{MONITOR_PORT}")
    print()

    app.run(host="0.0.0.0", port=MONITOR_PORT, debug=False)
