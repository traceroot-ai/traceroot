# rest/simple_server.py  (or whatever your filename is)
import os
from typing import Dict

import uvicorn
from dotenv import find_dotenv, load_dotenv
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

import traceroot

# ----------------- load .env -----------------
dotenv_path = find_dotenv()
if dotenv_path:
    load_dotenv(dotenv_path)
else:
    print(
        "No .env file found (find_dotenv returned None).\n"
        "Using process environment variables."
    )

# --------------- read env variables -----------
service = os.getenv("TRACEROOT_SERVICE", "default-service")
environment = os.getenv("TRACEROOT_ENV", "default-env")
owner = os.getenv("GITHUB_OWNER", "default-owner")
repo = os.getenv("GITHUB_REPO_NAME", "default-repo")
commit = os.getenv("GITHUB_COMMIT_HASH", "default-commit")
token = os.getenv("TRACEROOT_API_KEY")

traceroot.init(
    service_name=service,
    environment=environment,
    github_owner=owner,
    github_repo_name=repo,
    github_commit_hash=commit,
    token=token,
    enable_span_cloud_export=True,
    enable_log_cloud_export=False,
)
from rest.main import MultiAgentSystem  # noqa: E402
from traceroot.integrations.fastapi import connect_fastapi  # noqa: E402
from traceroot.logger import get_logger  # noqa: E402

logger = get_logger()

app = FastAPI(title="TraceRoot Multi-Agent Code Server")
connect_fastapi(app)
system = MultiAgentSystem()


class CodeRequest(BaseModel):
    query: str


@app.post("/code")
@traceroot.trace()
async def code_endpoint(request: CodeRequest) -> Dict[str, str]:
    logger.info(f"Code endpoint called with query: {request.query}")
    try:
        result = system.process_query(request.query)
        logger.info("Query processing completed successfully")
        return {"status": "success", "response": result}
    except Exception as e:
        logger.error(f"Error processing query: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Query processing failed: {str(e)}")


if __name__ == "__main__":
    # OpenAI key check (if you require)
    if not os.getenv("OPENAI_API_KEY"):
        logger.error("Please set your OPENAI_API_KEY environment variable")
        logger.error("You can create a .env file with: OPENAI_API_KEY=your_api_key_here")
        exit(1)

    uvicorn.run(app, host="0.0.0.0", port=9999)
