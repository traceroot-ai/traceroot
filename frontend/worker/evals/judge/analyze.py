"""Score a judge-eval results file.

    python3 evals/judge/analyze.py evals/judge/.results/full1.jsonl [pricing.json]

Cost is estimated from prompt characters (/4) and reported output tokens at
OpenRouter list prices, because reported input tokens drop prompt-cache reads.
"""

import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path

rows = [json.loads(line) for line in Path(sys.argv[1]).read_text().splitlines() if line.strip()]
pricing = json.loads(Path(sys.argv[2]).read_text()) if len(sys.argv) > 2 else {}
cases = {c["id"]: c for c in json.loads(Path(__file__).with_name("cases.json").read_text()) + json.loads(Path(__file__).with_name("cases_hard.json").read_text())}

by_model = defaultdict(list)
for r in rows:
    by_model[r["model"]].append(r)


def pct(x):
    return f"{100 * x:5.1f}%"


def q(values, p):
    values = sorted(values)
    return values[min(len(values) - 1, int(p * len(values)))]


report = []
for model, rs in by_model.items():
    ok = [r for r in rs if not r["error"]]
    tp = sum(1 for r in ok if r["expected"] and r["identified"])
    fp = sum(1 for r in ok if not r["expected"] and r["identified"])
    fn = sum(1 for r in rs if r["expected"] and not r["identified"])  # errors count as misses
    tn = sum(1 for r in ok if not r["expected"] and not r["identified"])
    prec = tp / (tp + fp) if tp + fp else 0
    rec = tp / (tp + fn) if tp + fn else 0
    f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0
    acc = sum(r["correct"] for r in rs) / len(rs)
    # Positives judged identified whose summary/data names the planted evidence.
    hits = [r for r in ok if r["expected"] and r["identified"]]
    def grounded(r):
        text = (r["summary"] + json.dumps(r["data"], ensure_ascii=False)).lower()
        return any(k.lower() in text for k in cases[r["case"]]["evidence"])
    evid = sum(grounded(r) for r in hits) / len(hits) if hits else 0
    # Consistency: cases where every repeat produced the same verdict.
    per_case = defaultdict(set)
    for r in rs:
        per_case[r["case"]].add(r["identified"])
    stable = sum(len(v) == 1 for v in per_case.values()) / len(per_case)
    lat = [r["latencyMs"] for r in ok] or [0]
    p = pricing.get(model)
    cost = None
    if p:
        cost = statistics.mean(
            (r["promptChars"] / 4) * p["in"] / 1e6 + r["outputTokens"] * p["out"] / 1e6 for r in rs)
    report.append(dict(model=model, n=len(rs), acc=acc, prec=prec, rec=rec, f1=f1, fp=fp, fn=fn,
                       err=len(rs) - len(ok), evid=evid, stable=stable,
                       p50=statistics.median(lat), p95=q(lat, 0.95),
                       out=statistics.mean(r["outputTokens"] for r in rs), cost=cost))

report.sort(key=lambda d: (-d["acc"], d["cost"] or 0))
print(f"{'model':32s} {'acc':>6s} {'prec':>6s} {'recall':>6s} {'F1':>6s} {'FP':>3s} {'FN':>3s} "
      f"{'err':>3s} {'evid':>6s} {'stable':>6s} {'p50s':>5s} {'p95s':>5s} {'out_tok':>7s} {'$/1k':>7s}")
for d in report:
    cost = f"{d['cost'] * 1000:7.2f}" if d["cost"] is not None else "      ?"
    print(f"{d['model']:32s} {pct(d['acc'])} {pct(d['prec'])} {pct(d['rec'])} {pct(d['f1'])} "
          f"{d['fp']:3d} {d['fn']:3d} {d['err']:3d} {pct(d['evid'])} {pct(d['stable'])} "
          f"{d['p50'] / 1000:5.1f} {d['p95'] / 1000:5.1f} {d['out']:7.0f} {cost}")

print("\nPer-detector accuracy")
dets = sorted({r["detector"] for r in rows})
print(f"{'model':32s} " + " ".join(f"{d[:8]:>8s}" for d in dets))
for d in report:
    rs = by_model[d["model"]]
    cells = []
    for det in dets:
        sub = [r for r in rs if r["detector"] == det]
        cells.append(pct(sum(r["correct"] for r in sub) / len(sub)).rjust(8))
    print(f"{d['model']:32s} " + " ".join(cells))

print("\nMisses per case (models x repeats wrong)")
wrong = defaultdict(list)
for r in rows:
    if not r["correct"]:
        wrong[r["case"]].append(r["model"].split("/")[1] + ("!" if r["error"] else ""))
for cid in sorted(wrong, key=lambda k: -len(wrong[k])):
    print(f"  {cid:28s} exp={cases[cid]['expected']!s:5s} {len(wrong[cid]):3d}  {', '.join(sorted(set(wrong[cid])))}")

errs = [r for r in rows if r["error"]]
if errs:
    print("\nErrors")
    for r in errs[:30]:
        print(f"  {r['model']} {r['case']}: {r['error'][:160]}")
