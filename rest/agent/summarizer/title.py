from typing import Union

from anthropic import AsyncAnthropic
from openai import AsyncOpenAI

TITLE_PROMPT = (
    "You are a helpful assistant that can summarize the title of the "
    "chat. You are given user's question and please summarize the "
    "title of the chat based on the question. Please keep in mind "
    "this chat may relate to the debugging purpose based on the "
    "logs, traces, metrics and source code. Keep your summary concise "
    "and to the point. Please limit the summary to at most 15 words. "
    "Notice that please don't add words like 'Title: ' etc to the "
    "final title. The final title is just the title. Also please "
    "don't include any punctuations.")


async def summarize_title(
    user_message: str,
    client: Union[AsyncOpenAI, AsyncAnthropic],
    openai_token: str | None = None,
    anthropic_token: str | None = None,
    model: str = "gpt-4o-mini",
    first_chat: bool = False,
) -> str | None:
    if not first_chat:
        return None

    is_anthropic_model = "claude" in model

    if is_anthropic_model:
        if anthropic_token is not None:
            client = AsyncAnthropic(api_key=anthropic_token)
        if not isinstance(client, AsyncAnthropic):
            raise TypeError(
                "An AsyncAnthropic client is required for Claude models.")

        response = await client.messages.create(
            model=model,
            system=TITLE_PROMPT,
            messages=[{
                "role": "user",
                "content": user_message
            }],
            max_tokens=50,  # A small limit is efficient for a title
            temperature=0.7,
        )
        return response.content[0].text

    else:  # OpenAI model
        if openai_token is not None:
            client = AsyncOpenAI(api_key=openai_token)
        if not isinstance(client, AsyncOpenAI):
            raise TypeError(
                "An AsyncOpenAI client is required for OpenAI models.")

        response = await client.chat.completions.create(
            model=model,
            messages=[
                {
                    "role": "system",
                    "content": TITLE_PROMPT
                },
                {
                    "role": "user",
                    "content": user_message
                },
            ],
            max_tokens=50,  # A small limit is efficient for a title
            temperature=0.7,
        )
        return response.choices[0].message.content
