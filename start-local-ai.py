#!/usr/bin/env python3
"""
VoiceNotes PM - Local AI Startup Script

Starts (or shows status of) all local AI services:
  1. whisper.cpp server (port 8178)
  2. Whisper Monitor dashboard (port 8179)
  3. Cloudflare Tunnel for Whisper (→ monitor on 8179)
  4. Cloudflare Tunnel for LM Studio / Qwen (→ LM Studio on 1234)

Usage:
  python3 start-local-ai.py          # Start everything
  python3 start-local-ai.py stop     # Stop everything
"""

import json
import os
import re
import signal
import socket
import subprocess
import sys
import time
import urllib.parse

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
WHISPER_BIN = os.path.join(SCRIPT_DIR, "whisper.cpp", "build", "bin", "whisper-server")
WHISPER_MODEL = os.path.join(SCRIPT_DIR, "whisper.cpp", "models", "ggml-large-v3-turbo.bin")
MONITOR_SCRIPT = os.path.join(SCRIPT_DIR, "whisper-monitor.py")
VENV_PYTHON = os.path.join(SCRIPT_DIR, "venv-ai", "bin", "python3")

# HuggingFace token for pyannote speaker diarization
HF_TOKEN_FILE = os.path.join(SCRIPT_DIR, ".hf_token")

WHISPER_PORT = 8178
MONITOR_PORT = 8179
LM_STUDIO_PORT = 1234

RAILWAY_CONFIG_FILE = os.path.join(SCRIPT_DIR, ".railway-sync.json")
RAILWAY_GRAPHQL_URL = "https://backboard.railway.com/graphql/v2"

PID_FILES = {
    "whisper": "/tmp/voicenotes-whisper.pid",
    "monitor": "/tmp/voicenotes-monitor.pid",
    "tunnel_whisper": "/tmp/voicenotes-tunnel-whisper.pid",
    "tunnel_llm": "/tmp/voicenotes-tunnel-llm.pid",
}

LOG_FILES = {
    "whisper": "/tmp/voicenotes-whisper.log",
    "monitor": "/tmp/voicenotes-monitor.log",
    "tunnel_whisper": "/tmp/voicenotes-tunnel-whisper.log",
    "tunnel_llm": "/tmp/voicenotes-tunnel-llm.log",
}

# ---------------------------------------------------------------------------
# Colors
# ---------------------------------------------------------------------------
G = "\033[92m"  # green
Y = "\033[93m"  # yellow
C = "\033[96m"  # cyan
R = "\033[91m"  # red
D = "\033[90m"  # dim
B = "\033[1m"   # bold
N = "\033[0m"   # reset


def banner():
    print(f"""
{C}  ╔═══════════════════════════════════════════════════╗
  ║  🎙️  VoiceNotes PM — Local AI Services             ║
  ╚═══════════════════════════════════════════════════╝{N}
""")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def is_pid_alive(pid_file: str) -> int | None:
    """Return PID if the process from pid_file is alive, else None."""
    if not os.path.exists(pid_file):
        return None
    try:
        pid = int(open(pid_file).read().strip())
        os.kill(pid, 0)  # signal 0 = check if alive
        return pid
    except (ValueError, ProcessLookupError, PermissionError, FileNotFoundError):
        return None


def is_port_open(port: int) -> bool:
    """Check if a port is accepting connections."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(1)
        return s.connect_ex(("127.0.0.1", port)) == 0


def get_tunnel_url(log_file: str) -> str | None:
    """Extract the trycloudflare.com URL from a tunnel log file."""
    if not os.path.exists(log_file):
        return None
    try:
        content = open(log_file).read()
        match = re.search(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com", content)
        return match.group() if match else None
    except Exception:
        return None


def is_url_reachable(url: str) -> bool:
    """Check if a tunnel URL's hostname resolves in DNS."""
    try:
        hostname = urllib.parse.urlparse(url).hostname
        socket.getaddrinfo(hostname, 443, socket.AF_INET)
        return True
    except (socket.gaierror, Exception):
        return False


# ---------------------------------------------------------------------------
# Railway sync
# ---------------------------------------------------------------------------
def load_railway_config() -> dict | None:
    if not os.path.exists(RAILWAY_CONFIG_FILE):
        return None
    try:
        with open(RAILWAY_CONFIG_FILE) as f:
            return json.load(f)
    except Exception:
        return None


def railway_api(token: str, query: str, variables: dict = None) -> dict:
    """Make a Railway GraphQL API call via curl (avoids urllib User-Agent 403s)."""
    payload = {"query": query}
    if variables:
        payload["variables"] = variables
    result = subprocess.run(
        ["curl", "-s", "-X", "POST", RAILWAY_GRAPHQL_URL,
         "-H", f"Authorization: Bearer {token}",
         "-H", "Content-Type: application/json",
         "-d", json.dumps(payload)],
        capture_output=True, text=True, timeout=15,
    )
    return json.loads(result.stdout)


def push_urls_to_railway(whisper_url: str | None, llm_url: str | None) -> bool:
    """Push current tunnel URLs into Railway env vars and trigger a redeploy."""
    config = load_railway_config()
    if not config:
        print(f"  {Y}⚠{N}  Railway sync not set up. Run: {D}python3 {os.path.basename(__file__)} setup{N}")
        return False

    token = config.get("token")
    project_id = config.get("project_id")
    environment_id = config.get("environment_id")
    service_id = config.get("service_id")

    if not all([token, project_id, environment_id, service_id]):
        print(f"  {Y}⚠{N}  Railway config incomplete. Run: {D}python3 {os.path.basename(__file__)} setup{N}")
        return False

    vars_to_set = {}
    if whisper_url:
        vars_to_set["WHISPER_BASE_URL"] = whisper_url
    if llm_url:
        vars_to_set["LLM_BASE_URL"] = f"{llm_url}/v1"

    if not vars_to_set:
        return False

    mutation = """
    mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) {
      variableCollectionUpsert(input: $input)
    }
    """
    try:
        result = railway_api(token, mutation, {
            "input": {
                "projectId": project_id,
                "environmentId": environment_id,
                "serviceId": service_id,
                "variables": vars_to_set,
            }
        })
        if "errors" in result:
            print(f"  {R}✗{N} Railway API error: {result['errors'][0]['message']}")
            return False
        print(f"  {G}✓{N} Railway env vars updated — redeploy triggered")
        return True
    except Exception as exc:
        print(f"  {R}✗{N} Failed to push to Railway: {exc}")
        return False


def railway_setup():
    """Interactive setup: save Railway token + project/service IDs to config file."""
    banner()
    print(f"  {B}Railway Sync Setup{N}\n")
    print(f"  This lets the script auto-update Railway env vars whenever tunnels restart.")
    print(f"  You'll need a Railway API token from: {C}https://railway.com/account/tokens{N}\n")

    token = input(f"  Paste your Railway API token: ").strip()
    if not token:
        print(f"  {R}✗{N} No token provided. Aborting.")
        return

    # Verify token and list projects
    print(f"\n  {D}Connecting to Railway...{N}")
    try:
        result = railway_api(token, """
        query {
          me {
            name
            projects {
              edges {
                node {
                  id
                  name
                  environments { edges { node { id name } } }
                  services { edges { node { id name } } }
                }
              }
            }
          }
        }
        """)
    except Exception as exc:
        print(f"  {R}✗{N} Could not connect to Railway: {exc}")
        return

    if "errors" in result:
        print(f"  {R}✗{N} Auth failed: {result['errors'][0]['message']}")
        return

    me = result["data"]["me"]
    print(f"  {G}✓{N} Connected as {B}{me['name']}{N}\n")

    projects = [e["node"] for e in me["projects"]["edges"]]
    if not projects:
        print(f"  {R}✗{N} No projects found.")
        return

    print(f"  {B}Projects:{N}")
    for i, p in enumerate(projects):
        print(f"    {D}[{i}]{N} {p['name']} {D}({p['id']}){N}")

    idx = input(f"\n  Select project number [0]: ").strip() or "0"
    project = projects[int(idx)]

    environments = [e["node"] for e in project["environments"]["edges"]]
    print(f"\n  {B}Environments:{N}")
    for i, e in enumerate(environments):
        print(f"    {D}[{i}]{N} {e['name']} {D}({e['id']}){N}")

    idx = input(f"\n  Select environment number [0]: ").strip() or "0"
    environment = environments[int(idx)]

    services = [e["node"] for e in project["services"]["edges"]]
    print(f"\n  {B}Services:{N}")
    for i, s in enumerate(services):
        print(f"    {D}[{i}]{N} {s['name']} {D}({s['id']}){N}")

    idx = input(f"\n  Select service number [0]: ").strip() or "0"
    service = services[int(idx)]

    config = {
        "token": token,
        "project_id": project["id"],
        "environment_id": environment["id"],
        "service_id": service["id"],
        "_project_name": project["name"],
        "_environment_name": environment["name"],
        "_service_name": service["name"],
    }
    with open(RAILWAY_CONFIG_FILE, "w") as f:
        json.dump(config, f, indent=2)

    print(f"\n  {G}✓{N} Config saved to {D}{RAILWAY_CONFIG_FILE}{N}")
    print(f"  {G}✓{N} Project:     {B}{project['name']}{N}")
    print(f"  {G}✓{N} Environment: {B}{environment['name']}{N}")
    print(f"  {G}✓{N} Service:     {B}{service['name']}{N}")
    print(f"\n  Next time you run {D}python3 {os.path.basename(__file__)}{N}, Railway will auto-sync.\n")


def start_process(name: str, cmd: list, log_file: str, pid_file: str, wait: float = 2.0):
    """Start a background process, save PID, redirect output to log."""
    log_fh = open(log_file, "w")
    proc = subprocess.Popen(cmd, stdout=log_fh, stderr=subprocess.STDOUT, cwd=SCRIPT_DIR, env=os.environ.copy())
    with open(pid_file, "w") as f:
        f.write(str(proc.pid))
    time.sleep(wait)
    if proc.poll() is not None:
        print(f"  {R}✗{N} {name} failed to start. Check {D}{log_file}{N}")
        return False
    print(f"  {G}✓{N} {name} started {D}(PID {proc.pid}){N}")
    return True


def stop_process(name: str, pid_file: str):
    """Stop a process by PID file."""
    pid = is_pid_alive(pid_file)
    if pid:
        try:
            os.kill(pid, signal.SIGTERM)
            print(f"  {G}✓{N} {name} stopped {D}(PID {pid}){N}")
        except Exception:
            pass
    if os.path.exists(pid_file):
        os.unlink(pid_file)


# ---------------------------------------------------------------------------
# Service management
# ---------------------------------------------------------------------------
def ensure_whisper():
    """Start whisper.cpp server if not running."""
    pid = is_pid_alive(PID_FILES["whisper"])
    if pid and is_port_open(WHISPER_PORT):
        print(f"  {G}✓{N} Whisper server {Y}already running{N} {D}(PID {pid}, port {WHISPER_PORT}){N}")
        return True

    if not os.path.exists(WHISPER_BIN):
        print(f"  {R}✗{N} whisper-server binary not found at {WHISPER_BIN}")
        return False
    if not os.path.exists(WHISPER_MODEL):
        print(f"  {R}✗{N} Model not found at {WHISPER_MODEL}")
        return False

    print(f"  {Y}⟳{N} Starting whisper.cpp server on port {WHISPER_PORT}...")
    return start_process(
        "Whisper server",
        [WHISPER_BIN, "-m", WHISPER_MODEL, "--port", str(WHISPER_PORT), "--host", "127.0.0.1"],
        LOG_FILES["whisper"],
        PID_FILES["whisper"],
        wait=3.0,
    )


def _load_hf_token() -> str | None:
    """Load HuggingFace token from .hf_token file."""
    if os.path.exists(HF_TOKEN_FILE):
        return open(HF_TOKEN_FILE).read().strip()
    return os.environ.get("HF_TOKEN")


def ensure_monitor():
    """Start the whisper monitor dashboard if not running."""
    pid = is_pid_alive(PID_FILES["monitor"])
    if pid and is_port_open(MONITOR_PORT):
        print(f"  {G}✓{N} Monitor dashboard {Y}already running{N} {D}(PID {pid}, port {MONITOR_PORT}){N}")
        return True

    # Port is up but PID file is stale — something else is serving on it, treat as running
    if is_port_open(MONITOR_PORT):
        print(f"  {G}✓{N} Monitor dashboard {Y}already running{N} {D}(port {MONITOR_PORT}){N}")
        return True

    if not os.path.exists(MONITOR_SCRIPT):
        print(f"  {R}✗{N} Monitor script not found at {MONITOR_SCRIPT}")
        return False

    # Use venv python for pyannote/diarization support
    python_bin = VENV_PYTHON if os.path.exists(VENV_PYTHON) else sys.executable
    if python_bin == VENV_PYTHON:
        print(f"  {D}Using venv-ai python (pyannote available){N}")
    else:
        print(f"  {Y}⚠{N}  venv-ai not found — diarization will be unavailable")

    # Pass HF_TOKEN to the monitor process for pyannote
    hf_token = _load_hf_token()
    if hf_token:
        os.environ["HF_TOKEN"] = hf_token
        print(f"  {G}✓{N} HF_TOKEN loaded for speaker diarization")
    else:
        print(f"  {Y}⚠{N}  No HF_TOKEN found — diarization will be unavailable")
        print(f"    {D}Save your token to {HF_TOKEN_FILE}{N}")

    print(f"  {Y}⟳{N} Starting monitor dashboard on port {MONITOR_PORT}...")
    return start_process(
        "Monitor dashboard",
        [python_bin, MONITOR_SCRIPT],
        LOG_FILES["monitor"],
        PID_FILES["monitor"],
        wait=2.0,
    )


def ensure_tunnel(name: str, port: int, pid_key: str, log_key: str) -> tuple[str | None, bool]:
    """
    Start a Cloudflare tunnel if not running (or if existing URL is dead).
    Returns (url, is_new) — is_new=True means a fresh tunnel was just started.
    """
    pid = is_pid_alive(PID_FILES[pid_key])
    if pid:
        url = get_tunnel_url(LOG_FILES[log_key])
        if url and is_url_reachable(url):
            print(f"  {G}✓{N} {name} tunnel {Y}already running{N} {D}(PID {pid}){N}")
            return url, False
        elif url:
            print(f"  {Y}⚠{N}  {name} tunnel URL unreachable — restarting...")
            try:
                os.kill(pid, signal.SIGTERM)
                time.sleep(1)
            except ProcessLookupError:
                pass
            if os.path.exists(PID_FILES[pid_key]):
                os.unlink(PID_FILES[pid_key])

    print(f"  {Y}⟳{N} Starting tunnel for {name} (port {port})...")
    ok = start_process(
        f"{name} tunnel",
        ["cloudflared", "tunnel", "--url", f"http://127.0.0.1:{port}"],
        LOG_FILES[log_key],
        PID_FILES[pid_key],
        wait=6.0,
    )
    if ok:
        return get_tunnel_url(LOG_FILES[log_key]), True
    return None, True


def check_lm_studio() -> bool:
    """Check if LM Studio is running."""
    return is_port_open(LM_STUDIO_PORT)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def stop_all():
    """Stop all services."""
    banner()
    print(f"  {Y}Stopping all services...{N}\n")
    stop_process("Whisper server", PID_FILES["whisper"])
    stop_process("Monitor dashboard", PID_FILES["monitor"])
    stop_process("Whisper tunnel", PID_FILES["tunnel_whisper"])
    stop_process("LLM tunnel", PID_FILES["tunnel_llm"])
    print(f"\n  {G}All services stopped.{N}\n")


def start_all():
    """Start all services and show URLs."""
    banner()

    # ---- Whisper ----
    print(f"  {B}🎙️  WHISPER (Speech-to-Text){N}")
    print(f"  {D}{'─' * 45}{N}")

    whisper_ok = ensure_whisper()
    if whisper_ok:
        ensure_monitor()
    if whisper_ok:
        whisper_url, whisper_new = ensure_tunnel("Whisper", MONITOR_PORT, "tunnel_whisper", "tunnel_whisper")
    else:
        whisper_url, whisper_new = None, False
    print()

    # ---- LLM ----
    print(f"  {B}🧠  QWEN 3.5 (Summarization){N}")
    print(f"  {D}{'─' * 45}{N}")

    if check_lm_studio():
        print(f"  {G}✓{N} LM Studio {Y}already running{N} {D}(port {LM_STUDIO_PORT}){N}")
        llm_url, llm_new = ensure_tunnel("LLM", LM_STUDIO_PORT, "tunnel_llm", "tunnel_llm")
    else:
        print(f"  {R}✗{N} LM Studio not running on port {LM_STUDIO_PORT}")
        print(f"    {D}Start LM Studio and load your model first.{N}")
        llm_url, llm_new = None, False
    print()

    # ---- Summary ----
    print(f"  {C}{'═' * 50}{N}")
    print(f"  {G}{B}  Status Summary{N}")
    print(f"  {C}{'═' * 50}{N}\n")

    print(f"  {B}Dashboard:{N}     {C}http://localhost:{MONITOR_PORT}{N}")
    print()

    if whisper_url:
        print(f"  {B}Whisper URL:{N}   {C}{whisper_url}{N}")
        print(f"  {D}  → Set in Railway: WHISPER_BASE_URL={whisper_url}{N}")
    else:
        print(f"  {R}Whisper:{N}       Not available")
    print()

    if llm_url:
        print(f"  {B}LLM URL:{N}       {C}{llm_url}{N}")
        print(f"  {D}  → Set in Railway: LLM_BASE_URL={llm_url}/v1{N}")
    else:
        print(f"  {R}LLM:{N}           Not available")
    print()

    # Cost estimate
    if whisper_url and llm_url:
        print(f"  {G}💰 Running fully local — $0.00 per meeting!{N}")
    elif whisper_url:
        print(f"  {Y}💰 Whisper local, LLM via OpenRouter{N}")
    else:
        print(f"  {Y}💰 Using cloud APIs (OpenAI + OpenRouter){N}")
    print()

    # Auto-sync new tunnel URLs to Railway
    if whisper_new or llm_new:
        if load_railway_config():
            print(f"  {B}🚂  Syncing URLs to Railway...{N}")
            push_urls_to_railway(whisper_url, llm_url)
        else:
            print(f"  {D}💡 Tip: run '{os.path.basename(__file__)} setup' to auto-sync Railway on tunnel restart.{N}")
        print()

    print(f"  {D}To stop:  python3 {os.path.basename(__file__)} stop{N}")
    print()


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "start"
    if cmd == "stop":
        stop_all()
    elif cmd == "setup":
        railway_setup()
    else:
        start_all()
