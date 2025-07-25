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
    client: AsyncOpenAI,
    model: str = "gpt-4o-mini",
) -> list[LogFeature]:
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
    response: LogFeatureSelectorOutput = response.output[0].content[0].parsed
    return response.log_features


async def span_feature_selector(
    user_message: str,
    client: AsyncOpenAI,
    model: str = "gpt-4o-mini",
) -> list[SpanFeature]:
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
    response: SpanFeatureSelectorOutput = response.output[0].content[0].parsed
    return response.span_features
