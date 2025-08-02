import json
from typing import Union

from anthropic import AsyncAnthropic
from openai import AsyncOpenAI
from pydantic import BaseModel, Field

from rest.agent.utils.openai_tools import get_openai_tool_schema

GITHUB_PROMPT = (
    "You are a helpful assistant that can summarize whether "
    "the user question is related to:\n"
    "1. Creating an issue.\n"
    "2. Creating a PR.\n"
    "3. Source code related.\n"
    "Please follow following rules:\n"
    "1. If it's PR related, please set is_github_pr to True also "
    "set source_code_related to True.\n"
    "2. If it's issue related, please set is_github_issue to True also "
    "set source_code_related to True.\n"
    "3. If both of the above are True, please set is_github_issue and "
    "is_github_pr to True and source_code_related to True.\n"
    "4. If it's just source code related, please just set "
    "source_code_related to True.\n"
    "5. If it's not related to any of the above, please set "
    "is_github_issue and is_github_pr to False and source_code_related "
    "to False.\n"
    "Please only return True or False for one field ONLY IF "
    "you are very sure about the answer. Otherwise, please return False "
    "for all fields.")

SEPARATE_ISSUE_AND_PR_PROMPT = (
    "You are a helpful assistant that can separate the issue and PR from "
    "the user message. Please follow following rules:\n"
    "1. Put and maybe reformulate the user message into a message for "
    "creating an issue and a message for creating a PR.\n"
    "2. Please make sure the issue message and PR message are concise and "
    "to the point.\n"
    "3. Please make sure the issue message and PR message are related to "
    "the user message and don't lose any information.")


class GithubRelatedOutput(BaseModel):
    r"""Github related output.
    """
    is_github_issue: bool = Field(
        description=("Whether the user question is related to "
                     "creating an issue."))
    is_github_pr: bool = Field(
        description=("Whether the user question is related to "
                     "creating a PR."))

    source_code_related: bool = Field(
        description=("Whether the user question is related to "
                     "source code."))


class SeparateIssueAndPrInput(BaseModel):
    r"""Separate issue and PR input.
    """
    issue_message: str = Field(
        description=("The message for creating a GitHub issue. "
                     "Please explicitly mention that want to create "
                     "an GitHub issue."))
    pr_message: str = Field(
        description=("The message for creating a GitHub PR. "
                     "Please explicitly mention that want to create "
                     "a GitHub PR."))


async def is_github_related(
    user_message: str,
    client: Union[AsyncOpenAI, AsyncAnthropic],
    openai_token: str | None = None,
    anthropic_token: str | None = None,
    model: str = "gpt-4.1-mini",
) -> GithubRelatedOutput:
    is_anthropic_model = "claude" in model

    if is_anthropic_model:
        if anthropic_token:
            client = AsyncAnthropic(api_key=anthropic_token)
        if not isinstance(client, AsyncAnthropic):
            raise TypeError(
                "An AsyncAnthropic client is required for Claude models.")

        response = await client.messages.create(
            model=model,
            system=GITHUB_PROMPT,
            messages=[{
                "role": "user",
                "content": user_message
            }],
            max_tokens=1024,
            temperature=0.3,
            tools=[{
                "name": "classify_github_intent",
                "description":
                "Classifies intent for GitHub issues, PRs, or source code.",
                "input_schema": GithubRelatedOutput.model_json_schema()
            }],
            tool_choice={
                "type": "tool",
                "name": "classify_github_intent"
            })
        tool_call = next(
            (block for block in response.content if block.type == "tool_use"),
            None)
        if not tool_call:
            return GithubRelatedOutput(is_github_issue=False,
                                       is_github_pr=False,
                                       source_code_related=False)
        return GithubRelatedOutput(**tool_call.input)

    else:
        if openai_token:
            client = AsyncOpenAI(api_key=openai_token)
        if not isinstance(client, AsyncOpenAI):
            raise TypeError(
                "An AsyncOpenAI client is required for OpenAI models.")

        kwargs = {
            "model":
            model,
            "messages": [
                {
                    "role": "system",
                    "content": GITHUB_PROMPT
                },
                {
                    "role": "user",
                    "content": user_message
                },
            ],
            "tools": [get_openai_tool_schema(GithubRelatedOutput)],
            "tool_choice": {
                "type": "function",
                "function": {
                    "name": "GithubRelatedOutput"
                }
            }
        }
        if 'gpt' in model:
            kwargs["temperature"] = 0.3
        response = await client.chat.completions.create(**kwargs)
        tool_calls = response.choices[0].message.tool_calls
        if not tool_calls:
            return GithubRelatedOutput(is_github_issue=False,
                                       is_github_pr=False,
                                       source_code_related=False)
        arguments = tool_calls[0].function.arguments
        return GithubRelatedOutput(**json.loads(arguments))


def set_github_related(
        github_related_output: GithubRelatedOutput) -> GithubRelatedOutput:
    if github_related_output.is_github_issue:
        github_related_output.source_code_related = True
    if github_related_output.is_github_pr:
        github_related_output.source_code_related = True
    return github_related_output


async def separate_issue_and_pr(
    user_message: str,
    client: Union[AsyncOpenAI, AsyncAnthropic],
    openai_token: str | None = None,
    anthropic_token: str | None = None,
    model: str = "gpt-4.1-mini",
) -> tuple[str, str]:
    is_anthropic_model = "claude" in model
    result: SeparateIssueAndPrInput

    if is_anthropic_model:
        if anthropic_token:
            client = AsyncAnthropic(api_key=anthropic_token)
        if not isinstance(client, AsyncAnthropic):
            raise TypeError(
                "An AsyncAnthropic client is required for Claude models.")

        response = await client.messages.create(
            model=model,
            system=SEPARATE_ISSUE_AND_PR_PROMPT,
            messages=[{
                "role": "user",
                "content": user_message
            }],
            max_tokens=2048,
            tools=[{
                "name": "separate_issue_and_pr_messages",
                "description":
                "Reformulates a message into separate issue and PR messages.",
                "input_schema": SeparateIssueAndPrInput.model_json_schema()
            }],
            tool_choice={
                "type": "tool",
                "name": "separate_issue_and_pr_messages"
            })
        tool_call = next(
            (block for block in response.content if block.type == "tool_use"),
            None)
        if not tool_call:
            result = SeparateIssueAndPrInput(
                issue_message="Please create a GitHub issue.",
                pr_message="Please create a GitHub PR.")
        else:
            result = SeparateIssueAndPrInput(**tool_call.input)

    else:  # OpenAI model
        if openai_token:
            client = AsyncOpenAI(api_key=openai_token)
        if not isinstance(client, AsyncOpenAI):
            raise TypeError(
                "An AsyncOpenAI client is required for OpenAI models.")

        response = await client.chat.completions.create(
            model=model,
            messages=[
                {
                    "role": "system",
                    "content": SEPARATE_ISSUE_AND_PR_PROMPT
                },
                {
                    "role": "user",
                    "content": user_message
                },
            ],
            tools=[get_openai_tool_schema(SeparateIssueAndPrInput)],
            tool_choice={
                "type": "function",
                "function": {
                    "name": "SeparateIssueAndPrInput"
                }
            })
        tool_calls = response.choices[0].message.tool_calls
        if not tool_calls:
            result = SeparateIssueAndPrInput(
                issue_message="Please create a GitHub issue.",
                pr_message="Please create a GitHub PR.")
        else:
            arguments = tool_calls[0].function.arguments
            result = SeparateIssueAndPrInput(**json.loads(arguments))

    return (result.issue_message, result.pr_message)
