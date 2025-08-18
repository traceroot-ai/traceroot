import json

from openai import AsyncOpenAI

from rest.agent.output.chat_output import ChatOutput
from rest.typing import ChatModel, Reference
from rest.utils.token_tracking import track_tokens_for_user

SYSTEM_PROMPT = (
    "You are a helpful TraceRoot.AI assistant that summarizes the response "
    "answers and "
    "references into a single ChatOutput from multiple chunks with following "
    "rules:\n"
    "1. Please make sure the summary is concise and to the point.\n"
    "2. Please make sure the summary includes all the information from the "
    "response answers and references.\n"
    "3. You may need to increase the number of reference. For example in the "
    "the second chunk, the answer has a reference ending with [1]. You should "
    "increase the number to 5 if there are 4 references in the first chunk. "
    "Notice that you need to not only increase the number of reference in "
    "the answer but also increase the number of reference in the reference "
    "list.\n"
    "4. Please just summarize based on the answers and references. You don't "
    "need to include any other information.\n"
    "5. Please don't mention any word related to 'chunk' in the final "
    "answer!\n"
    "6. Please don't mention you are unsure or the provided data is "
    "insufficient. Please be confident and provide the best answer you "
    "can.\n"
    "7. You need to corresponds the reference to the answer.")


async def chunk_summarize(
    response_answers: list[str],
    response_references: list[list[Reference]],
    client: AsyncOpenAI,
    model: ChatModel,
    user_sub: str,
) -> ChatOutput:
    r"""Summarize the response answers and references into
    a single ChatOutput.
    """
    reference = []
    for ref in response_references:
        if len(ref) > 0:
            ref_str = "\n".join(
                [json.dumps(r.model_dump(), indent=4) for r in ref])
            reference.append(ref_str)
        else:
            reference.append("[]")
    reference = "\n\n".join(reference)
    answer = "\n\n".join(response_answers)
    messages = [{
        "role": "system",
        "content": SYSTEM_PROMPT,
    }, {
        "role":
        "user",
        "content":
        f"Here are the response answers: {answer}\n\n"
        f"Here are the response references: {reference}"
    }]
    response = await client.responses.parse(
        model=model,
        input=messages,
        text_format=ChatOutput,
        temperature=0.8,
    )

    # Track token usage for this API call
    await track_tokens_for_user(user_sub=user_sub,
                                openai_response=response,
                                model=str(model))

    return response.output[0].content[0].parsed
