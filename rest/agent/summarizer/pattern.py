from openai import AsyncOpenAI
from rest.agent.output.pattern import PatternOutput
from rest.typing import ChatModel

SYSTEM_PROMPT = (
    "You are a helpful assistant that can summarize the pattern of the "
    "loggings, traces, metrics, etc. Please limit the pattern to at "
    "most 50 words. "
    "Notice that please don't add words like 'Pattern: ' etc to the "
    "final pattern. The final pattern is just the pattern.")


async def summarize_pattern(
    message: str,
    client: AsyncOpenAI,
    openai_token: str | None = None,
    model: ChatModel = ChatModel.GPT_4O,
) -> PatternOutput:
    if openai_token is not None:
        client = AsyncOpenAI(api_key=openai_token)
    messages = [{
        "role": "system",
        "content": SYSTEM_PROMPT,
    }, {
        "role":
        "user",
        "content": (f"Here is the message: "
                    f"{message}")
    }]
    response = await client.responses.parse(
        model=model,
        input=messages,
        text_format=PatternOutput,
        temperature=0.0,
    )
    return response.output[0].content[0].parsed
