#!/usr/bin/env bash
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$ROOT_DIR/scripts/.pids"

if [ -f "$PID_FILE" ]; then
  echo "Stopping background services..."
  while read -r pid; do
    kill "$pid" 2>/dev/null || true
  done < "$PID_FILE"
  rm -f "$PID_FILE"
fi

echo "Stopping infrastructure..."
cd "$ROOT_DIR" && docker compose down

echo "All services stopped."
