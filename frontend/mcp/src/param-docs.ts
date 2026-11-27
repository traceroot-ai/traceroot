/**
 * Descriptions for params the registry leaves bare, by name. Each says where
 * the value comes from, because the model has no other way to find out: an id
 * guessed rather than looked up is the commonest way a read tool call fails. They
 * apply only where the registry has no description of its own.
 */
export const PARAM_DESCRIPTIONS: Readonly<Record<string, string>> = {
  trace_id: "Id of the trace, as returned by list_traces.",
  session_id: "Id of the session, as returned by list_sessions.",
  finding_id: "Id of the finding, as returned by list_findings.",
  detector_id: "Id of the detector, as returned by list_detectors.",
  alert_id: "Id of the alert rule, as returned by list_alerts.",
  dashboard_id: "Id of the dashboard, as returned by list_dashboards.",
  widget_id: "Id of a widget, as listed in the widgets of get_dashboard.",
  dataset_id: "Id of the dataset, as returned by list_datasets.",
  version_id: "Id of the dataset version, as returned by list_dataset_versions.",
  run_id:
    "Id of the evaluation run, as shown on its page in TraceRoot or reported by the evaluation SDK. There is no tool that lists runs.",
  start_time: "Start of the time window, an ISO 8601 timestamp such as 2026-11-10T00:00:00Z.",
  end_time: "End of the time window, an ISO 8601 timestamp such as 2026-11-10T23:59:59Z.",
  bucket_seconds: "Width of each time bucket in seconds, from 1 to 86400.",
};
