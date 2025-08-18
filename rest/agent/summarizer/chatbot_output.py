from openai import AsyncOpenAI

from rest.config import ChatbotResponse
from rest.typing import ChatModel
from rest.utils.token_tracking import track_tokens_for_user

SYSTEM_PROMPT = (
    "You are a helpful TraceRoot.AI assistant that summarizes the response "
    "output for two responses. One is for creating a GitHub issue and the "
    "other is for creating a GitHub PR. Please summarize the output for "
    "both responses into a single ChatOutput with following rules:\n"
    "1. Please make sure the summary is concise and to the point.\n"
    "2. Please make sure the summary includes all the information from the "
    "both responses.\n"
    "3. You may need to increase the number of reference. For example in the "
    "the second output, the answer has a reference ending with [1]. You "
    "should increase the number to 5 if there are 4 references in the first "
    "output.\n"
    "Notice that you need to not only increase the number of reference in "
    "the answer but also increase the number of reference in the reference "
    "list. Please make sure the number of reference is consistent between "
    "the answer and the reference list.\n"
    "4. Please don't mention any word related to 'first' or 'second' in the "
    "final answer!\n"
    "5. Please don't mention you are unsure or the provided data is "
    "insufficient. Please be confident and provide the best answer you "
    "can.\n"
    "6. You need to corresponds the reference to the answer."
)


async def summarize_chatbot_output(
    issue_response: ChatbotResponse,
    pr_response: ChatbotResponse,
    client: AsyncOpenAI,
    openai_token: str | None = None,
    model: ChatModel = ChatModel.GPT_4_1_MINI,
    user_sub: str | None = None,
) -> ChatbotResponse:
    if openai_token is not None:
        client = AsyncOpenAI(api_key=openai_token)
    messages = [
        {
            "role": "system",
            "content": SYSTEM_PROMPT,
        },
        {
            "role":
            "user",
            "content": (
                f"Here are the first issue response: "
                f"{issue_response.model_dump_json()}\n\n"
                f"Here are the second PR response: "
                f"{pr_response.model_dump_json()}"
            )
        }
    ]
    response = await client.responses.parse(
        model=model,
        input=messages,
        text_format=ChatbotResponse,
        temperature=0.5,
    )

    if user_sub:
        await track_tokens_for_user(
            user_sub=user_sub,
            openai_response=response,
            model=str(model)
        )

    return response.output[0].content[0].parsed
