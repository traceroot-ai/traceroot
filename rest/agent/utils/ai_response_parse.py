# rest/utils/ai.py
from typing import Any, Optional, Sequence, Type, TypeVar
from openai import AsyncOpenAI
from rest.typing import  ChatModel

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

    params: dict[str, Any] = {} if model in SPECIAL_MODELS else {"temperature": temperature}
    resp = await client.responses.parse(
        model=model,
        input=list(messages),
        text_format=output_format,
        **params,
    )

    idx = 1 if model in SPECIAL_MODELS else 0
    # Primary SDK shape:
    return resp.output[idx].content[0].parsed