import type { AIMessage, AISession } from "../types";

// Reviewed, shortened snapshot of a completed demo RCA (2026-10-14).
// Never fetch another user's chat or copy private history into the demo.
// Tool outputs omitted by capture policy remain omitted here.
export const DEMO_EXAMPLE_MESSAGES: AIMessage[] = [
  {
    id: "demo-question",
    role: "user",
    timestamp: "2026-10-14T15:21:14.925Z",
    content:
      'The "Ungrounded policy answers" detector flagged a claim that supervisor review takes 1–2 business days. Investigate whether the trace supports that claim.',
  },
  {
    id: "demo-download",
    role: "tool_step",
    content: "",
    timestamp: "2026-10-14T15:21:45.507Z",
    toolStep: {
      toolCallId: "demo-download",
      toolName: "download_traces",
      args: {
        label: "Download the trace for analysis",
        traceIds: ["a1278ff61ba8cec1b82d8ca68dd3e573"],
      },
      status: "done",
      result: { content: [{ type: "text", text: "Downloaded 1/1 traces (51 spans)." }] },
    },
  },
  {
    id: "demo-inspect",
    role: "tool_step",
    content: "",
    timestamp: "2026-10-14T15:21:47.912Z",
    toolStep: {
      toolCallId: "demo-inspect",
      toolName: "bash",
      args: { label: "Inspect trace metadata, hierarchy, and errors" },
      status: "done",
      withheld: "not-allowlisted",
    },
  },
  {
    id: "demo-answer",
    role: "assistant",
    timestamp: "2026-10-14T15:22:05.650Z",
    content:
      "### Ungrounded policy answers\n- **Root cause:** This appears to be a false positive: the help-center result explicitly says larger refunds need supervisor review, which takes 1–2 business days.\n- **Code location:** `support_agent.py:480` (orders-agent handler; the trace does not expose a more specific generation location).\n- **Recent changes:** Not checked; repository access was unavailable for this run.\n- **Recommendation:** Update the detector’s grounding check to account for retrieved help-center results before flagging policy claims.",
  },
];

export const DEMO_EXAMPLE_SESSION: Omit<AISession, "projectId"> = {
  id: "demo-example-policy",
  title: "Was this policy answer actually unsupported?",
  status: "completed",
  createTime: "2026-10-14T15:21:14.925Z",
  isExample: true,
};

// Recorded Home Agent run on 2026-10-15; data window: 2026-10-14 UTC.
// Source session: cmv9mmfmp00od2k37eyqryim9. Tool steps shortened; capture-policy omissions preserved.
const OVERVIEW_SESSION: Omit<AISession, "projectId"> = {
  id: "demo-example-overview",
  title: "What should we fix first in our support agent?",
  status: "completed",
  createTime: "2026-10-15T14:20:56.334Z",
  isExample: true,
};

const OVERVIEW_MESSAGES: AIMessage[] = [
  {
    id: "cmv9mmfpm00oh2k37z60dsx77",
    role: "user",
    timestamp: "2026-10-15T14:20:56.458Z",
    content:
      "Review our support-agent activity for October 14, 2026 (UTC). What are the main recurring problems, and what should we fix first? Group related issues, quantify their impact where the data supports it, and inspect representative traces before recommending changes. Keep this investigation read-only; do not create or modify project resources.",
  },
  {
    id: "cmv9mmoni00ol2k376itrrccy",
    role: "tool_step",
    timestamp: "2026-10-15T14:21:08.046Z",
    content: "",
    toolStep: {
      toolCallId:
        "call_G7n9RccyN5auq8ecJy7ia99S|fc_07cee733c8f0922f016ad0e152e7a887d29dfb633d0c37527b",
      toolName: "list_traces",
      args: {
        name: "support",
        label: "Find support-agent traces on October 14",
        limit: 200,
        end_before: "2026-10-15T00:00:00Z",
        start_after: "2026-10-14T00:00:00Z",
      },
      isError: false,
      withheld: "not-allowlisted",
      outputBytes: 22667,
      status: "done",
    },
  },
  {
    id: "cmv9mn27u00or2k37c01oecsp",
    role: "tool_step",
    timestamp: "2026-10-15T14:21:25.626Z",
    content: "",
    toolStep: {
      toolCallId:
        "call_SMEX3MrjxXZlXazvXqPGh1Bq|fc_07cee733c8f0922f016ad0e164af1887d2b1aa82072fb9ffe0",
      toolName: "run_widget_query",
      args: {
        spec: {
          view: "traces",
          metric: {
            agg: "count",
            measure: "count",
          },
          display: {
            type: "number",
          },
          filters: [
            {
              op: "contains",
              field: "name",
              value: "support",
            },
          ],
        },
        label: "Count support-agent traces on October 14",
        end_time: "2026-10-15T00:00:00Z",
        start_time: "2026-10-14T00:00:00Z",
      },
      isError: false,
      withheld: "not-allowlisted",
      outputBytes: 137,
      status: "done",
    },
  },
  {
    id: "cmv9mn2aq00ox2k37l3rrsxx3",
    role: "tool_step",
    timestamp: "2026-10-15T14:21:25.731Z",
    content: "",
    toolStep: {
      toolCallId:
        "call_yZ6qxokoiMg7hPqz0SgmWzvT|fc_07cee733c8f0922f016ad0e164af3487d2a21b3ad5d6e4829f",
      toolName: "run_widget_query",
      args: {
        spec: {
          view: "traces",
          metric: {
            agg: "count",
            measure: "count",
          },
          display: {
            type: "number",
          },
          filters: [
            {
              op: "contains",
              field: "name",
              value: "support",
            },
            {
              op: ">",
              field: "error_count",
              value: 0,
            },
          ],
        },
        label: "Measure support-agent error trace count on October 14",
        end_time: "2026-10-15T00:00:00Z",
        start_time: "2026-10-14T00:00:00Z",
      },
      isError: false,
      withheld: "not-allowlisted",
      outputBytes: 136,
      status: "done",
    },
  },
  {
    id: "cmv9mnser00pf2k3799yim76s",
    role: "tool_step",
    timestamp: "2026-10-15T14:21:59.572Z",
    content: "",
    toolStep: {
      toolCallId:
        "call_UsB7w1BZYGIZEdFViIZc9X5t|fc_07cee733c8f0922f016ad0e179900c87d2b0179a7504d2677f",
      toolName: "download_traces",
      args: {
        label: "Inspect representative API connection failures and clustered failures",
        traceIds: [
          "2ea75674daf3418a8ec2021af718a4bd",
          "528985293df2fd1dc3ef99c6d42b9145",
          "2bc5a2612fc3dca13e0b856882b57f52",
          "c97255da7d38d5192191b47200a73c3b",
        ],
      },
      result: {
        content: [
          {
            text: 'Downloaded 4/4 traces:\n✓ 2ea75674daf3418a8ec2021af718a4bd → /workspace/traces/2ea75674daf3418a8ec2021af718a4bd_support_agent/ (4 spans)\n    cat /workspace/traces/2ea75674daf3418a8ec2021af718a4bd_support_agent/tree.json | jq .\n    grep \'"span_kind":"LLM"\' /workspace/traces/2ea75674daf3418a8ec2021af718a4bd_support_agent/spans.jsonl\n✓ 528985293df2fd1dc3ef99c6d42b9145 → /workspace/traces/528985293df2fd1dc3ef99c6d42b9145_support_agent/ (4 spans)\n    cat /workspace/traces/528985293df2fd1dc3ef99c6d42b9145_support_agent/tree.json | jq .\n    grep \'"span_kind":"LLM"\' /workspace/traces/528985293df2fd1dc3ef99c6d42b9145_support_agent/spans.jsonl\n✓ 2bc5a2612fc3dca13e0b856882b57f52 → /workspace/traces/2bc5a2612fc3dca13e0b856882b57f52_support_agent/ (8 spans)\n    cat /workspace/traces/2bc5a2612fc3dca13e0b856882b57f52_support_agent/tree.json | jq .\n    grep \'"span_kind":"LLM"\' /workspace/traces/2bc5a2612fc3dca13e0b856882b57f52_support_agent/spans.jsonl\n✓ c97255da7d38d5192191b47200a73c3b → /workspace/traces/c97255da7d38d5192191b47200a73c3b_support_agent/ (10 spans)\n    cat /workspace/traces/c97255da7d38d5192191b47200a73c3b_support_agent/tree.json | jq .\n    grep \'"span_kind":"LLM"\' /workspace/traces/c97255da7d38d5192191b47200a73c3b_support_agent/spans.jsonl',
            type: "text",
          },
        ],
      },
      isError: false,
      outputBytes: 1342,
      status: "done",
    },
  },
  {
    id: "cmv9mo2s200pp2k370e437aps",
    role: "tool_step",
    timestamp: "2026-10-15T14:22:13.010Z",
    content: "",
    toolStep: {
      toolCallId:
        "call_zvr9qTTX5f8fkHdbYkJQnE5s|fc_07cee733c8f0922f016ad0e193a4bc87d2b3c824af495f9db8",
      toolName: "bash",
      args: {
        label: "Inspect downloaded trace metadata and span errors",
        command:
          'for d in /workspace/traces/*; do echo ===$d; cat "$d/trace.jsonl"; jq -c \'{span_id,parent_span_id,name,span_kind,status,error_type,status_message,model_name,span_start_time,span_end_time,duration_ms,git_source_file,git_source_line,input,output}\' "$d/spans.jsonl"; done',
      },
      isError: false,
      withheld: "not-allowlisted",
      outputBytes: 48485,
      status: "done",
    },
  },
  {
    id: "cmv9moc4l00pv2k37r85l17sg",
    role: "tool_step",
    timestamp: "2026-10-15T14:22:25.126Z",
    content: "",
    toolStep: {
      toolCallId:
        "call_YO23aPSaMa5MgEPJIj4GOgGP|fc_07cee733c8f0922f016ad0e1a06f0487d2824783efee86ef89",
      toolName: "run_widget_query",
      args: {
        spec: {
          view: "spans",
          metric: {
            agg: "count",
            measure: "count",
          },
          display: {
            type: "table",
          },
          filters: [
            {
              op: "=",
              field: "status",
              value: "ERROR",
            },
          ],
          breakdown: "name",
        },
        label: "Find failed tool and LLM span names in the selected day",
        end_time: "2026-10-15T00:00:00Z",
        start_time: "2026-10-14T00:00:00Z",
      },
      isError: false,
      withheld: "not-allowlisted",
      outputBytes: 294,
      status: "done",
    },
  },
  {
    id: "cmv9moo8g00q32k37rfbaxphg",
    role: "tool_step",
    timestamp: "2026-10-15T14:22:40.816Z",
    content: "",
    toolStep: {
      toolCallId:
        "call_S07hGJOaFjnHJUcYNQPQmlZm|fc_07cee733c8f0922f016ad0e1b0585087d2a02c4ab4ef95b25d",
      toolName: "check_github_access",
      args: {
        repo: "GabrielDrapor/demo-support-agent",
      },
      isError: false,
      withheld: "not-allowlisted",
      outputBytes: 132,
      status: "done",
    },
  },
  {
    id: "cmv9mozm000q72k37ogravikb",
    role: "tool_step",
    timestamp: "2026-10-15T14:22:55.560Z",
    content: "",
    toolStep: {
      toolCallId:
        "call_reDOtyFBzhLaRafx4pUWWSwf|fc_07cee733c8f0922f016ad0e1be790487d2bd34812edcf6a395",
      toolName: "download_traces",
      args: {
        label: "Inspect the slowest support-agent trace",
        traceIds: ["fa2616394ad5f03332d9f10ba65cf000"],
      },
      result: {
        content: [
          {
            text: 'Downloaded 1/1 traces:\n✓ fa2616394ad5f03332d9f10ba65cf000 → /workspace/traces/fa2616394ad5f03332d9f10ba65cf000_support_agent/ (14 spans)\n    cat /workspace/traces/fa2616394ad5f03332d9f10ba65cf000_support_agent/tree.json | jq .\n    grep \'"span_kind":"LLM"\' /workspace/traces/fa2616394ad5f03332d9f10ba65cf000_support_agent/spans.jsonl',
            type: "text",
          },
        ],
      },
      isError: false,
      outputBytes: 382,
      status: "done",
    },
  },
  {
    id: "cmv9mp5mj00q92k37dmv6slmy",
    role: "tool_step",
    timestamp: "2026-10-15T14:23:03.355Z",
    content: "",
    toolStep: {
      toolCallId:
        "call_qizdcqFN7Gb87IK1oYdEJ6wT|fc_07cee733c8f0922f016ad0e1c6143887d2b6670c75a0cf03a2",
      toolName: "bash",
      args: {
        label: "Review the slow trace's span timeline and git metadata",
        command:
          'd=/workspace/traces/fa2616394ad5f03332d9f10ba65cf000_support_agent; cat "$d/trace.jsonl"; jq -r \'[.span_start_time,.span_end_time,.name,.span_kind,.status,.error_type,.status_message,.git_source_file,.git_source_line] | @tsv\' "$d/spans.jsonl" | sort',
      },
      isError: false,
      withheld: "not-allowlisted",
      outputBytes: 3136,
      status: "done",
    },
  },
  {
    id: "cmv9mq9oq00qj2k37dgkxfy0o",
    role: "assistant",
    timestamp: "2026-10-15T14:23:55.275Z",
    content:
      "## Summary — October 14, 2026 UTC\n\nI found **260 `support_agent` traces**. **32 had at least one error**—about **12%**. Three recurring problem groups stand out:\n\n1. **Order-tool failures were the most frequent recurring issue:** 23 failed tool calls—**13 `list_orders`** and **10 `lookup_order`**.\n2. **OpenAI connection failures caused complete turn failures:** **11 traces** ended with `openai.APIConnectionError`.\n3. **A small latency tail was severe:** **9 traces exceeded 30 seconds**; the slowest took **317.17 seconds**.\n\n### What to fix first\n\n**1. Fix the `list_orders` contract and date handling.** It had the highest failed-tool count. In representative trace `2bc5a2612fc3dca13e0b856882b57f52`, span `d9f9bd1648f3060f` called `list_orders` with `since: 2026-09-15`—the documented `YYYY-MM-DD` format—but the tool returned `Invalid date`. The customer then got no order list. Check the tool’s accepted date semantics and validation, and make the agent’s date source consistent: this trace occurred on October 14, but its prompt said “Today is 2026-10-15.” The sample shows a contract/date problem, though I can’t establish that every `list_orders` failure had the same cause.\n\n**2. Add resilience around LLM connection failures.** The 11 failed traces were concentrated in a short burst around **15:17–15:18 UTC** and returned no agent output. For example, trace `528985293df2fd1dc3ef99c6d42b9145` has `APIConnectionError` on ChatCompletion span `abe381af2b268b0e` from **15:17:22 to 15:17:40 UTC**. Prioritize provider/network diagnosis, bounded retries, and a clear fallback or recovery path. The error breakdown shows 33 API-error spans, but those include repeated parent/child instrumentation—not 33 independent failures.\n\n**3. Validate order IDs against the customer’s known orders before lookup.** There were **10 failed `lookup_order` calls**. In trace `c97255da7d38d5192191b47200a73c3b`, the customer asked for `A-84347`, while the account listed `A-48347`; span `65b2f569010965f0` records the resulting “not found” error. The agent subsequently suggested the likely ID and asked for confirmation, but checking the account’s order list first could avoid the failed lookup.\n\n**4. Investigate the extreme latency outlier.** In trace `fa2616394ad5f03332d9f10ba65cf000`, the overall duration was **317.17 seconds**, with an otherwise-OK ChatCompletion span `5f8fdb8032dc9b64` lasting about **303 seconds**. That merits a timeout/latency investigation even though the trace did not error. Across the day, p50 trace latency was **7.77 seconds** and p95 was **25.14 seconds**.\n\nThese are telemetry-based priorities, not confirmed source-code root causes. The traces include repository and revision metadata, but I couldn’t inspect the code because no GitHub App is installed. This investigation was read-only; I did not create or modify project resources.",
  },
];

// Recorded Home Agent run on 2026-10-15; data window: 2026-10-14 UTC.
// Source session: cmv9mmfos00of2k37lj5iaxed. Tool steps shortened; capture-policy omissions preserved.
const LATENCY_SESSION: Omit<AISession, "projectId"> = {
  id: "demo-example-latency",
  title: "Why are some support-agent requests so slow?",
  status: "completed",
  createTime: "2026-10-15T14:20:56.429Z",
  isExample: true,
};

const LATENCY_MESSAGES: AIMessage[] = [
  {
    id: "cmv9mmfrg00oj2k37e7w1r83f",
    role: "user",
    timestamp: "2026-10-15T14:20:56.525Z",
    content:
      "Some support-agent requests feel much slower than others. Investigate October 14, 2026 (UTC): compare slow traces with typical requests, identify where the time is spent, and explain what the evidence does and does not prove. Show representative trace IDs and concrete next steps. Keep this investigation read-only; do not create or modify project resources.",
  },
  {
    id: "cmv9mmrbi00on2k37t4spbnnn",
    role: "tool_step",
    timestamp: "2026-10-15T14:21:11.502Z",
    content: "",
    toolStep: {
      toolCallId:
        "call_BC400HtPwmLAok4EMnjNqeq9|fc_02f99a42fdb4b65b016ad0e1564da087d2b432b25ed0e13e30",
      toolName: "list_traces",
      args: {
        name: "support",
        label: "Find support-agent traces on October 14",
        limit: 100,
        end_before: "2026-10-15T00:00:00Z",
        start_after: "2026-10-14T00:00:00Z",
      },
      isError: false,
      withheld: "not-allowlisted",
      outputBytes: 11368,
      status: "done",
    },
  },
  {
    id: "cmv9mn2di00oz2k37occyevl5",
    role: "tool_step",
    timestamp: "2026-10-15T14:21:25.830Z",
    content: "",
    toolStep: {
      toolCallId:
        "call_CMkCFnxoMh2LitBm2CRT5NcJ|fc_02f99a42fdb4b65b016ad0e164f41c87d285f1ff78afdb32c0",
      toolName: "run_widget_query",
      args: {
        spec: {
          view: "traces",
          metric: {
            agg: "p50",
            measure: "duration_ms",
          },
          display: {
            type: "number",
          },
          filters: [
            {
              op: "=",
              field: "name",
              value: "support_agent",
            },
          ],
        },
        label: "Measure support-agent trace latency distribution",
        end_time: "2026-10-15T00:00:00Z",
        start_time: "2026-10-14T00:00:00Z",
      },
      isError: false,
      withheld: "not-allowlisted",
      outputBytes: 141,
      status: "done",
    },
  },
  {
    id: "cmv9mn2e600p12k37dl7gfj4y",
    role: "tool_step",
    timestamp: "2026-10-15T14:21:25.854Z",
    content: "",
    toolStep: {
      toolCallId:
        "call_CksBqf4DU9J3YSTZaxo8K9e5|fc_02f99a42fdb4b65b016ad0e164f43487d28fff6afd5d7d1507",
      toolName: "run_widget_query",
      args: {
        spec: {
          view: "traces",
          metric: {
            agg: "p95",
            measure: "duration_ms",
          },
          display: {
            type: "number",
          },
          filters: [
            {
              op: "=",
              field: "name",
              value: "support_agent",
            },
          ],
        },
        label: "Measure slow-tail support-agent trace latency",
        end_time: "2026-10-15T00:00:00Z",
        start_time: "2026-10-14T00:00:00Z",
      },
      isError: false,
      withheld: "not-allowlisted",
      outputBytes: 143,
      status: "done",
    },
  },
  {
    id: "cmv9mn2ec00p32k379r4a2fwx",
    role: "tool_step",
    timestamp: "2026-10-15T14:21:25.860Z",
    content: "",
    toolStep: {
      toolCallId:
        "call_wqwu5MVYWSID22QZ7a8NMlHB|fc_02f99a42fdb4b65b016ad0e164f43c87d2bf7fd32f8fc72b69",
      toolName: "run_widget_query",
      args: {
        spec: {
          view: "traces",
          metric: {
            agg: "count",
            measure: "count",
          },
          display: {
            type: "number",
          },
          filters: [
            {
              op: "=",
              field: "name",
              value: "support_agent",
            },
          ],
        },
        label: "Count support-agent traces",
        end_time: "2026-10-15T00:00:00Z",
        start_time: "2026-10-14T00:00:00Z",
      },
      isError: false,
      withheld: "not-allowlisted",
      outputBytes: 137,
      status: "done",
    },
  },
  {
    id: "cmv9mn2ek00p52k3702itkagj",
    role: "tool_step",
    timestamp: "2026-10-15T14:21:25.869Z",
    content: "",
    toolStep: {
      toolCallId:
        "call_6vLOyH5ScJTtIvO1toT8I1S6|fc_02f99a42fdb4b65b016ad0e164f44887d2b209f5f12404d0b9",
      toolName: "run_widget_query",
      args: {
        spec: {
          view: "traces",
          metric: {
            agg: "max",
            measure: "duration_ms",
          },
          display: {
            type: "number",
          },
          filters: [
            {
              op: "=",
              field: "name",
              value: "support_agent",
            },
          ],
        },
        label: "Measure maximum support-agent trace latency",
        end_time: "2026-10-15T00:00:00Z",
        start_time: "2026-10-14T00:00:00Z",
      },
      isError: false,
      withheld: "not-allowlisted",
      outputBytes: 141,
      status: "done",
    },
  },
  {
    id: "cmv9mnlik00p72k375osgbnct",
    role: "tool_step",
    timestamp: "2026-10-15T14:21:50.637Z",
    content: "",
    toolStep: {
      toolCallId:
        "call_plDCtvzjZLLVjI8YyTGLGWmE|fc_02f99a42fdb4b65b016ad0e172afc887d2a9d89f5f9a2380c6",
      toolName: "download_traces",
      args: {
        label: "Download slow and typical support-agent traces for span-level comparison",
        traceIds: [
          "fa2616394ad5f03332d9f10ba65cf000",
          "931d1942d2295a3e08d98618ea0ea940",
          "7eb0a87ff4e95d5f6abce1ed652cef6b",
        ],
      },
      result: {
        content: [
          {
            text: 'Downloaded 3/3 traces:\n✓ fa2616394ad5f03332d9f10ba65cf000 → /workspace/traces/fa2616394ad5f03332d9f10ba65cf000_support_agent/ (14 spans)\n    cat /workspace/traces/fa2616394ad5f03332d9f10ba65cf000_support_agent/tree.json | jq .\n    grep \'"span_kind":"LLM"\' /workspace/traces/fa2616394ad5f03332d9f10ba65cf000_support_agent/spans.jsonl\n✓ 931d1942d2295a3e08d98618ea0ea940 → /workspace/traces/931d1942d2295a3e08d98618ea0ea940_support_agent/ (14 spans)\n    cat /workspace/traces/931d1942d2295a3e08d98618ea0ea940_support_agent/tree.json | jq .\n    grep \'"span_kind":"LLM"\' /workspace/traces/931d1942d2295a3e08d98618ea0ea940_support_agent/spans.jsonl\n✓ 7eb0a87ff4e95d5f6abce1ed652cef6b → /workspace/traces/7eb0a87ff4e95d5f6abce1ed652cef6b_support_agent/ (12 spans)\n    cat /workspace/traces/7eb0a87ff4e95d5f6abce1ed652cef6b_support_agent/tree.json | jq .\n    grep \'"span_kind":"LLM"\' /workspace/traces/7eb0a87ff4e95d5f6abce1ed652cef6b_support_agent/spans.jsonl',
            type: "text",
          },
        ],
      },
      isError: false,
      outputBytes: 1024,
      status: "done",
    },
  },
  {
    id: "cmv9mns7t00p92k37n1wsutkx",
    role: "tool_step",
    timestamp: "2026-10-15T14:21:59.321Z",
    content: "",
    toolStep: {
      toolCallId:
        "call_cNwXOilXP938WFRjnlCTAzv3|fc_02f99a42fdb4b65b016ad0e187141887d28afdcce8cb257208",
      toolName: "bash",
      args: {
        label: "Inspect 317-second trace metadata and span timing",
        command:
          "cd /workspace/traces/fa2616394ad5f03332d9f10ba65cf000_support_agent && cat trace.jsonl && jq -r '[.[]?] | .[]' tree.json | head -c 1000; echo; jq -r '[.span_id,.parent_span_id,.name,.span_kind,.status,.error_type,.model_name,.span_start_time,.span_end_time,((.span_end_time|fromdateiso8601)-(.span_start_time|fromdateiso8601)),.status_message] | @tsv' spans.jsonl",
      },
      isError: true,
      withheld: "not-allowlisted",
      outputBytes: 7788,
      status: "error",
    },
  },
  {
    id: "cmv9mns8400pd2k37tv8j5pkm",
    role: "tool_step",
    timestamp: "2026-10-15T14:21:59.333Z",
    content: "",
    toolStep: {
      toolCallId:
        "call_VjKOdUryHdqOShYV0n7YP4uL|fc_02f99a42fdb4b65b016ad0e187143887d2955d7c8945805f58",
      toolName: "bash",
      args: {
        label: "Inspect typical 8-second trace metadata and span timing",
        command:
          "cd /workspace/traces/7eb0a87ff4e95d5f6abce1ed652cef6b_support_agent && cat trace.jsonl && jq . tree.json && jq -r '[.span_id,.parent_span_id,.name,.span_kind,.status,.error_type,.model_name,.span_start_time,.span_end_time,.status_message] | @tsv' spans.jsonl",
      },
      isError: false,
      withheld: "not-allowlisted",
      outputBytes: 3324,
      status: "done",
    },
  },
  {
    id: "cmv9moirk00pz2k37hduk8o9d",
    role: "tool_step",
    timestamp: "2026-10-15T14:22:33.728Z",
    content: "",
    toolStep: {
      toolCallId:
        "call_bVIH4CCDMeb5Q0cwKv7RPH2G|fc_02f99a42fdb4b65b016ad0e1a8382c87d2b24f05ff2f1be289",
      toolName: "bash",
      args: {
        label: "Read all spans and timing boundaries in the longest trace",
        command:
          "cd /workspace/traces/fa2616394ad5f03332d9f10ba65cf000_support_agent && jq -r '[.span_id,.parent_span_id,.name,.span_kind,.status,.error_type,.span_start_time,.span_end_time,.git_source_file,.git_source_line,.status_message] | @tsv' spans.jsonl",
      },
      isError: false,
      withheld: "not-allowlisted",
      outputBytes: 1981,
      status: "done",
    },
  },
  {
    id: "cmv9moo7h00q12k37m16ugd5v",
    role: "tool_step",
    timestamp: "2026-10-15T14:22:40.781Z",
    content: "",
    toolStep: {
      toolCallId:
        "call_U4wwvw17A0gwMcfgtUWGMGcR|fc_02f99a42fdb4b65b016ad0e1afce1c87d2ab090e53268785b2",
      toolName: "bash",
      args: {
        label: "Read all spans and timing boundaries in the 83-second trace",
        command:
          "cd /workspace/traces/931d1942d2295a3e08d98618ea0ea940_support_agent && jq -r '[.span_id,.parent_span_id,.name,.span_kind,.status,.error_type,.span_start_time,.span_end_time,.git_source_file,.git_source_line,.status_message] | @tsv' spans.jsonl",
      },
      isError: false,
      withheld: "not-allowlisted",
      outputBytes: 1967,
      status: "done",
    },
  },
  {
    id: "cmv9movfw00q52k372bv3swc5",
    role: "tool_step",
    timestamp: "2026-10-15T14:22:50.157Z",
    content: "",
    toolStep: {
      toolCallId:
        "call_v2lnAAcXr7dBZv5lxSTivd3P|fc_02f99a42fdb4b65b016ad0e1b9be0487d28b792f28a49d4b23",
      toolName: "check_github_access",
      args: {
        repo: "GabrielDrapor/demo-support-agent",
      },
      isError: false,
      withheld: "not-allowlisted",
      outputBytes: 132,
      status: "done",
    },
  },
  {
    id: "cmv9mp5uf00qd2k372jlw9b8o",
    role: "tool_step",
    timestamp: "2026-10-15T14:23:03.639Z",
    content: "",
    toolStep: {
      toolCallId:
        "call_MLIzS4lHaY6XiLp6K39ldA3e|fc_02f99a42fdb4b65b016ad0e1c74d6487d29a9738c94503cd46",
      toolName: "bash",
      args: {
        label: "Check model and token metadata for representative trace LLM spans",
        command:
          'for d in /workspace/traces/fa2616394ad5f03332d9f10ba65cf000_support_agent /workspace/traces/931d1942d2295a3e08d98618ea0ea940_support_agent /workspace/traces/7eb0a87ff4e95d5f6abce1ed652cef6b_support_agent; do echo TRACE_DIR=$d; jq -r \'select(.span_kind=="LLM") | [.span_id,.name,.model_name,.status,.input_tokens,.output_tokens,.total_tokens,.cost,.usage_details,.cost_details] | @json\' "$d/spans.jsonl"; done',
      },
      isError: false,
      withheld: "not-allowlisted",
      outputBytes: 3988,
      status: "done",
    },
  },
  {
    id: "cmv9mpo8r00qh2k37mbomlmkj",
    role: "assistant",
    timestamp: "2026-10-15T14:23:27.483Z",
    content:
      "## Finding\n\nSupport-agent latency had a pronounced slow tail on **October 14, 2026 (UTC)**. Across **260 traces**, median duration was **7,769.5 ms**, the 95th percentile was **25,144.35 ms**, and the maximum was **317,170 ms**. These figures are for the full day and filtered to traces named `support_agent`.\n\nThe clearest example points to a single long LLM span as the main source of delay:\n\n- **Slowest:** `fa2616394ad5f03332d9f10ba65cf000` — **317.17 s**, no recorded errors. Its `ChatCompletion` span `5f8fdb8032dc9b64` ran **302.977 s** (15:22:18.768–15:27:21.745 UTC). It was recorded as `gpt-6-luna`, completed OK, and used 916 tokens. Other recorded work in the trace was comparatively brief.\n- **Another slow example:** `931d1942d2295a3e08d98618ea0ea940` — **83.854 s**, no recorded errors. Its final `ChatCompletion` span `8a846300ed1d8aa9` took **61.563 s** (19:11:30.205–19:12:31.768 UTC); earlier model calls and tools were much shorter.\n- **Typical comparison:** `7eb0a87ff4e95d5f6abce1ed652cef6b` — **8.000 s**, no recorded errors. Its four LLM calls each took about **1.35–1.91 s**; the recorded tool calls were brief.\n\n## What the telemetry supports—and what it doesn’t\n\nThe slow traces’ total time is concentrated in long `ChatCompletion` spans, while the representative typical trace has several much shorter LLM calls. That makes the model-call portion the clearest place to investigate first. The slowest example is a refund request, but the timing alone **does not show that the refund path caused the delay**.\n\nThe spans completed with OK status and do not establish *why* those calls took so long. They don’t distinguish provider queueing or inference time from network delay, retries, or other time included in the instrumented call. Token counts are recorded, but they don’t by themselves explain the delay. This telemetry also doesn’t establish a code regression or root cause.\n\n## Concrete next steps\n\n1. Check provider-side request and latency records for `gpt-6-luna` at the two slow spans’ UTC timestamps; correlate request IDs if available.\n2. Compare those calls’ queue time, time-to-first-token, total generation time, and retry/timeout history with ordinary calls.\n3. Check whether similarly slow calls cluster by model, agent route, request type, or time of day before changing prompts or routing.\n4. Add or inspect instrumentation that separates provider, network, and retry timing, so the next slow trace can distinguish those causes.\n\nThe traces include repository metadata for `GabrielDrapor/demo-support-agent`, but **repository access was unavailable for this investigation.** I therefore couldn’t verify the source code or connect these spans to a code change.\n\nThis investigation was read-only; I did not create or modify project resources.",
  },
];

export const DEMO_EXAMPLES: { session: Omit<AISession, "projectId">; messages: AIMessage[] }[] = [
  { session: OVERVIEW_SESSION, messages: OVERVIEW_MESSAGES },
  { session: LATENCY_SESSION, messages: LATENCY_MESSAGES },
  { session: DEMO_EXAMPLE_SESSION, messages: DEMO_EXAMPLE_MESSAGES },
];

export function getDemoExample(sessionId: string | null) {
  return DEMO_EXAMPLES.find(({ session }) => session.id === sessionId);
}
