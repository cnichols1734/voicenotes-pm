#!/bin/bash
# ============================================================================
# VoiceNotes PM - Local Whisper Server Startup Script
#
# Starts:
#   1. whisper.cpp server (local Whisper on port 8178)
#   2. Whisper Monitor dashboard (proxy on port 8179)
#   3. Cloudflare Tunnel (exposes monitor to the internet)
#
# Usage:
#   ./start-whisper.sh        # Start all services
#   ./start-whisper.sh stop   # Stop all services
#
# Dashboard: http://localhost:8179
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WHISPER_DIR="$SCRIPT_DIR/whisper.cpp"
MODEL="$WHISPER_DIR/models/ggml-large-v3-turbo.bin"
WHISPER_PORT=8178
MONITOR_PORT=8179
PID_FILE="/tmp/whisper-server.pid"
MONITOR_PID_FILE="/tmp/whisper-monitor.pid"
TUNNEL_PID_FILE="/tmp/whisper-tunnel.pid"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

stop_services() {
    echo -e "${YELLOW}Stopping services...${NC}"
    if [ -f "$PID_FILE" ]; then
        kill $(cat "$PID_FILE") 2>/dev/null
        rm -f "$PID_FILE"
        echo -e "  ${GREEN}✓${NC} Whisper server stopped"
    fi
    if [ -f "$MONITOR_PID_FILE" ]; then
        kill $(cat "$MONITOR_PID_FILE") 2>/dev/null
        rm -f "$MONITOR_PID_FILE"
        echo -e "  ${GREEN}✓${NC} Monitor dashboard stopped"
    fi
    if [ -f "$TUNNEL_PID_FILE" ]; then
        kill $(cat "$TUNNEL_PID_FILE") 2>/dev/null
        rm -f "$TUNNEL_PID_FILE"
        echo -e "  ${GREEN}✓${NC} Cloudflare tunnel stopped"
    fi
}

if [ "$1" = "stop" ]; then
    stop_services
    exit 0
fi

# Check if already running
if [ -f "$PID_FILE" ] && kill -0 $(cat "$PID_FILE") 2>/dev/null; then
    echo -e "${YELLOW}Whisper server is already running (PID $(cat $PID_FILE))${NC}"
    echo -e "Run '${CYAN}$0 stop${NC}' first to restart."
    exit 1
fi

# Check model exists
if [ ! -f "$MODEL" ]; then
    echo -e "${RED}Model not found at $MODEL${NC}"
    echo "Run: bash $WHISPER_DIR/models/download-ggml-model.sh large-v3-turbo"
    exit 1
fi

echo ""
echo -e "${CYAN}  ╔══════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}  ║   🎙️  VoiceNotes PM - Local Whisper          ║${NC}"
echo -e "${CYAN}  ╚══════════════════════════════════════════════╝${NC}"
echo ""

# 1. Start whisper.cpp server
echo -e "${YELLOW}[1/3] Starting whisper.cpp server on port $WHISPER_PORT...${NC}"
"$WHISPER_DIR/build/bin/whisper-server" \
    -m "$MODEL" \
    --port $WHISPER_PORT \
    --host 127.0.0.1 \
    > /tmp/whisper-server.log 2>&1 &
echo $! > "$PID_FILE"
sleep 3

if ! kill -0 $(cat "$PID_FILE") 2>/dev/null; then
    echo -e "${RED}  ✗ Failed to start whisper server. Check /tmp/whisper-server.log${NC}"
    exit 1
fi
echo -e "  ${GREEN}✓${NC} Whisper server running (PID $(cat $PID_FILE))"

# 2. Start monitor dashboard
echo -e "${YELLOW}[2/3] Starting monitor dashboard on port $MONITOR_PORT...${NC}"
cd "$SCRIPT_DIR"
python3 "$SCRIPT_DIR/whisper-monitor.py" > /tmp/whisper-monitor.log 2>&1 &
echo $! > "$MONITOR_PID_FILE"
sleep 2

if ! kill -0 $(cat "$MONITOR_PID_FILE") 2>/dev/null; then
    echo -e "${RED}  ✗ Failed to start monitor. Check /tmp/whisper-monitor.log${NC}"
    echo -e "  ${YELLOW}Hint: pip3 install flask requests${NC}"
    exit 1
fi
echo -e "  ${GREEN}✓${NC} Monitor dashboard running (PID $(cat $MONITOR_PID_FILE))"

# 3. Start Cloudflare tunnel (pointing to monitor, not whisper directly)
echo -e "${YELLOW}[3/3] Starting Cloudflare tunnel...${NC}"
cloudflared tunnel --url http://127.0.0.1:$MONITOR_PORT > /tmp/whisper-tunnel.log 2>&1 &
echo $! > "$TUNNEL_PID_FILE"
sleep 5

TUNNEL_URL=$(grep -o 'https://[a-zA-Z0-9-]*\.trycloudflare\.com' /tmp/whisper-tunnel.log | head -1)

if [ -z "$TUNNEL_URL" ]; then
    echo -e "${RED}  ✗ Failed to get tunnel URL. Check /tmp/whisper-tunnel.log${NC}"
    exit 1
fi

echo -e "  ${GREEN}✓${NC} Tunnel running (PID $(cat $TUNNEL_PID_FILE))"
echo ""
echo -e "${GREEN}  ════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  ✅ All services running!${NC}"
echo -e ""
echo -e "  📊 Dashboard:  ${CYAN}http://localhost:$MONITOR_PORT${NC}"
echo -e "  🌐 Tunnel:     ${CYAN}$TUNNEL_URL${NC}"
echo -e ""
echo -e "  ${YELLOW}Set this in Railway env vars:${NC}"
echo -e "  ${CYAN}WHISPER_BASE_URL=$TUNNEL_URL${NC}"
echo -e "${GREEN}  ════════════════════════════════════════════════${NC}"
echo ""
echo -e "  To stop:  ${CYAN}$0 stop${NC}"
echo -e "  Logs:     ${CYAN}tail -f /tmp/whisper-server.log${NC}"
echo ""
