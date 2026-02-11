"""Tests for auto-instrumentation registry and initialization."""

from unittest.mock import MagicMock, patch

import pytest
from opentelemetry.sdk.trace import TracerProvider

import traceroot
from tests.utils import reset_traceroot
from traceroot.instrumentation.registry import (
    Integration,
    _is_package_installed,
    initialize_integrations,
)

# =============================================================================
# Integration enum
# =============================================================================


def test_integration_enum_values():
    assert Integration.OPENAI == "openai"
    assert Integration.ANTHROPIC == "anthropic"
    assert Integration.LANGCHAIN == "langchain"


def test_integration_exported_from_traceroot():
    assert traceroot.Integration is Integration


# =============================================================================
# _is_package_installed
# =============================================================================


def test_is_package_installed_for_installed_package():
    assert _is_package_installed("opentelemetry-api") is True


def test_is_package_installed_for_missing_package():
    assert _is_package_installed("nonexistent-package-xyz-12345") is False


# =============================================================================
# initialize_integrations
# =============================================================================


def test_empty_integrations_returns_empty():
    provider = TracerProvider()
    result = initialize_integrations(tracer_provider=provider, integrations=[])
    assert result == []


@patch("traceroot.instrumentation.registry._is_package_installed")
def test_raises_if_library_not_installed(mock_installed):
    mock_installed.return_value = False

    provider = TracerProvider()
    with pytest.raises(ImportError, match="Cannot instrument openai"):
        initialize_integrations(
            tracer_provider=provider,
            integrations=[Integration.OPENAI],
        )


@patch("traceroot.instrumentation.registry._is_package_installed")
def test_integrations_with_enum_values(mock_installed):
    mock_installed.return_value = True
    mock_instrumentor = MagicMock()
    mock_cls = MagicMock(return_value=mock_instrumentor)
    mock_module = MagicMock()
    mock_module.OpenAIInstrumentor = mock_cls

    provider = TracerProvider()

    with patch("importlib.import_module", return_value=mock_module):
        result = initialize_integrations(
            tracer_provider=provider,
            integrations=[Integration.OPENAI],
        )

    assert result == [Integration.OPENAI]
    mock_instrumentor.instrument.assert_called_once_with(tracer_provider=provider)


@patch("traceroot.instrumentation.registry._is_package_installed")
def test_integrations_multiple_enums(mock_installed):
    mock_installed.return_value = True
    mock_instrumentor = MagicMock()
    mock_cls = MagicMock(return_value=mock_instrumentor)
    mock_module = MagicMock()
    mock_module.OpenAIInstrumentor = mock_cls
    mock_module.AnthropicInstrumentor = mock_cls

    provider = TracerProvider()

    with patch("importlib.import_module", return_value=mock_module):
        result = initialize_integrations(
            tracer_provider=provider,
            integrations=[Integration.OPENAI, Integration.ANTHROPIC],
        )

    assert Integration.OPENAI in result
    assert Integration.ANTHROPIC in result


@patch("traceroot.instrumentation.registry._is_package_installed")
def test_failed_instrumentation_continues(mock_installed):
    """If one instrumentor fails, others still get instrumented."""
    mock_installed.return_value = True

    provider = TracerProvider()

    with patch("importlib.import_module", side_effect=ImportError("no module")):
        result = initialize_integrations(
            tracer_provider=provider,
            integrations=[Integration.OPENAI],
        )

    # Failed but didn't raise — just not in results
    assert result == []


# =============================================================================
# TracerootClient integration
# =============================================================================


@patch("traceroot.instrumentation.registry.initialize_integrations")
@patch("opentelemetry.trace.set_tracer_provider")
def test_client_calls_initialize_integrations(mock_set_provider, mock_init):
    mock_init.return_value = []
    reset_traceroot()

    traceroot.initialize(
        api_key="test-key",
        integrations=[Integration.OPENAI, Integration.LANGCHAIN],
    )

    mock_init.assert_called_once()
    _, kwargs = mock_init.call_args
    assert kwargs["integrations"] == [Integration.OPENAI, Integration.LANGCHAIN]


@patch("opentelemetry.trace.set_tracer_provider")
def test_client_skips_instrumentation_when_not_requested(mock_set_provider):
    reset_traceroot()

    with patch("traceroot.instrumentation.registry.initialize_integrations") as mock_init:
        traceroot.initialize(api_key="test-key")
        mock_init.assert_not_called()


def test_client_skips_instrumentation_when_disabled():
    reset_traceroot()

    with patch("traceroot.instrumentation.registry.initialize_integrations") as mock_init:
        traceroot.initialize(enabled=False, integrations=[Integration.OPENAI])
        mock_init.assert_not_called()
