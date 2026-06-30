"""Agent Skill demo with TraceRoot observability.

Exercises the claude-agent-sdk **Skill** path — the one production agents hit
when they load an agent Skill (a `SKILL.md` of instructions the model pulls into
context on demand) and then carry out multi-step work from it. In a trace this
shows up as a `Skill` tool span followed by the LLM turns / tool calls the skill
drives.

This is self-contained: it scaffolds a tiny local skill on disk in a temp dir and
points the SDK at it via `skills=[...]` + `setting_sources=["project"]`, so it runs
with just an Anthropic key — no preinstalled skills required. We pin
`setting_sources=["project"]` (rather than the SDK default of
`["user", "project"]`) so ONLY this scaffolded skill is discovered, never whatever
skills happen to live in the caller's `~/.claude`.

Driven through the persistent `ClaudeSDKClient` (see client.py), the API real
agents use.

Usage:
    cp .env.example .env
    uv run --no-project --python 3.13 --with-requirements requirements.txt python skill.py
"""

import asyncio
import logging
import tempfile
from pathlib import Path

from dotenv import find_dotenv, load_dotenv

dotenv_path = find_dotenv()
if dotenv_path:
    load_dotenv(dotenv_path)
else:
    print("No .env file found. Using process environment variables.")

import traceroot
from traceroot import Integration, observe, using_attributes

traceroot.initialize(integrations=[Integration.CLAUDE_AGENT_SDK])

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient

# --- A tiny on-disk skill the agent can load -------------------------------
# A Skill is a SKILL.md with YAML frontmatter (name + description, which the
# model sees when deciding whether to invoke it) and a body of instructions
# (loaded into context once the Skill tool fires). This one tells the agent to
# do a short multi-step calculation via Bash, so the trace shows the Skill span
# followed by the LLM turns and the Bash tool call it drives.
SKILL_NAME = "data-cruncher"
SKILL_MD = """\
---
name: data-cruncher
description: Use when asked to crunch a list of numbers — computes summary statistics (mean, max, standard deviation) with python.
---

# Data Cruncher

When this skill is invoked, do the following, briefly:

1. Use the Bash tool to run `python3 -c` computing the mean, max, and population
   standard deviation of the numbers the user gave.
2. Report the three values in a single short line.
"""


def _scaffold_skill(root: Path) -> None:
    """Write `<root>/.claude/skills/<name>/SKILL.md` for project-source discovery."""
    skill_dir = root / ".claude" / "skills" / SKILL_NAME
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(SKILL_MD)


PROMPT = (
    "Use the data-cruncher skill to crunch these numbers: 12, 47, 8, 23, 56. "
    "Report the mean, max, and standard deviation."
)


@observe(name="skill_pipeline", type="agent")
async def run_session(workdir: str) -> str:
    final = ""
    options = ClaudeAgentOptions(
        model="sonnet",
        cwd=workdir,
        # The single switch that turns skills on; the SDK injects Skill(data-cruncher)
        # into allowed_tools for us. Bash is what the skill itself needs.
        skills=[SKILL_NAME],
        allowed_tools=["Bash"],
        # Discover ONLY this project's scaffolded skill (not the caller's ~/.claude).
        setting_sources=["project"],
        max_turns=8,
        permission_mode="bypassPermissions",
    )
    async with ClaudeSDKClient(options=options) as client:
        await client.query(PROMPT)
        async for message in client.receive_response():
            if hasattr(message, "result"):
                final = message.result
    return final


@observe(name="demo_session", type="agent")
async def run_demo():
    print("=" * 60)
    print("ClaudeSDKClient + Agent Skill — Demo (TraceRoot)")
    print("=" * 60)
    with tempfile.TemporaryDirectory(prefix="traceroot-skill-") as workdir:
        _scaffold_skill(Path(workdir))
        result = await run_session(workdir)
    if result:
        print(f"\n{result}")


if __name__ == "__main__":
    with using_attributes(user_id="example-user", session_id="claude-agent-sdk-skill-session"):
        try:
            asyncio.run(run_demo())
        finally:
            traceroot.flush()
