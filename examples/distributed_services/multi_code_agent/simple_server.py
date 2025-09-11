import os
from typing import Dict

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

import traceroot
from rest.main import MultiAgentSystem
from traceroot.integrations.fastapi import connect_fastapi
from traceroot.logger import get_logger

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
    # Check for required environment variables
    if not os.getenv("OPENAI_API_KEY"):
        logger.error("Please set your OPENAI_API_KEY environment variable")
        logger.error(
            "You can create a .env file with: "
            "OPENAI_API_KEY=your_api_key_here"
        )
        exit(1)

    uvicorn.run(app, host="0.0.0.0", port=9999)
