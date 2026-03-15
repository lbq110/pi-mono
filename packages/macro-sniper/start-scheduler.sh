#!/bin/bash
set -euo pipefail

PIDFILE="/tmp/macro-sniper-scheduler.pid"
LOGFILE="/tmp/macro-sniper-scheduler.log"

cd /root/pi-mono/pi-mono/packages/macro-sniper

# Handle restart: kill old process first
if [ "${1:-}" = "restart" ] && [ -f "$PIDFILE" ]; then
	OLD_PID=$(cat "$PIDFILE")
	if kill -0 "$OLD_PID" 2>/dev/null; then
		echo "Stopping old scheduler (PID: $OLD_PID)"
		kill "$OLD_PID"
		sleep 2
		# Force kill if still alive
		if kill -0 "$OLD_PID" 2>/dev/null; then
			kill -9 "$OLD_PID" 2>/dev/null || true
		fi
	fi
	rm -f "$PIDFILE"
fi

# Check if already running
if [ -f "$PIDFILE" ]; then
	OLD_PID=$(cat "$PIDFILE")
	if kill -0 "$OLD_PID" 2>/dev/null; then
		echo "Scheduler already running (PID: $OLD_PID). Kill it first or use: $0 restart"
		exit 1
	else
		echo "Stale PID file found (PID $OLD_PID not running), removing"
		rm -f "$PIDFILE"
	fi
fi

# Start
nohup node --env-file=.env --import tsx src/cli.ts jobs start > "$LOGFILE" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PIDFILE"
echo "Scheduler started (PID: $NEW_PID, log: $LOGFILE)"
