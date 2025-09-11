# Setup

```bash
python3.11 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
export OPENAI_API_KEY=your_api_key_here
```

# Run REST API

To run the server, run the following command:

```bash
cd ../../
python examples/multi_code_agent/simple_server.py
```

This will start a server on port 9999.

## Test by Sending a Request

```bash
curl -X POST "http://localhost:9999/code" \
        -H "Content-Type: application/json" \
        -d '{"query": "Write a Python function to calculate fibonacci numbers"}'
```

# Run UI

```bash
NEXT_OTEL_VERBOSE=0
cd ../../
cd examples/multi_code_agent/ui
npm install
npm run dev
```

## Test by a Query

Given an m x n matrix, return all elements of the matrix in spiral order, where m = 1000000000 and n = 1000000000.
