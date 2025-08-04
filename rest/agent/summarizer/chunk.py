import json

from anthropic import AsyncAnthropic
from openai import AsyncOpenAI

from rest.agent.output.chat_output import ChatOutput
from rest.typing import ChatModel, Reference

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
) -> ChatOutput:
    r"""Summarize the response answers and references into
    a single ChatOutput.
    """
    reference = []
    for ref in response_references:
        if ref:
            ref_str = "\n".join(
                [json.dumps(r.model_dump(), indent=4) for r in ref])
            reference.append(ref_str)
        else:
            reference.append("[]")

    reference_content = "\n\n".join(reference)
    answer_content = "\n\n".join(response_answers)
    user_content = (f"Here are the response answers: {answer_content}\n\n"
                    f"Here are the response references: {reference_content}")

    is_anthropic_model = "claude" in model.value

    if is_anthropic_model:
        if not isinstance(client, AsyncAnthropic):
            raise TypeError(
                "An AsyncAnthropic client is required for Claude models.")

        messages = [{"role": "user", "content": user_content}]
        response = await client.messages.create(
            model=model.value,
            system=SYSTEM_PROMPT,
            messages=messages,
            max_tokens=4096,
            temperature=0.8,
            tools=[{
                "name": "summarize_chunks",
                "description":
                "Provides single summarized ChatOutput from multiple chunks.",
                "input_schema": ChatOutput.model_json_schema(),
            }],
            tool_choice={
                "type": "tool",
                "name": "summarize_chunks"
            },
        )
        tool_call = next(
            (block for block in response.content if block.type == "tool_use"),
            None)
        if not tool_call:
            return ChatOutput(
                answer="Failed to get structured summary from the Anthropic.",
                reference=[])
        return ChatOutput(**tool_call.input)
    else:
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
            text_format=ChatOutput,
            temperature=0.8,
        )
        return response.output[0].content[0].parsed
