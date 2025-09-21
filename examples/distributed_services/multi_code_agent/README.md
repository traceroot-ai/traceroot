# Multi-Agent Code Generator

A distributed multi-agent system that can plan, code, execute, and summarize coding tasks using LangGraph and TraceRoot.

## Quick Start

### 1. Setup (One-time)

```bash
./setup.sh
```

### 2. Configure Environment

Set your OpenAI API key:

```bash
export OPENAI_API_KEY=your_openai_api_key_here
```

and update TRACEROOT_TOKEN in .env with the your TraceRoot token in [here](https://test.traceroot.ai/integrate).

### 3. Start Everything

```bash
./start.sh
```

This will start both the backend (port 9999) and frontend (port 3000).

## Access the Application

- **Frontend UI**: http://localhost:3000
- **Backend API**: http://localhost:9999

## Test the API

```bash
curl -X POST "http://localhost:9999/code" \
     -H "Content-Type: application/json" \
     -d '{"query": "Write a Python function to calculate fibonacci numbers"}'
```

## Example Queries

Try these complex coding challenges:

- "Given an m x n matrix, return all elements of the matrix in spiral order, where m = 1000000000 and n = 1000000000"
