#!/bin/bash
set -e

echo "Starting TraceRoot services..."

# Start Next.js frontend in background
echo "Building and starting Next.js frontend on port 3000..."
cd /app/traceroot/ui
rm -rf .next
npm run build
PORT=3000 npm start &

# Start FastAPI backend
echo "Starting FastAPI backend with uvicorn..."
cd /app/traceroot
source venv/bin/activate
uvicorn rest.main:app --host 0.0.0.0 --port 8000 &

sleep 30
