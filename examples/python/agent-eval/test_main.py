"""
Offline check of what the eval sends to OpenAI: the agent's tools go over Chat
Completions with reasoning_effort "none" and no sampling settings, and the judge
runs on the same model.

Run: python -m unittest test_main.py
"""

import json
import os
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

REQUESTS: list[tuple[str, dict]] = []


def _reply(body: dict) -> tuple[int, dict]:
    """Stand-in for Chat Completions: look up prices, calculate if asked, then answer."""
    if body.get("tools") and body.get("reasoning_effort") != "none":
        # GPT-6 Luna supports function calling in Chat Completions only at effort "none".
        return 400, {"error": {"message": "function calling needs reasoning_effort none"}}
    messages = body["messages"]
    if not body.get("tools"):  # the LLM judge
        message = {"role": "assistant", "content": "1.0"}
    else:
        question = next(m["content"] for m in messages if m["role"] == "user")
        results = [json.loads(m["content"]) for m in messages if m["role"] == "tool"]
        prices = {r["symbol"]: r["price"] for r in results if "symbol" in r}
        computed = [r["result"] for r in results if "result" in r]
        expression = None
        if "10%" in question:
            expression = f"{prices.get('NVDA')} * 1.1"
        elif "3 shares" in question:
            expression = f"3 * {prices.get('MSFT')}"
        if not prices:
            calls = [("get_stock_price", {"symbol": s}) for s in ("NVDA", "MSFT") if s in question]
        elif expression and not computed:
            calls = [("calculate", {"expression": expression})]
        else:
            calls = []
        if calls:
            message = {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": f"call_{len(messages)}_{i}",
                        "type": "function",
                        "function": {"name": name, "arguments": json.dumps(args)},
                    }
                    for i, (name, args) in enumerate(calls)
                ],
            }
        else:
            values = computed[-1:] or list(prices.values())
            message = {"role": "assistant", "content": " and ".join(f"{v:.2f}" for v in values)}
    return 200, {
        "id": "chatcmpl-test",
        "object": "chat.completion",
        "created": 0,
        "model": body["model"],
        "choices": [{"index": 0, "message": message, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
    }


class _Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        REQUESTS.append((self.path, body))
        status, payload = _reply(body)
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


class EvalRequestTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        # Set before main.py loads .env (which never overrides): every OpenAI call
        # goes to the local server, and the run stays local and reports nowhere.
        os.environ["OPENAI_BASE_URL"] = f"http://127.0.0.1:{cls.server.server_port}/v1"
        os.environ["OPENAI_API_KEY"] = "test"
        os.environ["TRACEROOT_API_KEY"] = ""
        os.environ["PYDANTIC_AI_NO_BANNER"] = "1"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def test_agent_and_judge_requests(self):
        import main

        runs = []

        def evaluate(**kwargs):
            runs.append((kwargs, main_evaluate(**kwargs)))
            return runs[-1][1]

        main_evaluate = main.evaluate
        with mock.patch.object(main, "evaluate", evaluate):
            main.main()
        kwargs, result = runs[0]
        self.assertEqual(result.errors(), [])
        self.assertEqual(result.candidate_version, "gpt-6-luna")
        self.assertEqual(kwargs["evaluation_key"], "agent-tool-eval")
        for item in result.item_results:
            self.assertTrue(all(s.value == 1.0 for s in item.scores), item.case_id)

        agent = [body for _, body in REQUESTS if body.get("tools")]
        judge = [body for _, body in REQUESTS if not body.get("tools")]
        self.assertEqual({path for path, _ in REQUESTS}, {"/v1/chat/completions"})
        self.assertEqual(len(judge), 4)
        self.assertTrue(any(m["role"] == "tool" for b in agent for m in b["messages"]))
        for body in agent:
            self.assertEqual(body["model"], "gpt-6-luna")
            self.assertEqual(body["reasoning_effort"], "none")
            self.assertEqual(
                [t["function"]["name"] for t in body["tools"]], ["get_stock_price", "calculate"]
            )
            for key in ("temperature", "top_p", "presence_penalty", "frequency_penalty"):
                self.assertNotIn(key, body)
        for body in judge:
            self.assertEqual(body["model"], "gpt-6-luna")


if __name__ == "__main__":
    unittest.main()
