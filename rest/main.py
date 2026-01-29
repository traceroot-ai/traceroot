"""FastAPI REST API server for Traceroot."""

import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from db.postgres import close_db, init_db
from rest.routers.api_keys import router as api_keys_router
from rest.routers.organizations import router as organizations_router
from rest.routers.projects import router as projects_router
from rest.routers.public.traces import router as public_traces_router
from rest.routers.traces import router as traces_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan events."""
    # Startup
    await init_db()
    yield
    # Shutdown
    await close_db()


app = FastAPI(
    title="Traceroot API",
    description="Observability platform for LLM applications",
    version="0.1.0",
    lifespan=lifespan,
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

# Include API routers
app.include_router(organizations_router, prefix="/api/v1")
app.include_router(projects_router, prefix="/api/v1")
app.include_router(api_keys_router, prefix="/api/v1")
app.include_router(traces_router, prefix="/api/v1")

# Public API for SDK ingestion (API key auth, not user auth)
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
