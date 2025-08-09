from typing import Any, Sequence, Type, TypeVar

from openai import AsyncOpenAI

from rest.typing import ChatModel

T = TypeVar("T")

SPECIAL_MODELS = {
    ChatModel.GPT_5.value,
    ChatModel.GPT_5_MINI.value,
    ChatModel.O4_MINI.value,
}


async def structured_parse(
    client: AsyncOpenAI,
    model: str,
    output_format: Type[T],
    *,
    messages: [Sequence[dict[str, str]]],
    temperature: float = 0.5,
) -> T:
    """
    Unified wrapper for responses.parse with consistent temperature & output indexing.
    """

    if model in SPECIAL_MODELS:
        params: dict[str, Any] = {}
        idx = 1
    else:
        params = {"temperature": temperature}
        idx = 0

    resp = await client.responses.parse(
        model=model,
        input=list(messages),
        text_format=output_format,
        **params,
    )
    return resp.output[idx].content[0].parsed
