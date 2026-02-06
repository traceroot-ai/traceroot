"""FastAPI REST API server for Traceroot.

This server handles:
- OTEL trace ingestion (public API with API key auth)
- Trace reading from ClickHouse
"""

import os

from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from rest.routers.public.traces import router as public_traces_router
from rest.routers.traces import router as traces_router
from rest.routers.users import router as users_router


app = FastAPI(
    title="Traceroot API",
    description="Observability platform for LLM applications",
    version="0.1.0",
)

# CORS configuration
cors_origins = os.getenv("CORS_ORIGINS", "http://localhost:3000").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Trace reading from ClickHouse (user auth via headers from Next.js)
app.include_router(traces_router, prefix="/api/v1")
app.include_router(users_router, prefix="/api/v1")

# Public API for SDK ingestion (API key auth)
app.include_router(public_traces_router, prefix="/api/v1")


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "ok"}


if __name__ == "__main__":
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8000"))
    debug = os.getenv("DEBUG", "false").lower() == "true"

    uvicorn.run(
        "rest.main:app",
        host=host,
        port=port,
        reload=debug,
    )
