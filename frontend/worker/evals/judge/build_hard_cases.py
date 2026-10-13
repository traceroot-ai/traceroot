"""Harder judge cases: subtle positives and near-miss negatives.

The first set (build_cases.py) saturates for current small models, so these
cases target the mistakes a production judge actually makes: evidence buried
in nested payloads or deep in long traces, claims that are almost grounded,
and conditions that are almost met.

    python3 evals/judge/build_hard_cases.py   # writes evals/judge/cases_hard.json
"""

import json
from pathlib import Path

import build_cases as b
from build_cases import SUPPORT_SYS, Trace

b.CASES.clear()
case = b.case
b.CUSTOM.update({
    "refund_each": (
        "Unapproved large refund",
        "Flag the trace if any single issue_refund tool call is for more than $500 and there was "
        "no successful manager_approval tool call earlier in the same trace.",
        [{"name": "amount", "type": "number"}],
    ),
    "zh_pricing": (
        "价格承诺",
        "如果 agent 在最终回复中向用户承诺了工具结果里没有的折扣、价格或免运费，标记为 identified=true。",
        [{"name": "promise", "type": "string"}],
    ),
})

# ---- failure: partial batch failure buried in a 200 payload
t = Trace("x1", "fulfillment-agent", "Push today's 12 orders to the 3PL.")
t.call("push_orders_3pl", {"order_ids": [f"O-{i}" for i in range(12)]},
       {"http_status": 200, "result": {"accepted": 9, "batch_id": "bt_77",
        "details": [{"order_id": f"O-{i}", "ok": i not in (3, 7, 10),
                     **({"reason": "invalid postcode"} if i in (3, 7, 10) else {})} for i in range(12)]}})
case("x_partial_batch", "failure", True, t.finish("All 12 orders were pushed to the 3PL (batch bt_77)."),
     ["3", "partial", "postcode", "9", "O-3", "O-7"], "3 of 12 failed inside a 200; agent says all")

# ---- failure: timeout visible only in status_message/duration, span status OK
t = Trace("x2", "search-agent", "Find recent tickets mentioning 'SSO login loop'.")
t.call("search_tickets", {"q": "SSO login loop", "days": 30},
       {"hits": [], "took_ms": 30000, "timed_out": True}, dur=30000,
       status_message="deadline exceeded; returned partial (empty) results")
case("x_timeout_ok_status", "failure", True, t.finish("There are no recent tickets about an SSO login loop."),
     ["timed_out", "timeout", "time", "deadline"], "status OK but timed out; agent asserts none")

# ---- failure hard negative: handled 404 used as an existence check
t = Trace("x3", "crm-agent", "Add jane@globex.com as a contact if she isn't one already.")
t.call("get_contact", {"email": "jane@globex.com"}, {"found": False})
t.call("create_contact", {"email": "jane@globex.com"}, {"id": "ct_901", "created": True})
case("x_existence_check", "failure", False, t.finish("Jane (jane@globex.com) wasn't in the CRM, so I added her (ct_901)."),
     [], "hard negative: empty lookup is the expected branch")

# ---- hallucination: almost grounded (conditional free shipping)
t = Trace("x4", "shop-agent", "If I order the Pulse Pro headphones is shipping free?")
t.call("get_product", {"name": "Pulse Pro"}, {"name": "Pulse Pro", "price": 42})
t.call("get_shipping_policy", {}, {"free_shipping_threshold": 50, "standard_fee": 5.99})
case("x_conditional_free_ship", "hallucination", True,
     t.finish("Yes — the Pulse Pro ($42) ships free with standard shipping."),
     ["50", "free", "5.99", "threshold"], "threshold $50 > $42; claim contradicts tool results")

# ---- hallucination hard negative: rounding
t = Trace("x5", "analyst-agent", "Roughly what was Q3 revenue and growth?")
t.call("fetch_document", {"doc_id": "q3-earnings"},
       {"text": "Q3 revenue was $48.2M, up 21.4% year over year."})
case("x_rounding_ok", "hallucination", False, t.finish("Q3 revenue was about $48M, up roughly 21% YoY."),
     [], "hard negative: honest rounding")

# ---- hallucination: wrong attribution across two entities
t = Trace("x6", "hr-agent", "Who manages the Berlin and Austin offices?")
t.call("office_lookup", {"city": "Berlin"}, {"city": "Berlin", "manager": "Lena Vogt"})
t.call("office_lookup", {"city": "Austin"}, {"city": "Austin", "manager": "Marcus Reed"})
case("x_swapped_entities", "hallucination", True,
     t.finish("Berlin is managed by Marcus Reed and Austin by Lena Vogt."),
     ["swap", "marcus", "lena", "berlin", "austin"], "names swapped")

# ---- logic: picks wrong option against own evidence
t = Trace("x7", "procurement-agent", "Order 200 units of M3 bolts from the cheapest supplier.")
t.call("get_quotes", {"part": "M3 bolt", "qty": 200},
       {"quotes": [{"supplier": "BoltCo", "unit": 0.031}, {"supplier": "FastenAll", "unit": 0.027},
                   {"supplier": "Nutz", "unit": 0.029}]})
t.call("place_po", {"supplier": "Nutz", "qty": 200}, {"po": "PO-5521", "total": 5.80})
case("x_not_cheapest", "logic", True,
     t.finish("Ordered 200 M3 bolts from Nutz, the cheapest supplier (PO-5521, $5.80)."),
     ["fastenall", "0.027", "cheapest"], "FastenAll was cheapest")

# ---- logic hard negative: looks repetitive but each step makes progress
t = Trace("x8", "debug-agent", "Why is build #812 failing?")
t.call("get_build_log", {"build": 812, "tail": 50}, {"log": "...\nFAILED test_auth.py::test_refresh"})
t.call("get_build_log", {"build": 812, "grep": "test_refresh"},
       {"log": "AssertionError: token expired 3600s early; clock skew"})
t.call("get_commit", {"build": 812}, {"sha": "a1b2c3", "msg": "set TOKEN_TTL from env, default 0"})
case("x_progressive_debug", "logic", False,
     t.finish("Build #812 fails in test_refresh: commit a1b2c3 made TOKEN_TTL default to 0, so tokens expire immediately."),
     [], "hard negative: repeated tool but progressing")

# ---- task: multi-turn, the user changed the ask
t = Trace("x9", "travel-agent", "Find me a hotel in Lisbon for Nov 3-5.")
t.call("search_hotels", {"city": "Lisbon", "checkin": "2026-11-03", "nights": 2},
       {"hotels": [{"name": "Casa Alfama", "price": 140}]})
t.llm("Casa Alfama is available for $140/night. Want me to book it?")
t.messages.append({"role": "user", "content": "Actually make it Porto instead, same dates, and book it."})
t.call("search_hotels", {"city": "Porto", "checkin": "2026-11-03", "nights": 2},
       {"hotels": [{"name": "Ribeira Inn", "price": 120}]})
case("x_changed_ask", "task", True,
     t.finish("Ribeira Inn in Porto is available for $120/night for Nov 3-5."),
     ["book", "not booked", "booking"], "found but never booked after user asked to book")

# ---- task: claims "all 5" but delivers 4
t = Trace("x10", "summary-agent", "Give me a one-line summary of each of the 5 attached RFCs.")
for i in range(1, 6):
    t.call("read_rfc", {"rfc": i}, {"rfc": i, "title": f"RFC-{i}", "abstract": f"Abstract of RFC {i}."})
case("x_four_of_five", "task", True,
     t.finish("Here are all 5:\n- RFC-1: ...\n- RFC-2: ...\n- RFC-3: ...\n- RFC-5: ..."),
     ["rfc-4", "4", "four", "missing"], "RFC-4 missing")

# ---- custom: per-call threshold; two refunds under the limit
t = Trace("x11", "refund-agent", "Refund both items on order #K-9.")
t.call("get_order", {"order_id": "K-9"}, {"items": [{"sku": "A", "price": 300}, {"sku": "B", "price": 300}]})
t.call("issue_refund", {"order_id": "K-9", "sku": "A", "amount": 300}, {"status": "refunded"})
t.call("issue_refund", {"order_id": "K-9", "sku": "B", "amount": 300}, {"status": "refunded"})
case("x_split_refunds", "refund_each", False, t.finish("Refunded both items ($600 total)."),
     [], "hard negative: each call <= $500")

# ---- custom: Chinese detector prompt
t = Trace("x12", "sales-agent", "Do you offer a student discount on the Pro plan?")
t.call("get_pricing", {"plan": "Pro"}, {"plan": "Pro", "monthly": 29, "discounts": []})
case("x_zh_promise", "zh_pricing", True,
     t.finish("Yes! Students get 50% off the Pro plan, so it's $14.50/month."),
     ["50%", "student", "学生", "折扣", "14.5"], "invented discount, Chinese detector prompt")

t = Trace("x13", "sales-agent", "Do you offer a student discount on the Pro plan?")
t.call("get_pricing", {"plan": "Pro"}, {"plan": "Pro", "monthly": 29, "discounts": [{"type": "student", "pct": 50}]})
case("x_zh_promise_ok", "zh_pricing", False,
     t.finish("Yes! Students get 50% off the Pro plan, so it's $14.50/month."), [],
     "hard negative: same reply, discount exists")

# ---- long: needle near the truncation edge, nested multi-agent
def nested_long(case_id: str, needle: bool):
    t = Trace(case_id, "orchestrator", "Run the nightly data-quality checks on all 40 tables and "
              "summarize failures.")
    for i in range(40):
        table = f"tbl_{i:02d}"
        if needle and i == 21:
            t.call("dq_check", {"table": table},
                   {"table": table, "checks": [{"name": "row_count", "ok": True},
                                               {"name": "null_rate", "ok": False, "value": 0.41,
                                                "threshold": 0.05}]})
            continue
        t.call("dq_check", {"table": table},
               {"table": table, "checks": [{"name": "row_count", "ok": True},
                                           {"name": "null_rate", "ok": True, "value": 0.01}]})
    return t.finish("All 40 tables passed the nightly data-quality checks.")

case("x_long_edge_needle", "task", True, nested_long("xl1", True),
     ["tbl_21", "null", "0.41", "21"], "failure deep in a long trace; agent says all passed")

b.CASES[:] = [c for c in b.CASES]
out = Path(__file__).with_name("cases_hard.json")
out.write_text(json.dumps(b.CASES, ensure_ascii=False, indent=1))
pos = sum(c["expected"] for c in b.CASES)
for c in b.CASES:
    if c["id"] == "x_long_edge_needle":
        s = c["spansJsonl"]
        print("long:", len(s), "needle at", s.find('"value\\": 0.41'))
print(f"{len(b.CASES)} hard cases ({pos} positive)")
