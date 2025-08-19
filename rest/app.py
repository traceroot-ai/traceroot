import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

try:
    from rest.client.ee.aws_client import TraceRootAWSClient
except ImportError:
    from rest.client.aws_client import TraceRootAWSClient

from rest.client.jaeger_client import TraceRootJaegerClient
from rest.routers.auth import router as auth_router
from rest.routers.explore import ExploreRouter
from rest.routers.integrate import IntegrateRouter

try:
    from rest.routers.ee.verify import VerifyRouter
except ImportError:
    from rest.routers.verify import VerifyRouter


class App:
    r"""The TraceRoot API app."""

    def __init__(self):
        # Initialize rate limiter
        self.limiter = Limiter(key_func=get_remote_address)

        self.app = FastAPI(title="TraceRoot API", version="1.0.0")

        # Add rate limit exception handler
        self.app.state.limiter = self.limiter
        self.app.add_exception_handler(
            RateLimitExceeded,
            _rate_limit_exceeded_handler,
        )
        self.local_mode = os.getenv("TRACE_ROOT_LOCAL_MODE", "false").lower() == "true"

        # Add CORS middleware
        self.add_middleware()

        if self.local_mode:
            client = TraceRootJaegerClient()
        else:
            client = TraceRootAWSClient()

        self.explore_router = ExploreRouter(client, self.limiter)
        self.app.include_router(
            self.explore_router.router,
            prefix="/v1/explore",
            tags=["explore"],
        )

        # Add connect router
        self.integrate_router = IntegrateRouter(self.limiter)
        self.app.include_router(
            self.integrate_router.router,
            prefix="/v1/integrate",
            tags=["integrate"],
        )

        # Add verify router for SDK verification
        self.verify_router = VerifyRouter(self.limiter)
        self.app.include_router(
            self.verify_router.router,
            prefix="/v1/verify",
            tags=["verify"],
        )

        # Add auth router
        self.app.include_router(
            auth_router,
            prefix="/v1/auth",
            tags=["auth"],
        )

    def add_middleware(self):
        allow_origins = [
            "https://test.traceroot.ai",  # MVP
            "https://api.test.traceroot.ai",  # API subdomain
            "http://localhost:3000",
            "http://localhost:3001",
            # Add explicit protocol+port combinations
            "http://127.0.0.1:3000",
            "http://127.0.0.1:3001",
        ]
        self.app.add_middleware(
            CORSMiddleware,
            allow_origins=allow_origins,
            allow_credentials=True,
            allow_methods=["GET",
                           "POST",
                           "PUT",
                           "DELETE",
                           "OPTIONS",
                           "PATCH"],
            allow_headers=["*"],
        )
