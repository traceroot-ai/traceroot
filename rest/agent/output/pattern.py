from pydantic import BaseModel, Field


class PatternOutput(BaseModel):
    r"""Chat output.
    """
    pattern: str = Field(
        description=("The pattern of the loggings, traces, metrics, etc. "
                     "Please limit the pattern to at most 50 words. "))
