"""
CrewAI sequential multi-agent research workflow with TraceRoot observability.

Usage:
    cp .env.example .env  # fill in your API keys
    uv run --no-project --python 3.13 --with-requirements requirements.txt python main.py
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

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


@dataclass(frozen=True)
class ExampleConfig:
    model_name: str
    model_api_key: str
    model_api_key_source: str

    @classmethod
    def from_env(cls) -> ExampleConfig:
        model_name = os.getenv("MODEL_NAME", "gpt-4o-mini").strip()
        if not model_name:
            raise ValueError("MODEL_NAME must be set to a non-empty value.")
        if model_name.lower().startswith("gemini"):
            raise ValueError(
                "This CrewAI example is now OpenAI-only. Update MODEL_NAME in `.env` to "
                "an OpenAI model such as `gpt-4o-mini`."
            )

        model_api_key, model_api_key_source = cls._resolve_api_key()
        if not model_api_key or not model_api_key_source:
            raise ValueError(
                "No OpenAI API key found. Set MODEL_API_KEY or OPENAI_API_KEY in .env."
            )

        return cls(
            model_name=model_name,
            model_api_key=model_api_key,
            model_api_key_source=model_api_key_source,
        )

    @staticmethod
    def _resolve_api_key() -> tuple[str | None, str | None]:
        direct_key = os.getenv("MODEL_API_KEY")
        if direct_key:
            return direct_key, "MODEL_API_KEY"

        return ExampleConfig._fallback_api_key()

    @staticmethod
    def _fallback_api_key() -> tuple[str | None, str | None]:
        if os.getenv("OPENAI_API_KEY"):
            return os.getenv("OPENAI_API_KEY"), "OPENAI_API_KEY"
        return None, None

    @property
    def session_id(self) -> str:
        return "crewai_py_openai_session"


CONFIG = ExampleConfig.from_env()

# isort: off
from traceroot import shutdown as traceroot_shutdown
from traceroot import trace as traceroot_trace
from traceroot.tracer import TraceOptions, write_attributes_to_current_span
from crewai import Agent, Crew, LLM, Process, Task
from crewai.tools import BaseTool
from pydantic import BaseModel, Field
# isort: on


def observe(name: str, type: str):
    del type
    return traceroot_trace(
        TraceOptions(
            span_name=name,
            trace_params=True,
            trace_return_value=True,
        )
    )


def write_run_attributes(
    *,
    metadata: dict[str, str],
    session_id: str,
    tags: list[str],
    topic: str | None = None,
    final_report: str | None = None,
) -> None:
    attributes = {
        "traceroot.session_id": session_id,
        "traceroot.tags": ",".join(tags),
        "traceroot.user_id": "example-user",
    }
    for key, value in metadata.items():
        attributes[f"traceroot.{key}"] = value
    if topic is not None:
        attributes["traceroot.input.topic"] = topic
    if final_report is not None:
        attributes["traceroot.output.final_report"] = final_report
    write_attributes_to_current_span(attributes)


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
    return LLM(
        model=config.model_name,
        api_key=config.model_api_key,
        provider="openai",
    )


def rewrite_runtime_error(error: Exception, config: ExampleConfig) -> Exception:
    error_text = str(error)
    lowered = error_text.lower()
    source = config.model_api_key_source or "unknown source"

    if "rate limit" in lowered or "429" in lowered or "too many requests" in lowered:
        return RuntimeError(
            "OpenAI is temporarily rate limiting this request.\n\n"
            f"Configured source: `{source}`\n"
            f"Example env file: `{EXAMPLE_DOTENV}`\n\n"
            "Retry the example in a few minutes. If this persists, try a smaller model such "
            "as `gpt-4o-mini` or lower the request frequency."
        )

    if (
        "incorrect api key" in lowered
        or "invalid_api_key" in lowered
        or "401" in lowered
        or "authentication" in lowered
        or "api_key_invalid" in lowered
    ):
        message = (
            "OpenAI authentication failed. OpenAI rejected the configured API key.\n\n"
            f"Configured source: `{source}`\n"
            f"Example env file: `{EXAMPLE_DOTENV}`\n\n"
            "This example prefers the local example `.env`, but it still cannot run with an "
            "invalid OpenAI key. Set a fresh key in `MODEL_API_KEY` or `OPENAI_API_KEY` "
            "and rerun."
        )
        return RuntimeError(message)

    if "model_not_found" in lowered or "does not exist" in lowered:
        return RuntimeError(
            "OpenAI rejected the configured model name.\n\n"
            f"Example env file: `{EXAMPLE_DOTENV}`\n\n"
            "Set `MODEL_NAME` to a valid OpenAI model such as `gpt-4o-mini` and rerun."
        )

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
        "provider": "openai",
        "model": config.model_name,
    }
    tags = ["example", "python", "crewai", "openai"]

    write_run_attributes(
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

    write_run_attributes(
        metadata=metadata,
        session_id=config.session_id,
        tags=tags,
        final_report=final_report,
    )

    return final_report


DEMO_TOPIC = "AI support triage workflow for a mid-market B2B SaaS team"


if __name__ == "__main__":
    print(f"Topic: {DEMO_TOPIC}\n")
    report = run_research_session(DEMO_TOPIC, CONFIG)
    print(report)
    traceroot_shutdown()
