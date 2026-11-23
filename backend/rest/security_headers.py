"""Security headers on every REST API response.

The load balancer serves this API and the web app from one host, so browsers
reach /api/v1 directly and its responses need the headers the web app sends
from frontend/ui/next.config.js: no MIME sniffing of a JSON body, HTTPS for the
host from then on, and no copy of a response kept by the browser or a proxy.
"""

from collections.abc import Awaitable, Callable, MutableMapping
from typing import Any

from starlette.datastructures import MutableHeaders

#: The values next.config.js sends. Browsers ignore HSTS on plain-HTTP responses,
#: so local and HTTP-only self-hosted setups are unaffected, and it leaves out
#: includeSubDomains so a self-hosted deployment never pins the operator's other
#: subdomains to HTTPS.
SECURITY_HEADERS = {
    "Strict-Transport-Security": "max-age=63072000",
    "X-Content-Type-Options": "nosniff",
    # API responses carry customer trace data. A route that wants caching, such
    # as /live with its no-cache event stream, sets its own value and keeps it.
    "Cache-Control": "private, no-cache, no-store, max-age=0, must-revalidate",
}


class SecurityHeadersMiddleware:
    """Add SECURITY_HEADERS to every HTTP response that does not already set them.

    Written as raw ASGI, like SqlBodyLimitMiddleware, so it only touches the
    response start and streamed responses such as /live pass through as they are.
    """

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(
        self,
        scope: MutableMapping[str, Any],
        receive: Callable[[], Awaitable[MutableMapping[str, Any]]],
        send: Callable[[MutableMapping[str, Any]], Awaitable[None]],
    ) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message: MutableMapping[str, Any]) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                for name, value in SECURITY_HEADERS.items():
                    headers.setdefault(name, value)
            await send(message)

        await self.app(scope, receive, send_with_headers)
