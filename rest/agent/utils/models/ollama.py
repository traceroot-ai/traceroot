# handle ollama

import re
from inspect import Parameter, signature
from typing import Any, Callable

import ollama
from docstring_parser import parse
from pydantic import create_model
from pydantic.fields import FieldInfo

from rest.agent.utils.message import Message


class Ollama:

    def __init__(self, model: str):
        self.model = model

    def chat_completions(self,
                         messages: list[Message],
                         tools: list[Callable] = []) -> ollama.ChatResponse:
        msgs = self._convert_message(messages, tools=tools)
        response = ollama.chat(model=self.model, tools=[], messages=msgs)
        return response

    def _convert_message(self, messages: list[Message],
                         tools: list[Callable]) -> list[dict[str, str]]:
        ollama_messsages = []
        for m in messages:
            ollama_messsages.append({
                "role": m.role,
                "content": m.content,
                "tools": self._convert_tools(tools),
            })
        return ollama_messsages

    def _convert_tools(self, tools: list[Callable]):
        t = []

        for tool in tools:
            t.append(self._convert_tool(tool))
        return t

    def _convert_tool(self, tool: Callable) -> dict[str, Any]:
        # To be honest i don't think this is a good method ,
        # i think instead find a way to define tool would be a better option
        # one possible solution is a Tool class
        # it would be much more robust than parsing like this
        params = signature(tool).parameters
        fields = {}

        for param_name, p in params.items():
            param_type = p.annotation
            param_default = p.default
            param_kind = p.kind
            param_annotation = p.annotation

            if (param_kind == Parameter.VAR_POSITIONAL
                    or param_kind == Parameter.VAR_KEYWORD):
                continue

            if param_annotation is Parameter.empty:
                param_type = Any

            if param_default is Parameter.empty:
                fields[param_name] = (param_type, FieldInfo())
            else:
                fields[param_name] = (param_type,
                                      FieldInfo(default=param_default))

        def _create_mol(name, field):
            return create_model(name, **field)

        model = _create_mol(_to_pascal(tool.__name__), fields)
        parameters_dict = model.model_json_schema()

        docstring = parse(tool.__doc__ or "")
        for param in docstring.params:
            if (name := param.arg_name) in parameters_dict["properties"] and (
                    description := param.description):
                parameters_dict["properties"][name][
                    "description"] = description

        short_description = docstring.short_description or ""
        long_description = docstring.long_description or ""
        if long_description:
            tool_description = f"{short_description}\n{long_description}"
        else:
            tool_description = short_description

        parameters_dict["additionalProperties"] = False

        function_schema = {
            "name": tool.__name__,
            "description": tool_description,
            "strict": True,
            "parameters": parameters_dict,
        }

        tool_schema = {
            "type": "function",
            "function": function_schema,
        }

        return tool_schema


def _to_pascal(snake: str) -> str:
    """Convert a snake_case string to PascalCase.

    Args:
        snake (str): The snake_case string to be converted.

    Returns:
        str: The converted PascalCase string.
    """
    # Check if the string is already in PascalCase
    if re.match(r"^[A-Z][a-zA-Z0-9]*([A-Z][a-zA-Z0-9]*)*$", snake):
        return snake
    # Remove leading and trailing underscores
    snake = snake.strip("_")
    # Replace multiple underscores with a single one
    snake = re.sub("_+", "_", snake)
    # Convert to PascalCase
    return re.sub(
        "_([0-9A-Za-z])",
        lambda m: m.group(1).upper(),
        snake.title(),
    )
