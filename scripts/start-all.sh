#!/usr/bin/env bash
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# File to track background PIDs
PID_FILE="$ROOT_DIR/scripts/.pids"
: > "$PID_FILE"

cleanup() {
  echo ""
  echo "Stopping all services..."
  while read -r pid; do
    kill "$pid" 2>/dev/null || true
  done < "$PID_FILE"
  docker compose down 2>/dev/null || true
  rm -f "$PID_FILE"
  echo "All services stopped."
  exit 0
}

trap cleanup SIGINT SIGTERM

echo "Starting infrastructure (docker compose)..."
docker compose up -d

echo "Waiting for infrastructure to be ready..."
sleep 3

echo "Running db:push..."
pnpm db:push

echo "Starting server..."
(cd packages/server && set -a && source .env && set +a && npx tsx src/index.ts) &
echo $! >> "$PID_FILE"

# Wait for server to be ready before starting worker
sleep 2

echo "Starting worker..."
# Worker needs RELOAD_API_KEY — source it from packages/worker/.env if it exists
(cd tasks && [ -f ../packages/worker/.env ] && set -a && source ../packages/worker/.env && set +a; npx tsx run-worker.ts) &
echo $! >> "$PID_FILE"

echo "Starting dashboard..."
(cd packages/dashboard && npx next dev --port 3001) &
echo $! >> "$PID_FILE"

echo ""
echo "All services running. Press Ctrl+C to stop everything."
wait
