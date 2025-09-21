#!/bin/bash

echo "🚀 Starting Multi-Agent Code Generator..."

# Activate virtual environment
source venv/bin/activate

echo "📦 Starting backend on port 9999..."
python simple_server.py &

echo "🎨 Starting frontend on port 3000..."
cd ui && npm run dev &

echo "✅ Services started!"
echo "🌐 Frontend: http://localhost:3000"
echo "🔗 Backend: http://localhost:9999"
echo ""
echo "Press Ctrl+C to stop all services"

# Wait for user to stop
wait
