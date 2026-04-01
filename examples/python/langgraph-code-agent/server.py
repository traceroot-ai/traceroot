"""
Multi-agent code generator with TraceRoot observability.

Usage:
    cp env.example .env
    pip install -r requirements.txt
    python server.py

    curl -X POST http://localhost:9999/code \
        -H "Content-Type: application/json" \
        -d '{"query": "Write a two sum solution"}'
"""

import logging

from dotenv import find_dotenv, load_dotenv

dotenv_path = find_dotenv()
if dotenv_path:
    load_dotenv(dotenv_path)
else:
    print("No .env file found (find_dotenv returned None).\nUsing process environment variables.")

# Initialize TraceRoot BEFORE importing LangChain so instrumentation hooks in
import traceroot
from traceroot import Integration, observe, using_attributes

traceroot.initialize(integrations=[Integration.LANGCHAIN])

import uvicorn
from agent import process_query
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="LangGraph Code Agent")

DEFAULT_QUERY = (
    "Given an array of integers nums and an integer target, return indices of "
    "the two numbers such that they add up to target. nums = [2,7,11,15], target = 9."
)


class CodeRequest(BaseModel):
    query: str = DEFAULT_QUERY


@app.post("/code")
@observe(type="span")
async def code_endpoint(request: CodeRequest) -> dict[str, str]:
    try:
        with using_attributes(
            user_id="example-user",
            session_id="code-agent-session",
        ):
            result = process_query(request.query)
        return {"status": "success", "response": result}
    except Exception as e:
        logger.error(f"Error: {e}")
        raise HTTPException(status_code=500, detail=str(e)) from e


if __name__ == "__main__":
    PORT = 9999
    print(f"Server running on http://localhost:{PORT}")
    print(
        f"Try: curl -X POST http://localhost:{PORT}/code "
        f'-H "Content-Type: application/json" '
        f'-d \'{{"query": "2 sum in python"}}\''
    )
    uvicorn.run(app, host="0.0.0.0", port=PORT)
