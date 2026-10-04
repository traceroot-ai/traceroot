# Signals list and detail workflow

This is the UI layer on top of the Signals API stack. It adds the project Signals
list, signal detail panel, status controls, trace links and signal badges in Tracing.
It references #2399 and #2404 without closing the full UX issue.

## Implemented scope

- Project sidebar entry and Signals list, newest signal first. The removable open
  status filter persists when cleared. Search supports status, detector name,
  signal title and signal ID.
- Shared date selection for list counts, detail chart and affected traces. The
  default is seven days; stored preferences and shared links take precedence.
  Plan retention clamps preset and custom ranges. The range counts affected
  traces without hiding signals that have no hits in it.
- Signal title, criteria, canonical RCA, a count-over-time chart, full-screen
  controls and a recent affected-traces table. The chart compares the signal's
  traces with the distinct traces its detector checked.
- Detector page: one runs table; its findings are the Identified = Yes filter,
  kept in the URL. Signal ID links a hit to its signal. Agent Run ID opens the
  agent trace of the RCA that analysed the hit's own trace for that signal (the
  opening it covered records the trace's finding); a hit that only joined a
  signal analysed on another trace shows a dash, and a later RCA does not move
  an earlier hit's link. RCA runs per signal, so the per-finding Finding ID and
  Agent analysis columns are gone.
- Detector list: a Signals column counts each detector's signals (merged ones
  left out, any status and time range, as the Signals page lists them). Its
  Findings, Runs and Signals counts link to the detector's runs filtered to
  Identified = Yes, its runs, and the Signals page narrowed to the detector.
- Resolve and dismiss require a reason; Other requires a note. Status writes
  include the status shown when the user acted (for resolve and dismiss, when
  the dialog opened), so a change made meanwhile is refused.
- Notification links open the Signals page with `?signalId=`; the path comes
  from one helper in core, and a page test checks that the page opens it.
- Affected counts and View all open Tracing with the signal filter and range.
  Opening an individual trace adds a trace-viewer layer over the signal panel.
  Tracing badges can reopen the signal panel.
- A trace's Detectors tab has a Signal column linking each hit to its signal,
  or saying Pending (waiting for assignment) or Disabled (its detector did not
  group hits when it ran). The detector name links to its runs. The trace
  header's Alert button is removed; arriving from the findings page still
  opens the analysis chat.
- A project with no signals sees its next setup step instead of an empty list:
  create a detector, turn on Generate signals, or raise sampling above 0%.
  Filters that match nothing say so and offer to clear them.
- The detector create form and edit panel have a Signals section: a Generate
  signals switch, Root cause analysis (Manual, the default for new detectors,
  or Automatic; the detector's enableRca), and the project's agent model.
- A signal without an analysis offers Run root cause analysis. The request is
  recorded in Postgres (the web app cannot reach the job queue) and the
  worker's RCA sweep starts it within about two minutes; the panel follows it until it
  finishes. The sweep pages past requests whose job is already queued, and a request
  still without a job after seven days is marked failed so it can be run again.
- A Pending hit on a trace's Detectors tab is reread every 10 seconds until it is
  grouped, for at most ten minutes.
- Hour buckets carry their UTC offset (e.g. `2026-11-01T01:00-04:00`) in the core
  hit series, the ClickHouse count of checked traces and the join between them, so the two
  real 01:00 hours of a daylight-saving fall-back night stay apart. Day buckets are
  unchanged.

## Design deltas

| Original scope or contract | Implemented behavior and reason |
| --- | --- |
| Detector-local Signals tab | A project-level Signals list with a detector filter. |
| Detection-time window counts | Window counts and charts use trace start time, matching Tracing. Reopen eligibility uses trace start time when available, falling back to detection time; lifecycle counters and digests use detection time. |
| No separate trace-time snapshot | A nullable indexed signal-hit trace start is necessary for Postgres membership counts; the writer and all window readers consume it. |
| Historical hits already exist | Unknown trace times do not enter window counts. A project-scoped repair script reads retained trace rows without inventing times. |
| Root spans can arrive late | Assignment takes the latest trace-row start time. Existing snapshots are corrected explicitly with the repair script; continuous refresh is not implemented. |
| Detail-only 90-day cap | Removed so enterprise custom ranges are not silently shortened in the panel. Both UI read routes reject custom ranges longer than 10,000 days to bound chart work. |
| Earlier close-reason options | Resolve/dismiss reasons match the current status controls; previously stored events are not rewritten. |
| Criteria editing, merge and move controls; finding-panel signal badges | The APIs exist in the parent stack. These UI controls remain outside this PR and tracked by #2404. |

## Trace-time migration and repair

Apply the new Prisma migration before deploying this branch's UI and worker, and
regenerate the Prisma client. The migration preserves existing hits and leaves their
trace time null; it does not rewrite lifecycle, digest or assignment-copy state.

With the existing DATABASE_URL and CLICKHOUSE_* settings configured, run:

```sh
python scripts/backfill_signal_trace_times.py --project-id <project-id>
```

Review the dry-run counts before adding `--apply`. Add `--refresh-existing` when
correcting snapshots after late root spans or when checking existing non-null
values. Reads and updates are scoped to the named project, batches use keyset
pagination, and writes compare the previous value to avoid overwriting a concurrent
repair. The script changes only the trace start time.

Missing traces remain unknown. Counts can be lower until their times are repaired;
traces already removed by retention cannot be recovered by this script. Tracing's
signal filter reads the asynchronous ClickHouse assignment copy, so View all can
also lag a newly committed assignment or move until its copy is repaired.

## Validation

UI hook and route regressions cover signal switches and retained custom ranges.
Core read tests cover list counts, local chart buckets and explicit long windows.
Worker tests cover missing times and idempotent retry completion. REST tests cover
signal filtering, scoped waiting hits and the distinct checked traces behind the chart.

Real Postgres checks additionally exercised delayed detection across a window,
exclusive end bounds, unknown times, timezone buckets, project isolation, empty
windows and multi-page dry-run/apply/idempotent repair. Those checks used an owned
scratch database and did not modify existing demo data.

Screenshots and interactive visual review are pending.
