# Setup

```bash
python3.11 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
export OPENAI_API_KEY=your_api_key_here
```

# Environment Setup

```bash
# Open the .env file and update it with your actual Traceroot token and details
cp .env.example .env
```

# Run REST API

To run the server, run the following command:

```bash
python simple_server.py
```

This will start a server on port 9999.

## Test by Sending a Request

```bash
curl -X POST "http://localhost:9999/code" \
        -H "Content-Type: application/json" \
        -d '{"query": "Write a Python function to calculate fibonacci numbers"}'
```

# Run UI

Check [here](https://github.com/traceroot-ai/traceroot/tree/main/examples/distributed_services/multi_code_agent/ui).

## Test by a Query

Given an m x n matrix, return all elements of the matrix in spiral order, where m = 1000000000 and n = 1000000000.
