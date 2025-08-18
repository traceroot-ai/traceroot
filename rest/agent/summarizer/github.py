import json

from openai import AsyncOpenAI
from pydantic import BaseModel, Field

from rest.agent.utils.openai_tools import get_openai_tool_schema
from rest.utils.token_tracking import track_tokens_for_user

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
    client: AsyncOpenAI,
    openai_token: str | None = None,
    model: str = "gpt-4.1-mini",
    user_sub: str | None = None,
) -> GithubRelatedOutput:
    if openai_token is not None:
        client = AsyncOpenAI(api_key=openai_token)
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
    }
    # Only set the temperature if it's not an OpenAI thinking model
    if 'gpt' in model:
        kwargs["temperature"] = 0.3
    response = await client.chat.completions.create(**kwargs)

    if user_sub:
        await track_tokens_for_user(user_sub=user_sub,
                                    openai_response=response,
                                    model=model)

    if response.choices[0].message.tool_calls is None:
        return GithubRelatedOutput(
            is_github_issue=False,
            is_github_pr=False,
            source_code_related=False,
        )
    arguments = response.choices[0].message.tool_calls[0].function.arguments
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
    client: AsyncOpenAI,
    openai_token: str | None = None,
    model: str = "gpt-4.1-mini",
    user_sub: str | None = None,
) -> tuple[str, str]:
    if openai_token is not None:
        client = AsyncOpenAI(api_key=openai_token)
    kwargs = {
        "model":
        model,
        "messages": [
            {
                "role": "system",
                "content": SEPARATE_ISSUE_AND_PR_PROMPT
            },
            {
                "role": "user",
                "content": user_message
            },
        ],
        "tools": [get_openai_tool_schema(SeparateIssueAndPrInput)],
    }
    response = await client.chat.completions.create(**kwargs)

    if user_sub:
        await track_tokens_for_user(user_sub=user_sub,
                                    openai_response=response,
                                    model=model)

    # TODO: Improve the default values here
    if response.choices[0].message.tool_calls is None:
        return SeparateIssueAndPrInput(
            issue_message="Please create an GitHub issue.",
            pr_message="Please create a GitHub PR.",
        )
    arguments = response.choices[0].message.tool_calls[0].function.arguments
    return SeparateIssueAndPrInput(**json.loads(arguments))
