"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarClock, ChevronDown, ChevronRight, Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  DEFAULT_UPDATE_LIMITS,
  DEFAULT_UPDATE_SCHEDULE,
  UPDATE_SCHEDULE_PRESETS,
  listSkills,
} from "@traceroot/core/updates";
import {
  useSaveUpdateSchedule,
  useUpdateSchedule,
  type UpdateScheduleResponse,
} from "../hooks/useUpdateSchedule";

interface UpdatesTabProps {
  projectId: string;
}

type Preset = "daily" | "weekly" | "custom";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const selectClass =
  "h-8 rounded-md border border-input bg-transparent px-2 text-[13px] focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50";

function presetOf(s: { frequency: string; weekday: number; hour: number }): Preset {
  const daily = UPDATE_SCHEDULE_PRESETS.daily;
  const weekly = UPDATE_SCHEDULE_PRESETS.weekly;
  if (s.frequency === "daily" && s.hour === daily.hour) return "daily";
  if (s.frequency === "weekly" && s.weekday === weekly.weekday && s.hour === weekly.hour)
    return "weekly";
  return "custom";
}

/** One repository per line, written owner/name; blank lines and repeats are dropped. */
function parseRepos(text: string): string[] {
  const seen = new Set<string>();
  return text
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !seen.has(line.toLowerCase()) && seen.add(line.toLowerCase()));
}

function formatHour(h: number) {
  return `${String(h).padStart(2, "0")}:00`;
}

function formatInZone(iso: string | null, timezone: string) {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

const STATUS_BADGE: Record<string, "success" | "danger" | "warning" | "info" | "default"> = {
  succeeded: "success",
  failed: "danger",
  stopped: "warning",
  running: "info",
  pending: "default",
};

const STOP_REASON_TEXT: Record<string, string> = {
  token_cap: "Stopped: the run reached its token limit.",
  spend_limit: "Stopped: the project reached its monthly spend limit.",
  project_gone: "Stopped: the project no longer exists.",
};

export function UpdatesTab({ projectId }: UpdatesTabProps) {
  const { data, isLoading, isError } = useUpdateSchedule(projectId);
  const save = useSaveUpdateSchedule(projectId);

  const [enabled, setEnabled] = useState(false);
  const [preset, setPreset] = useState<Preset>("weekly");
  const [frequency, setFrequency] = useState<"daily" | "weekly">("weekly");
  const [weekday, setWeekday] = useState(DEFAULT_UPDATE_SCHEDULE.weekday);
  const [hour, setHour] = useState(DEFAULT_UPDATE_SCHEDULE.hour);
  const [timezone, setTimezone] = useState(DEFAULT_UPDATE_SCHEDULE.timezone);
  const [runTokenCap, setRunTokenCap] = useState(DEFAULT_UPDATE_LIMITS.runTokenCap);
  const [monthlySpend, setMonthlySpend] = useState(DEFAULT_UPDATE_LIMITS.monthlySpendCapUsd);
  const [codeEnabled, setCodeEnabled] = useState(false);
  const [codeRepos, setCodeRepos] = useState("");

  useEffect(() => {
    if (!data) return;
    setEnabled(data.enabled);
    setFrequency(data.frequency);
    setWeekday(data.weekday);
    setHour(data.hour);
    setTimezone(data.timezone);
    setPreset(presetOf(data));
    setRunTokenCap(data.run_token_cap);
    setMonthlySpend(data.monthly_spend_cap_usd);
    setCodeEnabled(data.code_changes_enabled);
    setCodeRepos((data.code_repos ?? []).join("\n"));
  }, [data]);

  const zones = useMemo(() => {
    let names: string[] = [];
    try {
      names = Intl.supportedValuesOf("timeZone");
    } catch {
      names = [];
    }
    const set = new Set(["UTC", ...names, timezone]);
    return [...set].sort();
  }, [timezone]);

  const choosePreset = (p: Preset) => {
    setPreset(p);
    if (p === "custom") return;
    const base = UPDATE_SCHEDULE_PRESETS[p];
    setFrequency(base.frequency);
    setWeekday(base.weekday);
    setHour(base.hour);
  };

  const skills = useMemo(() => listSkills(), []);
  const ran = new Set(data?.last_run?.skills_ran ?? []);

  if (isLoading) return <div className="text-[13px] text-muted-foreground">Loading...</div>;
  if (isError || !data) {
    return <div className="text-[13px] text-red-600">Could not load the update settings.</div>;
  }

  const dirty =
    enabled !== data.enabled ||
    frequency !== data.frequency ||
    (frequency === "weekly" && weekday !== data.weekday) ||
    hour !== data.hour ||
    timezone !== data.timezone ||
    runTokenCap !== data.run_token_cap ||
    monthlySpend !== data.monthly_spend_cap_usd ||
    codeEnabled !== data.code_changes_enabled ||
    parseRepos(codeRepos).join("\n") !== (data.code_repos ?? []).join("\n") ||
    !data.configured;

  const onSave = () =>
    save.mutate({
      enabled,
      frequency,
      weekday,
      hour,
      timezone,
      runTokenCap,
      monthlySpendCapUsd: monthlySpend,
      codeChangesEnabled: codeEnabled,
      codeRepos: parseRepos(codeRepos),
    });

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Updates</h2>
        <p className="text-[13px] text-muted-foreground">
          A scheduled summary of what changed in this project&apos;s traffic since the last one,
          sent to the Slack channel and email recipients set under Detectors.
        </p>
      </div>

      <div className="border">
        <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-2">
          <div className="flex items-center gap-1.5">
            <CalendarClock className="h-3.5 w-3.5 text-muted-foreground" />
            <h3 className="text-[13px] font-medium">Schedule</h3>
          </div>
          <label className="flex items-center gap-2 text-[12px]">
            <span>{enabled ? "On" : "Off"}</span>
            <Switch id="updates-enabled" checked={enabled} onCheckedChange={setEnabled} />
          </label>
        </div>
        <div className="space-y-3 px-4 py-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-[12px]">
              Frequency
              <select
                aria-label="Frequency"
                className={selectClass}
                value={preset}
                onChange={(e) => choosePreset(e.target.value as Preset)}
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly (Monday 09:00)</option>
                <option value="custom">Custom</option>
              </select>
            </label>
            {preset === "custom" && (
              <>
                <label className="flex flex-col gap-1 text-[12px]">
                  Repeats
                  <select
                    aria-label="Repeats"
                    className={selectClass}
                    value={frequency}
                    onChange={(e) => setFrequency(e.target.value as "daily" | "weekly")}
                  >
                    <option value="daily">Every day</option>
                    <option value="weekly">Every week</option>
                  </select>
                </label>
                {frequency === "weekly" && (
                  <label className="flex flex-col gap-1 text-[12px]">
                    Day
                    <select
                      aria-label="Day"
                      className={selectClass}
                      value={weekday}
                      onChange={(e) => setWeekday(Number(e.target.value))}
                    >
                      {WEEKDAYS.map((name, i) => (
                        <option key={name} value={i + 1}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="flex flex-col gap-1 text-[12px]">
                  Hour
                  <select
                    aria-label="Hour"
                    className={selectClass}
                    value={hour}
                    onChange={(e) => setHour(Number(e.target.value))}
                  >
                    {HOURS.map((h) => (
                      <option key={h} value={h}>
                        {formatHour(h)}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
            <label className="flex flex-col gap-1 text-[12px]">
              Timezone
              <select
                aria-label="Timezone"
                className={`${selectClass} max-w-[16rem]`}
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
              >
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="text-[12px] text-muted-foreground">
            Updates run at most once a day. Each one covers the period since the previous one and is
            compared with the period before it.
            {enabled && data.next_slot_at && (
              <>
                {" "}
                Next update:{" "}
                <span className="font-medium text-foreground">
                  {formatInZone(data.next_slot_at, data.timezone)}
                </span>
                .
              </>
            )}
          </p>

          <div className="flex flex-wrap items-end gap-3 border-t border-border pt-3">
            <label className="flex flex-col gap-1 text-[12px]">
              Tokens per update (at most)
              <input
                aria-label="Tokens per update"
                type="number"
                min={1000}
                className={`${selectClass} w-32`}
                value={runTokenCap}
                onChange={(e) => setRunTokenCap(Number(e.target.value))}
              />
            </label>
            <label className="flex flex-col gap-1 text-[12px]">
              Spend per month, USD (at most)
              <input
                aria-label="Spend per month"
                type="number"
                min={0}
                step="1"
                className={`${selectClass} w-32`}
                value={monthlySpend}
                onChange={(e) => setMonthlySpend(Number(e.target.value))}
              />
            </label>
          </div>

          {save.isError && (
            <p role="alert" className="text-[12px] text-red-600">
              {(save.error as Error).message}
            </p>
          )}
          {save.isSuccess && !dirty && <p className="text-[12px] text-emerald-700">Saved.</p>}
          <Button
            size="sm"
            className="h-7 text-[12px]"
            onClick={onSave}
            disabled={save.isPending || !dirty}
          >
            {save.isPending ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>

      <div className="border">
        <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-2">
          <h3 className="text-[13px] font-medium">Code changes</h3>
          <label className="flex items-center gap-2 text-[12px]">
            <span>{codeEnabled ? "On" : "Off"}</span>
            <Switch
              id="updates-code-changes"
              checked={codeEnabled}
              onCheckedChange={setCodeEnabled}
            />
          </label>
        </div>
        <div className="space-y-2 px-4 py-3">
          <p className="text-[12px] text-muted-foreground">
            Adds what merged or shipped in the period beside the shifts in traffic. It uses the
            GitHub connection you already have, reads a short-lived copy of the repository in a
            sandbox that never has a network or your token, and never puts code in an update. Off
            until you turn it on, and only for the repositories listed here.
          </p>
          <label className="flex flex-col gap-1 text-[12px]">
            Repositories (owner/name, one per line)
            <textarea
              aria-label="Repositories"
              rows={3}
              disabled={!codeEnabled}
              className="rounded-md border border-input bg-transparent px-2 py-1 font-mono text-[12px] focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
              value={codeRepos}
              onChange={(e) => setCodeRepos(e.target.value)}
              placeholder="acme/web-app"
            />
          </label>
        </div>
      </div>

      <div className="border">
        <div className="border-b border-border bg-muted/30 px-4 py-2">
          <h3 className="text-[13px] font-medium">Last update</h3>
        </div>
        <div className="px-4 py-3 text-[13px]">
          <LastRun run={data.last_run} timezone={data.timezone} />
        </div>
      </div>

      <div className="border">
        <div className="flex items-center gap-1.5 border-b border-border bg-muted/30 px-4 py-2">
          <Lock className="h-3.5 w-3.5 text-muted-foreground" />
          <h3 className="text-[13px] font-medium">Skills</h3>
        </div>
        <div className="px-4 py-3">
          <p className="mb-3 text-[12px] text-muted-foreground">
            The instructions the update agent works from. They ship with TraceRoot and are read-only
            for now. The three marked &ldquo;Always on&rdquo; run in every update; the others are
            loaded when the update needs them.
          </p>
          <ul className="divide-y divide-border border" aria-label="Update skills">
            {skills.map((skill) => (
              <SkillRow
                key={skill.name}
                skill={skill}
                ran={ran.has(skill.name)}
                hasRun={!!data.last_run}
              />
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function LastRun({ run, timezone }: { run: UpdateScheduleResponse["last_run"]; timezone: string }) {
  if (!run) return <span className="text-muted-foreground">No update has run yet.</span>;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={STATUS_BADGE[run.status] ?? "default"}>{run.status}</Badge>
        <span className="text-muted-foreground">
          for {formatInZone(run.slot_at, timezone)}
          {run.trigger === "manual" ? " (started by hand)" : ""}
        </span>
      </div>
      {run.stop_reason && (
        <p>{STOP_REASON_TEXT[run.stop_reason] ?? `Stopped: ${run.stop_reason}`}</p>
      )}
      {run.error && run.status !== "succeeded" && <p className="text-red-600">{run.error}</p>}
      {run.delivery_note && <p className="text-muted-foreground">{run.delivery_note}</p>}
      {(run.status === "succeeded" || run.tokens > 0) && (
        <p className="text-[12px] text-muted-foreground">
          {run.status === "succeeded" && (
            <>
              Sent to{" "}
              {[run.slack_delivered && "Slack", run.email_delivered && "email"]
                .filter(Boolean)
                .join(" and ") || "no channel"}
              {" · "}
            </>
          )}
          {run.tokens.toLocaleString()} tokens · ${run.cost_usd.toFixed(3)}
        </p>
      )}
    </div>
  );
}

function SkillRow({
  skill,
  ran,
  hasRun,
}: {
  skill: ReturnType<typeof listSkills>[number];
  ran: boolean;
  hasRun: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-muted/40"
      >
        {open ? (
          <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[12px]">{skill.name}</span>
            {skill.required && <Badge variant="foreground">Always on</Badge>}
            {hasRun && ran && <Badge variant="success">Ran in the last update</Badge>}
          </div>
          <p className="text-[12px] text-muted-foreground">{skill.summary}</p>
        </div>
      </button>
      {open && (
        <pre className="whitespace-pre-wrap border-t border-border bg-muted/30 px-4 py-3 text-[12px] leading-relaxed">
          {skill.body}
        </pre>
      )}
    </li>
  );
}
