from typing import Union

from anthropic import AsyncAnthropic
from openai import AsyncOpenAI

from rest.agent.output.feature import (LogFeatureSelectorOutput,
                                       SpanFeatureSelectorOutput)
from rest.agent.typing import LogFeature, SpanFeature

LOG_FEATURE_SELECTOR_PROMPT = (
    "You are a helpful assistant that can select related "
    "log features based on the user's message.\n"
    "You will be given a user's message and a list of log features.\n"
    "You need to select the log features that are relevant to the "
    "user's message.\n"
    "Please return the log features in a list of strings.\n"
    "Please only include the log features that are necessary to answer "
    "the user's message!")

SPAN_FEATURE_SELECTOR_PROMPT = (
    "You are a helpful assistant that can select related "
    "span features based on the user's message.\n"
    "You will be given a user's message and a list of span features.\n"
    "You need to select the span features that are relevant to the "
    "user's message.\n"
    "Please return the span features in a list of strings.\n"
    "Please only include the span features that are necessary to answer "
    "the user's message!")


async def log_feature_selector(
    user_message: str,
    client: Union[AsyncOpenAI, AsyncAnthropic],
    model: str = "gpt-4o-mini",
) -> list[LogFeature]:
    r"""Selects relevant log features based on the user message."""
    is_anthropic_model = "claude" in model
    if is_anthropic_model:
        if not isinstance(client, AsyncAnthropic):
            raise TypeError(
                "An AsyncAnthropic client is required for Claude models.")
        messages = [{"role": "user", "content": user_message}]
        response = await client.messages.create(
            model=model,
            system=LOG_FEATURE_SELECTOR_PROMPT,
            messages=messages,
            max_tokens=1024,
            temperature=0.5,
            tools=[{
                "name":
                "select_log_features",
                "description":
                "Selects relevant log features based on the user message.",
                "input_schema":
                LogFeatureSelectorOutput.model_json_schema(),
            }],
            tool_choice={
                "type": "tool",
                "name": "select_log_features"
            },
        )
        tool_call = next(
            (block for block in response.content if block.type == "tool_use"),
            None)
        if not tool_call:
            return []
        response_obj = LogFeatureSelectorOutput(**tool_call.input)

    else:
        if not isinstance(client, AsyncOpenAI):
            raise TypeError(
                "An AsyncOpenAI client is required for OpenAI models.")
        messages = [
            {
                "role": "system",
                "content": LOG_FEATURE_SELECTOR_PROMPT
            },
            {
                "role": "user",
                "content": user_message
            },
        ]
        response = await client.responses.parse(
            model=model,
            input=messages,
            text_format=LogFeatureSelectorOutput,
            temperature=0.5,
        )
        response_obj: LogFeatureSelectorOutput = response.output[0].content[
            0].parsed

    return response_obj.log_features


async def span_feature_selector(
    user_message: str,
    client: Union[AsyncOpenAI, AsyncAnthropic],
    model: str = "gpt-4o-mini",
) -> list[SpanFeature]:
    r"""Selects relevant span features based on the user message."""
    is_anthropic_model = "claude" in model
    if is_anthropic_model:
        if not isinstance(client, AsyncAnthropic):
            raise TypeError(
                "An AsyncAnthropic client is required for Claude models.")
        messages = [{"role": "user", "content": user_message}]
        response = await client.messages.create(
            model=model,
            system=SPAN_FEATURE_SELECTOR_PROMPT,
            messages=messages,
            max_tokens=1024,
            temperature=0.5,
            tools=[{
                "name":
                "select_span_features",
                "description":
                "Selects relevant span features based on the user message.",
                "input_schema":
                SpanFeatureSelectorOutput.model_json_schema(),
            }],
            tool_choice={
                "type": "tool",
                "name": "select_span_features"
            },
        )
        tool_call = next(
            (block for block in response.content if block.type == "tool_use"),
            None)
        if not tool_call:
            return []
        response_obj = SpanFeatureSelectorOutput(**tool_call.input)
    else:
        if not isinstance(client, AsyncOpenAI):
            raise TypeError(
                "An AsyncOpenAI client is required for OpenAI models.")
        messages = [
            {
                "role": "system",
                "content": SPAN_FEATURE_SELECTOR_PROMPT
            },
            {
                "role": "user",
                "content": user_message
            },
        ]
        response = await client.responses.parse(
            model=model,
            input=messages,
            text_format=SpanFeatureSelectorOutput,
            temperature=0.5,
        )
        response_obj: SpanFeatureSelectorOutput = response.output[0].content[
            0].parsed

    return response_obj.span_features
