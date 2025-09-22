# setup.sh
#!/bin/bash
set -e

echo "🚀 Setting up Multi-Agent Code Generator..."

# Check prerequisites
command -v python3 >/dev/null 2>&1 || { echo "❌ Python3 required but not installed."; exit 1; }
command -v node >/dev/null 2>&1 || { echo "❌ Node.js required but not installed."; exit 1; }

# Setup Python environment
echo "📦 Setting up Python environment..."
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Setup environment variables
echo "🔧 Setting up environment..."
cp .env.example .env

# Setup UI
echo "🎨 Setting up UI..."
cd ui
npm install
cd ..

echo "✅ Setup complete!"
echo "💡 Next steps:"
echo "   1. Export OPENAI_API_KEY with your OpenAI API key"
echo "   2. Update .env file with your TraceRoot token"
echo "   3. Update traceroot.config.ts with your TraceRoot token"
echo "   4. Run: ./start.sh"
