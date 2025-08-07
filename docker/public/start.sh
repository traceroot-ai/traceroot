#!/bin/bash
set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log_info() {
    echo -e "${GREEN}[TraceRoot]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[TraceRoot Warning]${NC} $1"
}

log_error() {
    echo -e "${RED}[TraceRoot Error]${NC} $1"
}

# Function to check if a service is ready
wait_for_service() {
    local service_name=$1
    local url=$2
    local max_attempts=${3:-30}
    
    log_info "Waiting for $service_name to be ready..."
    
    for i in $(seq 1 $max_attempts); do
        if curl -s "$url" &> /dev/null; then
            log_info "$service_name is ready ✓"
            return 0
        fi
        sleep 2
    done
    
    log_error "$service_name failed to start within expected time"
    return 1
}

# Cleanup function for graceful shutdown
cleanup() {
    log_warning "Shutting down services..."
    jobs -p | xargs -r kill
    exit 0
}

# Set up signal handlers
trap cleanup SIGTERM SIGINT

log_info "Starting TraceRoot services..."

# Start Next.js frontend in background
log_info "Building and starting Next.js frontend on port 3000..."
cd /app/traceroot/ui

# Clean build artifacts
rm -rf .next

# Build the frontend
log_info "Building frontend (this may take a few minutes)..."
npm run build

# Start the frontend
log_info "Starting frontend server..."
PORT=3000 npm start &
FRONTEND_PID=$!

# Give frontend some time to start
sleep 10

# Start FastAPI backend
log_info "Starting FastAPI backend with uvicorn..."
cd /app/traceroot
source venv/bin/activate

# Start the backend
log_info "Starting backend server..."
uvicorn rest.main:app --host 0.0.0.0 --port 8000 &
BACKEND_PID=$!

# Wait for services to be ready
wait_for_service "Backend" "http://localhost:8000/health" 30
wait_for_service "Frontend" "http://localhost:3000" 30

log_info "TraceRoot is ready!"
log_info "Frontend: http://localhost:3000"
log_info "Backend: http://localhost:8000"

# Keep the script running and monitor services
while true; do
    # Check if processes are still running
    if ! kill -0 $FRONTEND_PID 2>/dev/null; then
        log_error "Frontend process died, restarting..."
        cd /app/traceroot/ui
        PORT=3000 npm start &
        FRONTEND_PID=$!
    fi
    
    if ! kill -0 $BACKEND_PID 2>/dev/null; then
        log_error "Backend process died, restarting..."
        cd /app/traceroot
        source venv/bin/activate
        uvicorn rest.main:app --host 0.0.0.0 --port 8000 &
        BACKEND_PID=$!
    fi
    
    sleep 30
done 