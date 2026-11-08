"""Naming a group: parsing, retries, cost."""

import json

import httpx
import pytest

from worker.task_groups import naming


def _client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def _ok(name="Flight Booking", description="Booking flights."):
    return httpx.Response(
        200,
        json={
            "choices": [
                {"message": {"content": json.dumps({"name": name, "description": description})}}
            ],
            "usage": {"prompt_tokens": 1000, "completion_tokens": 100},
        },
    )


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(naming.time, "sleep", lambda s: None)


def test_returns_the_cleaned_name_description_and_cost():
    result = naming.name_group(
        ["Book a flight."], [], api_key="k", client=_client(lambda r: _ok(' "Flight  Booking". '))
    )
    assert result.name == "Flight Booking"
    assert result.cost_usd == pytest.approx(1000 * 0.0000002 + 100 * 0.0000012)


def test_summaries_are_fenced_and_taken_names_are_listed():
    seen = {}

    def handler(request):
        seen["body"] = json.loads(request.content)
        return _ok()

    naming.name_group(["Book a flight."], ["Hotel Booking"], api_key="k", client=_client(handler))
    user = seen["body"]["messages"][1]["content"]
    assert user.startswith("<summaries>") and "</summaries>" in user
    assert "Names already in use: Hotel Booking" in user
    assert seen["body"]["response_format"]["json_schema"]["strict"] is True


def test_retries_on_429_then_succeeds():
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(429) if len(calls) == 1 else _ok()

    assert naming.name_group(["x"], [], api_key="k", client=_client(handler)).name
    assert len(calls) == 2


def test_gives_up_after_repeated_server_errors():
    with pytest.raises(naming.NamingError):
        naming.name_group(["x"], [], api_key="k", client=_client(lambda r: httpx.Response(503)))


def test_a_client_error_is_not_retried():
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(401)

    with pytest.raises(naming.NamingError):
        naming.name_group(["x"], [], api_key="k", client=_client(handler))
    assert len(calls) == 1


def test_an_empty_name_is_retried():
    answers = iter([_ok(name="  "), _ok(name="Refunds")])
    assert (
        naming.name_group(["x"], [], api_key="k", client=_client(lambda r: next(answers))).name
        == "Refunds"
    )


def test_the_api_key_is_sent_as_a_bearer_token_and_never_in_the_body():
    seen = {}

    def handler(request):
        seen["auth"] = request.headers["authorization"]
        seen["body"] = request.content.decode()
        return _ok()

    naming.name_group(["x"], [], api_key="sekret", client=_client(handler))
    assert seen["auth"] == "Bearer sekret" and "sekret" not in seen["body"]
