"""
CrewAI sequential multi-agent research workflow with TraceRoot observability.

Usage:
    cp .env.example .env  # fill in your API keys
    uv run --no-project --python 3.13 --with-requirements requirements.txt python main.py
"""

from __future__ import annotations

import json
import os
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from dotenv import load_dotenv

EXAMPLE_DIR = Path(__file__).resolve().parent
EXAMPLE_DOTENV = EXAMPLE_DIR / ".env"

if EXAMPLE_DOTENV.exists():
    load_dotenv(EXAMPLE_DOTENV, override=True)
else:
    print(f"No example .env found at {EXAMPLE_DOTENV}.\nUsing process environment variables.")

# Keep CrewAI's product telemetry disabled so TraceRoot is the only tracing
# path demonstrated by this example.
os.environ["CREWAI_TRACING_ENABLED"] = "false"
os.environ["CREWAI_DISABLE_TELEMETRY"] = "true"
os.environ["CREWAI_DISABLE_TRACKING"] = "true"

ProviderName = Literal[
    "openai",
    "anthropic",
    "google",
    "openai-compatible",
    "litellm",
]


@dataclass(frozen=True)
class ExampleConfig:
    model_provider: ProviderName
    model_name: str
    model_api_key: str | None
    model_api_key_source: str | None
    model_base_url: str | None

    @classmethod
    def from_env(cls) -> ExampleConfig:
        provider = os.getenv("MODEL_PROVIDER", "openai").strip().lower()
        allowed_providers = {
            "openai",
            "anthropic",
            "google",
            "openai-compatible",
            "litellm",
        }
        if provider not in allowed_providers:
            allowed = ", ".join(sorted(allowed_providers))
            raise ValueError(
                f"Unsupported MODEL_PROVIDER '{provider}'. Expected one of: {allowed}."
            )

        model_name = os.getenv("MODEL_NAME", "gpt-4o-mini").strip()
        if not model_name:
            raise ValueError("MODEL_NAME must be set to a non-empty value.")

        model_api_key, model_api_key_source = cls._resolve_api_key(provider)
        model_base_url = os.getenv("MODEL_BASE_URL") or None

        if provider in {"openai", "anthropic", "google"} and not model_api_key:
            raise ValueError(
                "No model API key found. Set MODEL_API_KEY or the provider fallback key in .env."
            )

        if (
            provider in {"openai-compatible", "litellm"}
            and not model_api_key
            and not model_base_url
        ):
            raise ValueError(
                "MODEL_PROVIDER requires either MODEL_API_KEY or MODEL_BASE_URL so CrewAI can "
                "reach the target endpoint."
            )

        return cls(
            model_provider=provider,
            model_name=model_name,
            model_api_key=model_api_key,
            model_api_key_source=model_api_key_source,
            model_base_url=model_base_url,
        )

    @staticmethod
    def _resolve_api_key(provider: str) -> tuple[str | None, str | None]:
        direct_key = os.getenv("MODEL_API_KEY")
        if direct_key:
            return direct_key, "MODEL_API_KEY"

        provider_key = ExampleConfig._fallback_api_key(provider)
        if provider_key:
            return provider_key

        return None, None

    @staticmethod
    def _fallback_api_key(provider: str) -> tuple[str | None, str | None]:
        if provider in {"openai", "openai-compatible"}:
            if os.getenv("OPENAI_API_KEY"):
                return os.getenv("OPENAI_API_KEY"), "OPENAI_API_KEY"
            return None, None
        if provider == "anthropic":
            if os.getenv("ANTHROPIC_API_KEY"):
                return os.getenv("ANTHROPIC_API_KEY"), "ANTHROPIC_API_KEY"
            return None, None
        if provider == "google":
            if os.getenv("GOOGLE_API_KEY"):
                return os.getenv("GOOGLE_API_KEY"), "GOOGLE_API_KEY"
            if os.getenv("GEMINI_API_KEY"):
                return os.getenv("GEMINI_API_KEY"), "GEMINI_API_KEY"
            return None, None
        if provider == "litellm":
            for env_var in (
                "OPENAI_API_KEY",
                "ANTHROPIC_API_KEY",
                "GOOGLE_API_KEY",
                "GEMINI_API_KEY",
            ):
                if os.getenv(env_var):
                    return os.getenv(env_var), env_var
            return None, None
        return None, None

    @property
    def llm_provider(self) -> str:
        if self.model_provider == "openai-compatible":
            return "openai"
        return self.model_provider

    @property
    def session_id(self) -> str:
        normalized = self.model_provider.replace("-", "_")
        return f"crewai_py_{normalized}_session"


CONFIG = ExampleConfig.from_env()

# isort: off
import traceroot

try:
    from traceroot import (
        Integration,
        observe,
        update_current_span,
        update_current_trace,
        using_attributes,
    )

    TRACEROOT_LEGACY_MODE = False

    def resolve_traceroot_integrations(config: ExampleConfig) -> list[Integration]:
        integrations: list[Integration] = []

        # Match the currently supported provider integrations in the published
        # TraceRoot SDK. Gemini and LiteLLM still rely on the manual spans
        # defined below.
        if config.model_provider in {"openai", "openai-compatible"}:
            integrations.append(Integration.OPENAI)
        elif config.model_provider == "anthropic":
            integrations.append(Integration.ANTHROPIC)

        return integrations

    traceroot.initialize(integrations=resolve_traceroot_integrations(CONFIG))
except ImportError:
    from opentelemetry import trace as otel_trace

    from traceroot import shutdown as traceroot_shutdown
    from traceroot import trace as traceroot_trace
    from traceroot.tracer import TraceOptions

    Integration = None
    TRACEROOT_LEGACY_MODE = True
    update_current_span = None
    update_current_trace = None

    def observe(name: str, type: str):
        del type
        return traceroot_trace(
            TraceOptions(
                span_name=name,
                trace_params=True,
                trace_return_value=True,
            )
        )

    @contextmanager
    def using_attributes(**_: Any):
        yield


from crewai import Agent, Crew, LLM, Process, Task
from crewai.tools import BaseTool
from pydantic import BaseModel, Field
# isort: on


def flush_traceroot() -> None:
    if TRACEROOT_LEGACY_MODE:
        traceroot_shutdown()
        return

    traceroot.flush()


def enrich_current_trace(
    *,
    metadata: dict[str, str],
    session_id: str,
    tags: list[str],
    topic: str | None = None,
    final_report: str | None = None,
) -> None:
    if update_current_trace is not None:
        update_current_trace(
            session_id=session_id,
            metadata=metadata,
            tags=tags,
        )

    span_payload: dict[str, Any] = {
        "metadata": metadata,
    }
    if topic is not None:
        span_payload["input"] = {"topic": topic}
        span_payload["model"] = metadata["model"]
        span_payload["model_parameters"] = {
            "framework": metadata["framework"],
            "process": metadata["process"],
            "provider": metadata["provider"],
        }
    if final_report is not None:
        span_payload["output"] = {"final_report": final_report}
    if update_current_span is not None:
        update_current_span(**span_payload)
        return

    if not TRACEROOT_LEGACY_MODE:
        return

    span = otel_trace.get_current_span()
    if span is None or not span.is_recording():
        return

    span.set_attribute("traceroot.session_id", session_id)
    span.set_attribute("traceroot.tags", ",".join(tags))
    for key, value in metadata.items():
        span.set_attribute(f"traceroot.{key}", value)
    if topic is not None:
        span.set_attribute("traceroot.input.topic", topic)
    if final_report is not None:
        span.set_attribute("traceroot.output.final_report", final_report)


class TopicInput(BaseModel):
    topic: str = Field(description="The workflow or product topic being analyzed.")


@observe(name="lookup_use_case_fit", type="tool")
def lookup_use_case_fit(topic: str) -> str:
    """Return a mocked benchmark for where a multi-agent workflow fits best."""
    payload = {
        "topic": topic,
        "best_fit": "Narrow, repeatable workflows with multiple review handoffs",
        "high_signal_inputs": [
            "stable source documents",
            "clear review criteria",
            "human escalation path",
        ],
        "good_first_use_case": "internal research, triage, or quality-review workflow",
        "avoid_first": "customer-facing automation with broad write permissions",
    }
    return json.dumps(payload, indent=2)


@observe(name="lookup_operating_constraints", type="tool")
def lookup_operating_constraints(topic: str) -> str:
    """Return mocked delivery and governance constraints for the topic."""
    payload = {
        "topic": topic,
        "required_controls": [
            "bounded tools",
            "auditable prompts",
            "clear rollback path",
            "human approval for external actions",
        ],
        "common_failure_modes": [
            "unclear task boundaries",
            "tool misuse",
            "over-delegation across agents",
            "weak evaluation criteria",
        ],
        "recommended_scope": "single team, single workflow, single owner for v1",
    }
    return json.dumps(payload, indent=2)


@observe(name="lookup_rollout_metrics", type="tool")
def lookup_rollout_metrics(topic: str) -> str:
    """Return mocked rollout guidance and KPI ideas for the topic."""
    payload = {
        "topic": topic,
        "leading_kpis": [
            "analyst time saved per run",
            "human correction rate",
            "handoff completion time",
            "percent of runs escalated to human review",
        ],
        "launch_gate": "ship only after sampled outputs consistently meet review criteria",
        "recommended_v1_target": "reduce manual triage time by 25% without increasing correction load",
    }
    return json.dumps(payload, indent=2)


class UseCaseFitTool(BaseTool):
    name: str = "lookup_use_case_fit"
    description: str = (
        "Fetch a mocked internal benchmark describing where multi-agent workflows fit best."
    )
    args_schema: type[BaseModel] = TopicInput

    def _run(self, topic: str) -> str:
        return lookup_use_case_fit(topic)


class OperatingConstraintsTool(BaseTool):
    name: str = "lookup_operating_constraints"
    description: str = "Fetch mocked delivery and governance constraints for a multi-agent rollout."
    args_schema: type[BaseModel] = TopicInput

    def _run(self, topic: str) -> str:
        return lookup_operating_constraints(topic)


class RolloutMetricsTool(BaseTool):
    name: str = "lookup_rollout_metrics"
    description: str = "Fetch mocked KPI and rollout guidance for a first multi-agent deployment."
    args_schema: type[BaseModel] = TopicInput

    def _run(self, topic: str) -> str:
        return lookup_rollout_metrics(topic)


def build_llm(config: ExampleConfig) -> LLM:
    llm_kwargs: dict[str, object] = {
        "model": config.model_name,
    }
    if config.model_api_key:
        llm_kwargs["api_key"] = config.model_api_key
    if config.model_base_url:
        llm_kwargs["base_url"] = config.model_base_url

    if config.model_provider == "litellm":
        llm_kwargs["is_litellm"] = True
    else:
        llm_kwargs["provider"] = config.llm_provider

    return LLM(**llm_kwargs)


def rewrite_runtime_error(error: Exception, config: ExampleConfig) -> Exception:
    error_text = str(error)
    lowered = error_text.lower()
    source = config.model_api_key_source or "unknown source"

    if config.model_provider in {"openai", "openai-compatible"} and (
        "invalid_api_key" in lowered
        or "incorrect api key provided" in lowered
        or "authenticationerror" in lowered
    ):
        return RuntimeError(
            "OpenAI-compatible authentication failed. The configured API key was rejected.\n\n"
            f"Configured source: `{source}`\n"
            f"Example env file: `{EXAMPLE_DOTENV}`\n\n"
            "Set a valid `MODEL_API_KEY` or `OPENAI_API_KEY`. If you are using a custom "
            "endpoint, also confirm `MODEL_BASE_URL` points at the provider's `/v1` API root."
        )

    if config.model_provider == "anthropic" and (
        "authentication_error" in lowered
        or "invalid x-api-key" in lowered
        or "invalid api key" in lowered
    ):
        return RuntimeError(
            "Anthropic authentication failed. The configured API key was rejected.\n\n"
            f"Configured source: `{source}`\n"
            f"Example env file: `{EXAMPLE_DOTENV}`\n\n"
            "Set a valid `MODEL_API_KEY` or `ANTHROPIC_API_KEY` and rerun."
        )

    if config.model_provider == "google" and (
        "api key expired" in lowered
        or "api_key_invalid" in lowered
        or "google gemini api error" in lowered
        or "api key not valid" in lowered
    ):
        message = (
            "Gemini authentication failed. Google rejected the configured API key.\n\n"
            f"Configured source: `{source}`\n"
            f"Example env file: `{EXAMPLE_DOTENV}`\n\n"
            "This example now prefers the local example `.env` and supports both "
            "`GOOGLE_API_KEY` and `GEMINI_API_KEY`, but it still cannot run with an "
            "expired or invalid Google key. Set a fresh key in `MODEL_API_KEY`, "
            "`GOOGLE_API_KEY`, or `GEMINI_API_KEY` and rerun."
        )
        return RuntimeError(message)

    return error


def build_tools() -> list[BaseTool]:
    return [
        UseCaseFitTool(),
        OperatingConstraintsTool(),
        RolloutMetricsTool(),
    ]


@observe(name="prepare_internal_dossier", type="span")
def prepare_internal_dossier(topic: str, tools: list[BaseTool]) -> str:
    """Preload deterministic internal notes from the mocked tools."""
    sections = []
    for tool in tools:
        sections.append(f"## {tool.name}\n{tool.run(topic=topic)}")
    return "\n\n".join(sections)


def build_crew(config: ExampleConfig, tools: list[BaseTool]) -> Crew:
    llm = build_llm(config)

    researcher = Agent(
        role="Research Lead",
        goal="Turn the available internal signals into a grounded recommendation.",
        backstory=(
            "You are a pragmatic product researcher. You prefer concrete operating constraints "
            "over hype and only use the provided internal context or attached tools."
        ),
        llm=llm,
        tools=tools,
        verbose=False,
    )

    reviewer = Agent(
        role="Risk Reviewer",
        goal="Stress-test the recommendation for missing assumptions and rollout risk.",
        backstory=(
            "You are a skeptical staff engineer who reviews agent workflows for operational "
            "clarity, safety, and evaluation gaps."
        ),
        llm=llm,
        verbose=False,
    )

    writer = Agent(
        role="Recommendation Writer",
        goal="Produce a crisp implementation memo a product team could actually use.",
        backstory=(
            "You write concise delivery memos for cross-functional teams and prefer clear "
            "tradeoffs, scoped v1 plans, and measurable outcomes."
        ),
        llm=llm,
        verbose=False,
    )

    research_task = Task(
        description=(
            "You are evaluating this topic: {topic}.\n\n"
            "Start from the internal dossier below. If you need to double-check a detail, "
            "you may call the attached tools.\n\n"
            "{internal_dossier}\n\n"
            "Produce a research brief with 5-7 bullets covering:\n"
            "- strongest use-case fit\n"
            "- expected business value\n"
            "- major rollout constraints\n"
            "- primary reasons this could fail\n"
            "Only use the provided internal context."
        ),
        expected_output=(
            "A concise evidence brief with 5-7 bullets that references the internal signals."
        ),
        agent=researcher,
    )

    review_task = Task(
        description=(
            "Review the research brief for weak assumptions, missing controls, and unclear "
            "success criteria. Produce a short critique with what should change before launch."
        ),
        expected_output=(
            "A critique with sections for strengths, gaps, risks, and what the final memo "
            "must clarify."
        ),
        agent=reviewer,
        context=[research_task],
    )

    writing_task = Task(
        description=(
            "Write the final recommendation memo for {topic}. Use the research brief and the "
            "review critique. Make the decision practical, scoped, and measurable."
        ),
        expected_output=(
            "A markdown memo with sections: Recommendation, Why This Fits, Risks to Manage, "
            "and Suggested V1 KPI."
        ),
        agent=writer,
        context=[research_task, review_task],
        markdown=True,
    )

    return Crew(
        agents=[researcher, reviewer, writer],
        tasks=[research_task, review_task, writing_task],
        process=Process.sequential,
        verbose=False,
    )


@observe(name="run_research_session", type="agent")
def run_research_session(topic: str, config: ExampleConfig) -> str:
    metadata = {
        "framework": "crewai",
        "process": "sequential",
        "provider": config.model_provider,
        "model": config.model_name,
    }
    tags = ["example", "python", "crewai", config.model_provider]

    enrich_current_trace(
        metadata=metadata,
        session_id=config.session_id,
        tags=tags,
        topic=topic,
    )

    tools = build_tools()
    internal_dossier = prepare_internal_dossier(topic, tools)
    crew = build_crew(config, tools)
    try:
        output = crew.kickoff(inputs={"topic": topic, "internal_dossier": internal_dossier})
    except Exception as exc:
        raise rewrite_runtime_error(exc, config) from exc
    final_report = str(output).strip()

    enrich_current_trace(
        metadata=metadata,
        session_id=config.session_id,
        tags=tags,
        final_report=final_report,
    )

    return final_report


DEMO_TOPIC = "AI support triage workflow for a mid-market B2B SaaS team"


if __name__ == "__main__":
    print(f"Topic: {DEMO_TOPIC}\n")
    try:
        with using_attributes(
            user_id="example-user",
            session_id=CONFIG.session_id,
            tags=["example", "python", "crewai", CONFIG.model_provider],
            metadata={
                "framework": "crewai",
                "process": "sequential",
                "provider": CONFIG.model_provider,
                "model": CONFIG.model_name,
            },
        ):
            report = run_research_session(DEMO_TOPIC, CONFIG)

        print(report)
    finally:
        flush_traceroot()
