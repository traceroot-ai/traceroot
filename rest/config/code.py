from pydantic import BaseModel


class CodeRequest(BaseModel):
    url: str


class CodeResponse(BaseModel):
    line: str | None = None
    lines_above: list[str] | None = None
    lines_below: list[str] | None = None
    error_message: str | None = None
