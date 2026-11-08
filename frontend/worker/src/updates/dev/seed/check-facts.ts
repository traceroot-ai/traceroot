import type { Finding, UpdateFacts } from "@traceroot/core/updates";
import type { buildManifest } from "./manifest.js";

type Manifest = ReturnType<typeof buildManifest>;

const KIND_TO_FINDING: Record<
  string,
  {
    scope: Finding["scope"];
    metric: Finding["metric"];
    kind: Finding["kind"];
    direction: Finding["direction"];
  }
> = {
  volume_drop: { scope: "workflow", metric: "trace_volume", kind: "change", direction: "down" },
  error_rate_rise: { scope: "workflow", metric: "error_rate", kind: "change", direction: "up" },
  cost_spike: { scope: "model", metric: "cost", kind: "change", direction: "up" },
  latency_shift: { scope: "workflow", metric: "latency_p50", kind: "change", direction: "up" },
  new_tool: { scope: "tool", metric: "presence", kind: "new", direction: "appeared" },
  vanished_tool: { scope: "tool", metric: "presence", kind: "vanished", direction: "vanished" },
};

/**
 * Grade the computed facts of one seeded project against the manifest: each
 * planted change is found with the right direction and a magnitude within its
 * tolerance, no control is flagged, nothing is invented, and the small-sample
 * and empty projects behave as the noise rules say. Returns the problems; an
 * empty list means the facts agree with the planted ground truth.
 */
export function checkFacts(manifest: Manifest, projectKey: string, facts: UpdateFacts): string[] {
  const problems: string[] = [];
  const project = manifest.projects[projectKey as keyof Manifest["projects"]];
  const changes = manifest.plantedChanges.filter((c) => c.project === project.id);
  const explained = new Set<string>();

  for (const change of changes) {
    const want = KIND_TO_FINDING[change.kind];
    const id = `${want.scope}:${change.entity}:${want.metric}`;
    const finding = facts.findings.find((f) => f.id === id);
    explained.add(`${want.scope}:${change.entity}`);
    if (!finding) {
      problems.push(`planted change ${change.id}: no finding ${id}`);
      continue;
    }
    if (finding.kind !== want.kind)
      problems.push(`${id}: kind ${finding.kind}, expected ${want.kind}`);
    if (finding.direction !== want.direction) {
      problems.push(`${id}: direction ${finding.direction}, expected ${want.direction}`);
    }
    if (
      change.before !== null &&
      change.after !== null &&
      change.before > 0 &&
      want.kind === "change"
    ) {
      const plantedRatio = change.after / change.before;
      const foundRatio = finding.after / finding.before;
      if (Math.abs(foundRatio - plantedRatio) / plantedRatio > change.tolerance) {
        problems.push(
          `${id}: ratio ${foundRatio.toFixed(3)}, planted ${plantedRatio.toFixed(3)} (tolerance ${change.tolerance})`,
        );
      }
    }
    if (want.kind !== "change" && finding.relativeChange !== null) {
      problems.push(`${id}: a ${want.kind} item must not carry a percentage`);
    }
  }

  for (const control of manifest.controls.filter((c) => c.project === project.id)) {
    const flagged = facts.findings.filter(
      (f) => f.entity === control.entity && f.scope !== "project",
    );
    if (flagged.length > 0) {
      problems.push(
        `control ${control.entity} was flagged: ${flagged.map((f) => f.id).join(", ")}`,
      );
    }
  }

  const derived = new Set<string>(
    manifest.derivedEntities[projectKey as keyof Manifest["derivedEntities"]],
  );
  for (const finding of facts.findings) {
    if (finding.scope === "project") continue;
    const key = `${finding.scope}:${finding.entity}`;
    if (!explained.has(key) && !derived.has(key)) problems.push(`invented finding ${finding.id}`);
  }

  if (projectKey === "tiny") {
    if (facts.findings.some((f) => f.kind === "change" && f.metric !== "presence")) {
      problems.push("tiny sample: a percentage change was reported");
    }
    const rate = facts.findings.find((f) => f.id === "project:all traffic:error_rate");
    if (!rate || rate.kind !== "absolute_only")
      problems.push("tiny sample: error counts not shown as absolute numbers");
  }
  if (projectKey === "empty") {
    if (!facts.nothingNotable || facts.nothingNotableReason !== "no_traffic") {
      problems.push("empty project: expected nothing notable for no traffic");
    }
  }
  return problems;
}
