from datetime import datetime, timezone

from anthropic import AsyncAnthropic
from openai import AsyncOpenAI

from rest.config import ChatbotResponse
from rest.typing import ChatModel, MessageType

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
    "6. You need to corresponds the reference to the answer.")


async def summarize_chatbot_output(
    issue_response: ChatbotResponse,
    pr_response: ChatbotResponse,
    client: AsyncOpenAI,
    openai_token: str | None = None,
    anthropic_token: str | None = None,
    model: ChatModel = ChatModel.GPT_4_1_MINI,
) -> ChatbotResponse:
    """Summarizes two ChatbotResponse objects into one."""
    is_anthropic_model = "claude" in model.value
    user_content = (f"Here are the first issue response: "
                    f"{issue_response.model_dump_json()}\n\n"
                    f"Here are the second PR response: "
                    f"{pr_response.model_dump_json()}")

    if is_anthropic_model:
        if anthropic_token is not None:
            client = AsyncAnthropic(api_key=anthropic_token)
        if not isinstance(client, AsyncAnthropic):
            raise TypeError(
                "An AsyncAnthropic client is required for Claude models.")

        messages = [{"role": "user", "content": user_content}]
        response = await client.messages.create(
            model=model.value,
            system=SYSTEM_PROMPT,
            messages=messages,
            max_tokens=4096,
            temperature=0.5,
            tools=[{
                "name": "summarize_github_responses",
                "description":
                "Generates a single, summarized chatbot response.",
                "input_schema": ChatbotResponse.model_json_schema(),
            }],
            tool_choice={
                "type": "tool",
                "name": "summarize_github_responses"
            },
        )
        tool_call = next(
            (block for block in response.content if block.type == "tool_use"),
            None)
        if not tool_call:
            return ChatbotResponse(
                message="Failed to get structured summary from the Anthropic.",
                message_type=MessageType.ASSISTANT,
                time=datetime.now(timezone.utc))
        return ChatbotResponse(**tool_call.input)

    else:
        if openai_token is not None:
            client = AsyncOpenAI(api_key=openai_token)
        if not isinstance(client, AsyncOpenAI):
            raise TypeError(
                "An AsyncOpenAI client is required for OpenAI models.")

        messages = [{
            "role": "system",
            "content": SYSTEM_PROMPT,
        }, {
            "role": "user",
            "content": user_content
        }]
        response = await client.responses.parse(
            model=model.value,
            input=messages,
            text_format=ChatbotResponse,
            temperature=0.5,
        )
        return response.output[0].content[0].parsed
