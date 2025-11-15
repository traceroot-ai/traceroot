from pydantic import BaseModel, Field

from rest.typing import Reference


class ChatOutput(BaseModel):
    r"""Chat output.
    """
    answer: str = Field(
        description=(
            "The main response or answer to "
            "the user's query based on given context.\n"
            "If there is any reference, please directly write"
            " the reference number such as [1], [2], [3] etc. at the "
            "end of the line of corresponding answer to indicate the "
            "reference."
        )
    )
    reference: list[Reference] = Field(
        description=(
            "Reference to span, log and source code for the answer. "
            "You only give the reference to span, log and source code "
            "if it's related to the answer. You don't need to give "
            "the reference if it's not related to the answer. Also "
            "the reference number starts from 1."
        )
    )
