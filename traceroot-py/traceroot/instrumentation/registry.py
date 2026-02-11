"""Instrumentor registry and initialization logic."""

from __future__ import annotations

import importlib
import importlib.metadata
import logging
from collections.abc import Sequence
from enum import StrEnum
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from opentelemetry.sdk.trace import TracerProvider

logger = logging.getLogger(__name__)


class Integration(StrEnum):
    """Supported auto-instrumentation targets."""

    OPENAI = "openai"
    ANTHROPIC = "anthropic"
    LANGCHAIN = "langchain"


# Maps Integration enum -> (library to detect, instrumentor module path, instrumentor class name)
_BUILTIN_REGISTRY: dict[Integration, tuple[str, str, str]] = {
    Integration.OPENAI: (
        "openai",
        "openinference.instrumentation.openai",
        "OpenAIInstrumentor",
    ),
    Integration.ANTHROPIC: (
        "anthropic",
        "openinference.instrumentation.anthropic",
        "AnthropicInstrumentor",
    ),
    Integration.LANGCHAIN: (
        "langchain",
        "openinference.instrumentation.langchain",
        "LangChainInstrumentor",
    ),
}


def _is_package_installed(package_name: str) -> bool:
    """Check if a Python package is installed."""
    try:
        importlib.metadata.version(package_name)
        return True
    except importlib.metadata.PackageNotFoundError:
        return False


def initialize_integrations(
    tracer_provider: TracerProvider,
    integrations: Sequence[Integration],
) -> list[Integration]:
    """Initialize instrumentation for the specified libraries.

    Args:
        tracer_provider: The OTel TracerProvider to pass to instrumentors.
        integrations: List of Integration enum values to instrument.

    Returns:
        List of Integration values that were successfully instrumented.

    Raises:
        ImportError: If a requested library is not installed.
    """
    instrumented: list[Integration] = []

    for instrument in integrations:
        library, module_path, class_name = _BUILTIN_REGISTRY[instrument]

        if not _is_package_installed(library):
            raise ImportError(
                f"Cannot instrument {instrument.value}: "
                f"package '{library}' is not installed. "
                f"Install it with: pip install {library}"
            )

        try:
            module = importlib.import_module(module_path)
            instrumentor_cls = getattr(module, class_name)
            instrumentor = instrumentor_cls()
            instrumentor.instrument(tracer_provider=tracer_provider)
            logger.info("Instrumented %s via %s.%s", library, module_path, class_name)
            instrumented.append(instrument)
        except Exception:
            logger.warning("Failed to instrument %s", library, exc_info=True)

    return instrumented
