"""
Offline check of what the agent sends to DeepSeek: every request uses a current
model with thinking disabled, so a tool-calling turn and a later turn on the same
agent stay valid without passing back reasoning_content.

Run: python -m unittest test_main.py
"""

import json
import os
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

# Set before main.py loads .env (which never overrides): no traces are exported.
os.environ["TRACEROOT_ENABLED"] = "false"
os.environ["DEEPSEEK_API_KEY"] = "test"

import main

REQUESTS: list[dict] = []


def _stream(body: dict) -> tuple[int, str]:
    """Stand-in for DeepSeek's streaming Chat Completions, with its thinking-mode rule."""
    messages = body["messages"]
    if body["model"] not in ("deepseek-flash", "deepseek-v4-pro"):
        return 400, json.dumps({"error": {"message": "Model Not Exist"}})
    thinking = body.get("thinking", {}).get("type", "enabled") != "disabled"
    assistants = [m for m in messages if m["role"] == "assistant"]
    if thinking and body.get("tools") and any(not m.get("reasoning_content") for m in assistants):
        return 400, json.dumps({"error": {"message": "pass back reasoning_content"}})

    def chunk(delta: dict, finish: str | None = None) -> dict:
        return {
            "id": "c",
            "object": "chat.completion.chunk",
            "created": 0,
            "model": body["model"],
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
        }

    chunks = [chunk({"role": "assistant", "content": ""})]
    if thinking:
        chunks += [chunk({"reasoning_content": "Let me "}), chunk({"reasoning_content": "think."})]
    if messages[-1]["role"] == "user":
        calls = (
            [("get_weather", {"city": c}) for c in ("San Francisco", "Tokyo")]
            if "weather" in messages[-1]["content"]
            else [("get_stock_price", {"symbol": "NVDA"})]
        )
        for i, (name, args) in enumerate(calls):
            head = {"index": i, "id": f"call_{len(assistants)}_{i}", "type": "function"}
            chunks.append(
                chunk({"tool_calls": [{**head, "function": {"name": name, "arguments": ""}}]})
            )
            raw = json.dumps(args)
            for part in (raw[:4], raw[4:9], raw[9:]):  # arguments split across chunks
                chunks.append(
                    chunk({"tool_calls": [{"index": i, "function": {"arguments": part}}]})
                )
        chunks.append(chunk({}, "tool_calls"))
    else:
        results = []
        for m in reversed(messages):
            if m["role"] != "tool":
                break
            results.insert(0, m["content"])
        answer = "Based on " + " | ".join(results)
        chunks += [
            chunk({"content": answer[:8]}),
            chunk({"content": answer[8:]}),
            chunk({}, "stop"),
        ]
    usage = {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
    chunks.append({**chunk({}), "choices": [], "usage": usage})  # usage-only final chunk
    return 200, "".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n\n"


class _Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        REQUESTS.append(body)
        status, payload = _stream(body)
        data = payload.encode()
        self.send_response(status)
        self.send_header(
            "Content-Type", "text/event-stream" if status == 200 else "application/json"
        )
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


class DeepSeekRequestTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def test_two_tool_turns_on_one_agent(self):
        self.assertEqual(main._build_deepseek_client().base_url.host, "api.deepseek.com")
        local = f"http://127.0.0.1:{self.server.server_port}"
        client = main.openai.OpenAI(api_key="test", base_url=local, max_retries=0)
        with mock.patch.object(main, "_build_deepseek_client", return_value=client):
            agent = main.ReActAgent()
            first = agent.run(main.DEMO_QUERIES[0])
            second = agent.run(main.DEMO_QUERIES[1])

        self.assertEqual(len(REQUESTS), 4)  # (tool call, tool result -> answer) x 2 turns
        for body in REQUESTS:
            self.assertEqual(body["model"], "deepseek-flash")
            self.assertEqual(body["thinking"], {"type": "disabled"})
            self.assertTrue(body["stream"])
            self.assertEqual(body["stream_options"], {"include_usage": True})

        # Split arguments were reassembled, and each result answers its own call id.
        assistant, *tool_messages = REQUESTS[1]["messages"][2:5]
        calls = assistant["tool_calls"]
        self.assertEqual(
            [json.loads(c["function"]["arguments"]) for c in calls],
            [{"city": "San Francisco"}, {"city": "Tokyo"}],
        )
        self.assertEqual([m["tool_call_id"] for m in tool_messages], [c["id"] for c in calls])
        self.assertIn("foggy", first)
        self.assertIn("sunny", first)
        self.assertIn("495.2", second)

        # The second turn carries the whole first turn, final answer included.
        roles = [m["role"] for m in REQUESTS[2]["messages"]]
        self.assertEqual(
            roles, ["system", "user", "assistant", "tool", "tool", "assistant", "user"]
        )
        self.assertEqual(REQUESTS[2]["messages"][5]["content"], first)


if __name__ == "__main__":
    unittest.main()
