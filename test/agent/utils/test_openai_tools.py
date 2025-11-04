from rest.agent.utils.openai_tools import get_openai_tool_schema


def get_weather(location: str) -> str:
    """Get current temperature for a given location.

    Args:
        location (str): City and country e.g. Bogotá, Colombia

    Returns:
        str: The weather in the given location.
    """
    return f"The weather in {location} is sunny."


def test_get_openai_tool_schema():
    r"""Test that get_openai_tool_schema generates
    the correct schema for get_weather function.
    """
    result = get_openai_tool_schema(get_weather)
    assert result["type"] == "function"
