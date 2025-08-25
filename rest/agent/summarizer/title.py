from openai import AsyncOpenAI

from rest.typing import ChatModel
from rest.utils.token_tracking import track_tokens_for_user

TITLE_PROMPT = (
    "You are a helpful assistant that can summarize the title of the "
    "chat. You are given user's question and please summarize the "
    "title of the chat based on the question. Please keep in mind "
    "this chat may relate to the debugging purpose based on the "
    "logs, traces, metrics and source code. Keep your summary concise "
    "and to the point. Please limit the summary to at most 15 words. "
    "Notice that please don't add words like 'Title: ' etc to the "
    "final title. The final title is just the title. Also please "
    "don't include any punctuations."
)


async def summarize_title(
    user_message: str,
    client: AsyncOpenAI,
    openai_token: str | None = None,
    model: str = ChatModel.GPT_5_MINI.value,
    first_chat: bool = False,
    user_sub: str | None = None,
) -> str | None:
    if not first_chat:
        return None
    if openai_token is not None:
        client = AsyncOpenAI(api_key=openai_token)
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
    )
    if user_sub:
        await track_tokens_for_user(
            user_sub=user_sub,
            openai_response=response,
            model=model
        )
    return response.choices[0].message.content
