"""Unit tests for serialize_value in traceroot.utils.

Tests cover all type categories: primitives, collections, stdlib types,
dataclasses, pydantic models, custom objects, and edge cases like
circular references and class-level attributes.
"""

import enum
import json
from dataclasses import dataclass
from datetime import UTC, date, datetime
from uuid import UUID

import pytest

from traceroot.utils import serialize_value

# ---- Primitives ----


class TestPrimitives:
    def test_none(self):
        assert serialize_value(None) is None

    def test_string(self):
        assert serialize_value("hello") == "hello"

    def test_empty_string(self):
        assert serialize_value("") == ""

    def test_int(self):
        assert serialize_value(42) == 42

    def test_zero(self):
        assert serialize_value(0) == 0

    def test_negative_int(self):
        assert serialize_value(-7) == -7

    def test_float(self):
        assert serialize_value(3.14) == 3.14

    def test_bool_true(self):
        assert serialize_value(True) is True

    def test_bool_false(self):
        assert serialize_value(False) is False

    def test_bool_not_treated_as_int(self):
        # bool is a subclass of int; ensure it stays bool
        result = serialize_value(True)
        assert result is True
        assert not isinstance(result, int) or isinstance(result, bool)

    def test_nan(self):
        assert serialize_value(float("nan")) == "NaN"

    def test_infinity(self):
        assert serialize_value(float("inf")) == "Infinity"

    def test_negative_infinity(self):
        assert serialize_value(float("-inf")) == "Infinity"


# ---- Collections ----


class TestCollections:
    def test_list(self):
        assert serialize_value([1, "two", 3.0]) == [1, "two", 3.0]

    def test_empty_list(self):
        assert serialize_value([]) == []

    def test_nested_list(self):
        assert serialize_value([[1, 2], [3, 4]]) == [[1, 2], [3, 4]]

    def test_tuple(self):
        assert serialize_value((1, 2, 3)) == [1, 2, 3]

    def test_set(self):
        result = serialize_value({1})
        assert result == [1]

    def test_frozenset(self):
        result = serialize_value(frozenset([1]))
        assert result == [1]

    def test_dict(self):
        assert serialize_value({"a": 1, "b": 2}) == {"a": 1, "b": 2}

    def test_empty_dict(self):
        assert serialize_value({}) == {}

    def test_nested_dict(self):
        val = {"outer": {"inner": [1, 2]}}
        assert serialize_value(val) == {"outer": {"inner": [1, 2]}}


# ---- Standard library types ----


class TestStdlibTypes:
    def test_datetime(self):
        dt = datetime(2026, 2, 5, 12, 30, 0)
        assert serialize_value(dt) == "2026-02-05T12:30:00"

    def test_datetime_with_tz(self):
        dt = datetime(2026, 2, 5, 12, 0, 0, tzinfo=UTC)
        result = serialize_value(dt)
        assert "2026-02-05" in result
        assert "+00:00" in result or "UTC" in result

    def test_date(self):
        d = date(2026, 2, 5)
        assert serialize_value(d) == "2026-02-05"

    def test_uuid(self):
        u = UUID("12345678-1234-5678-1234-567812345678")
        assert serialize_value(u) == "12345678-1234-5678-1234-567812345678"

    def test_bytes_utf8(self):
        assert serialize_value(b"hello") == "hello"

    def test_bytes_non_utf8(self):
        assert serialize_value(b"\xff\xfe") == "<non-utf8 bytes>"

    def test_enum(self):
        class Color(enum.Enum):
            RED = "red"
            BLUE = "blue"

        assert serialize_value(Color.RED) == "red"

    def test_int_enum(self):
        class Priority(enum.IntEnum):
            LOW = 1
            HIGH = 2

        assert serialize_value(Priority.HIGH) == 2

    def test_exception(self):
        result = serialize_value(ValueError("bad input"))
        assert result == "ValueError: bad input"


# ---- Custom objects ----


class TestCustomObjects:
    def test_object_with_dict(self):
        class Msg:
            def __init__(self):
                self.content = "hello"
                self.role = "assistant"

        result = serialize_value(Msg())
        assert result == {"content": "hello", "role": "assistant"}

    def test_nested_custom_objects(self):
        class Inner:
            def __init__(self):
                self.value = 42

        class Outer:
            def __init__(self):
                self.inner = Inner()
                self.name = "outer"

        result = serialize_value(Outer())
        assert result == {"inner": {"value": 42}, "name": "outer"}

    def test_class_level_attrs(self):
        """Objects created via type() with class-level (not instance) attrs."""
        obj = type("Config", (), {"name": "gpt-4", "temperature": 0.7})()
        result = serialize_value(obj)
        assert result["name"] == "gpt-4"
        assert result["temperature"] == 0.7

    def test_circular_reference(self):
        class Node:
            def __init__(self):
                self.child = None

        n = Node()
        n.child = n
        result = serialize_value(n)
        assert result["child"] == "<circular ref: Node>"

    def test_mutual_circular_reference(self):
        class A:
            def __init__(self):
                self.b = None

        class B:
            def __init__(self):
                self.a = None

        a, b = A(), B()
        a.b = b
        b.a = a

        result = serialize_value(a)
        assert result["b"]["a"] == "<circular ref: A>"

    def test_slots_object(self):
        class Point:
            __slots__ = ("x", "y")

            def __init__(self, x, y):
                self.x = x
                self.y = y

        result = serialize_value(Point(1, 2))
        assert result == {"x": 1, "y": 2}


# ---- MockMessage (the actual bug scenario) ----


class TestMockMessage:
    """Tests that replicate the exact pattern from the streaming example."""

    def _make_mock_message(self, content, tool_calls=None):
        class MockToolCall:
            def __init__(self, data):
                self.id = data["id"]
                self.function = type(
                    "Function",
                    (),
                    {
                        "name": data["function"]["name"],
                        "arguments": data["function"]["arguments"],
                    },
                )()

        class MockMessage:
            def __init__(self, content, tool_calls):
                self.content = content
                self.tool_calls = (
                    [MockToolCall(tc) for tc in tool_calls.values()] if tool_calls else None
                )

        return MockMessage(content, tool_calls)

    def test_tool_call_response(self):
        tool_calls = {
            0: {
                "id": "call_abc",
                "function": {"name": "get_weather", "arguments": '{"city":"SF"}'},
            },
            1: {
                "id": "call_def",
                "function": {"name": "get_weather", "arguments": '{"city":"Tokyo"}'},
            },
        }
        msg = self._make_mock_message("", tool_calls)
        result = serialize_value(msg)

        assert result["content"] == ""
        assert len(result["tool_calls"]) == 2
        assert result["tool_calls"][0]["id"] == "call_abc"
        assert result["tool_calls"][0]["function"]["name"] == "get_weather"
        assert result["tool_calls"][1]["function"]["name"] == "get_weather"

    def test_content_response(self):
        msg = self._make_mock_message("Here is the weather comparison...")
        result = serialize_value(msg)

        assert result["content"] == "Here is the weather comparison..."
        assert result["tool_calls"] is None

    def test_json_roundtrip(self):
        """Ensure the serialized output can be JSON-encoded."""
        tool_calls = {
            0: {"id": "call_1", "function": {"name": "calc", "arguments": '{"x":1}'}},
        }
        msg = self._make_mock_message("partial", tool_calls)
        result = serialize_value(msg)

        # Should not raise
        json_str = json.dumps(result)
        parsed = json.loads(json_str)
        assert parsed["content"] == "partial"
        assert parsed["tool_calls"][0]["function"]["name"] == "calc"


# ---- Dataclasses ----


class TestDataclasses:
    def test_simple_dataclass(self):
        @dataclass
        class Usage:
            prompt_tokens: int
            completion_tokens: int

        result = serialize_value(Usage(prompt_tokens=10, completion_tokens=20))
        assert result == {"prompt_tokens": 10, "completion_tokens": 20}

    def test_nested_dataclass(self):
        @dataclass
        class Inner:
            value: str

        @dataclass
        class Outer:
            inner: Inner
            count: int

        result = serialize_value(Outer(inner=Inner(value="test"), count=5))
        assert result == {"inner": {"value": "test"}, "count": 5}


# ---- Pydantic models ----


class TestPydantic:
    def test_pydantic_model(self):
        try:
            from pydantic import BaseModel
        except ImportError:
            pytest.skip("pydantic not installed")

        class User(BaseModel):
            name: str
            age: int

        result = serialize_value(User(name="Alice", age=30))
        assert result == {"name": "Alice", "age": 30}


# ---- Mixed / edge cases ----


class TestEdgeCases:
    def test_deeply_nested(self):
        val = {"a": [{"b": {"c": [1, 2, {"d": True}]}}]}
        assert serialize_value(val) == val

    def test_list_of_custom_objects(self):
        class Item:
            def __init__(self, n):
                self.n = n

        result = serialize_value([Item(1), Item(2)])
        assert result == [{"n": 1}, {"n": 2}]

    def test_dict_with_custom_object_values(self):
        class Score:
            def __init__(self, v):
                self.v = v

        result = serialize_value({"a": Score(10)})
        assert result == {"a": {"v": 10}}

    def test_object_with_none_attr(self):
        class Partial:
            def __init__(self):
                self.present = "yes"
                self.absent = None

        result = serialize_value(Partial())
        assert result == {"present": "yes", "absent": None}

    def test_empty_custom_object(self):
        class Empty:
            pass

        result = serialize_value(Empty())
        assert result == {}
