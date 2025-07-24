import json

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
    "3. If it's just source code related, please set source_code_"
    "related to True.\n"
    "4. If it's not related to any of the above, please set "
    "is_github_issue and is_github_pr to False and source_code_related "
    "to False.\n"
    "Please only return True or False for one field ONLY IF "
    "you are 100% sure about the answer. Otherwise, please return False "
    "for all fields.")


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


async def is_github_related(
    user_message: str,
    client: AsyncOpenAI,
    openai_token: str | None = None,
    model: str = "gpt-4o-mini",
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
    if response.choices[0].message.tool_calls is None:
        return GithubRelatedOutput(
            is_github_issue=False,
            is_github_pr=False,
            source_code_related=False,
        )
    arguments = response.choices[0].message.tool_calls[0].function.arguments
    return GithubRelatedOutput(**json.loads(arguments))
