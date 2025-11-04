from openai import AsyncOpenAI

from rest.typing import ChatModel
from rest.utils.token_tracking import track_tokens_for_user

TITLE_PROMPT = (
    "You are a helpful assistant that generates a title for a "
    "chat. You are given user's query and summarize the title of "
    "the chat based on the query. Please keep in mind this chat may "
    "relate to the debugging purpose based on the logs, traces, metrics "
    "and source code. Keep your summary concise and to the point. "
    "Please limit the summary to at most 18 words with following rules:\n"
    "1. Don't include any words like 'Title: ' etc in the title.\n"
    "2. Don't include any punctuations.\n"
    "3. Use the same language as the query.\n"
    "4. For English, follow the title capitalization rules to capitalize the title."
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
