# Incident Response Plan (TraceRoot)

This plan defines how TraceRoot responds to security incidents using its tracing, logging, and REST API capabilities.

## Purpose and Scope

- Applies to TraceRoot SaaS, APIs, SDKs, and operational infrastructure.
- Covers vulnerabilities, data exposure, integrity compromise, service degradation, and abuse.

## Roles and Responsibilities

- Incident Commander (IC): overall coordination and decisions.
- Security Lead: triage, severity, containment strategy, evidence handling.
- SRE/On-call: infra actions, access control, backups, recovery.
- Engineering Owners: root cause, fixes, testing, deploy.
- Communications Lead: stakeholder/internal/external comms, status updates.

## Severity Levels and SLAs

- Sev0: Just ping any TraceRoot Team member through Discord :)
- Sev1 Critical: active exploit/data-at-risk; acknowledge ≤3h, mitigation ≤6h, comms ≤6h.
- Sev2 High: credible exploit path; acknowledge ≤6h, mitigation ≤12h.
- Sev3 Medium: limited impact or mitigations exist; acknowledge ≤12h, mitigation ≤3d.
- Sev4 Low: informational or no immediate risk; acknowledge ≤1d.

## Evidence Handling

- Preserve raw traces/logs for timeframe. Export relevant trace IDs and associated logs.
- Capture configurations, environment variables, and code refs used in reproduction.
- Maintain chain of custody; store artifacts in the incident case repo.

______________________________________________________________________

# Sample Security Incident Response Checklist (Adapted)

## 1️⃣ Lead validation

### 📢 Updates

Describe the incoming report, repro steps, mitigating factors, and impact.

Example:

- Validated the vulnerability exists in the `get-logs-by-trace-id` path. Exploitability constrained by auth headers and user log group scoping.

### 🤓 Guidance

- Link to runbooks below: [Log/Trace Triage], [Access Control], [Containment]

### ✅ Tasks

- [ ] Understand vulnerability/situation
- [ ] Update case summary with understanding
- [ ] Determine severity
- [ ] Decide on investigation
  - [ ] Dismiss as not-actionable with label
  - [ ] Convert lead to investigation

### 🗒️ For the record…

- CIA risk? `Yes|No`
- Which CIA? `Confidentiality|Integrity|Availability`
- What user data is at risk?
- What is required to exploit?
- Introduced on: `YYYY-MM-DD`
- PR link introducing vulnerability: <url>

## 2️⃣ Mitigation

### 📢 Updates

State blockers/challenges, immediate and longer-term mitigations.

Examples:

- Temporarily disabled impacted endpoint(s) via router toggle or WAF rule.
- Increased rate limits or authentication checks.

### ✅ Tasks

- [ ] Re-assess severity and update
- [ ] Check all product surfaces (SaaS API, self-hosted variants)
- [ ] Confirm mitigation across surfaces
- [ ] Apply classification labels

### 🗒️ For the record…

- First mitigated on: `YYYY-MM-DD`
- Affected surfaces: `SaaS|Self-hosted|Other`
- Mitigation link: <url>

## 3️⃣ Scoping

### 📢 Updates

Summarize impacted users/sessions, time window, systems.

### ✅ Tasks

- [ ] Review information sources (see Runbooks)
- [ ] Determine if CIA was breached; if yes, declare Incident (`[Incident]` title + label)
- [ ] Confirm who was affected or might have been affected

### 📓 Notes

Add queries, findings, and decisions.

### 🗒️ For the record…

- Scoping notebook: <url>
- Confidence in completeness: `low|medium|high`
- CIA breach? `Yes|No`
- # affected user accounts: <n>
- # affected org/enterprise accounts: <n>
- Any data gaps? Why?

## 4️⃣ Notification

### 📢 Updates

Decision to notify, message summary, volume, timing.

### ✅ Tasks

- [ ] Are we going to notify? `Yes|No`
  If Yes:
- When decision is made
  - [ ] Double check product involvement
  - [ ] Draft notification content
  - [ ] Prepare recipient data
- Leadership Escalations
  - [ ] Share summary, draft, count to leadership
- When draft is complete
  - [ ] Approvals: Legal, Corp Comms, Security Leadership
- > 24h before send (ideally)
  - [ ] Create internal FAQ
  - [ ] Alert Support and provide data/logs
- At send time
  - [ ] Publish other materials if applicable
  - [ ] Send notifications
- After send
  - [ ] Update stakeholders and Support
  - [ ] Commit artifacts to case repo
  - [ ] Monitor responses/support channels

### 🗒️ For the record…

- Notification time: `YYYY-MM-DD:HH-MM-SSZ`
- Count sent: <n>
- Notification content link: <url>
- Blog/changelog link (if any): <url>

______________________________________________________________________

## Containment, Eradication, Recovery

- Containment: disable affected routes, rotate credentials/tokens, narrow CORS, increase auth checks, isolate services.
- Eradication: hotfix code, add validation, tighten rate limits and authorization in routers.
- Recovery: deploy fixes, verify via traces/logs, restore traffic, monitor elevated logs/severity.

## Communication Plan

- Internal: engineering-security, leadership, on-call channels.
- External: status page, customer notices, coordinated disclosure as needed.

## Post‑Incident Review

- Timeline, root cause analysis, contributing factors.
- Action items with owners and due dates.
- Test coverage, monitoring and alert improvements.

______________________________________________________________________

Acknowledgements: Adapted from GitHub PSIRT checklist and tailored to TraceRoot.
