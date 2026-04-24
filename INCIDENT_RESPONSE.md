# Incident Response Plan

This plan defines how TraceRoot responds to security incidents.

## Purpose and Scope

Applies to TraceRoot SaaS, APIs, SDKs, and operational infrastructure. Covers vulnerabilities, data exposure, integrity compromise, service degradation, and abuse.

## Roles

Xinwei He (xinwei@traceroot.ai) — all incident response: triage, containment, fixes, and comms.

## Severity Levels and SLAs

| Level | Description | Acknowledge | Mitigate |
|---|---|---|---|
| Sev0 | War room — active breach / data exfiltration in progress | Immediately | ≤3h |
| Sev1 Critical | Active exploit / data at risk | ≤3h | ≤6h |
| Sev2 High | Credible exploit path | ≤6h | ≤12h |
| Sev3 Medium | Limited impact or mitigations exist | ≤12h | ≤3d |
| Sev4 Low | Informational / no immediate risk | ≤1d | ≤2w |

## Key Assets & Credentials to Rotate in an Incident

Depending on scope, rotate or revoke as needed:

- **API access keys** — hashed in Postgres (`AccessKey` table); invalidate via DB
- **User sessions** — session tokens in Postgres; flush all sessions for affected users
- **LLM provider keys** (OpenAI, Anthropic, Azure, Bedrock, etc.) — stored encrypted in Postgres; rotate at provider + update `ENCRYPTION_KEY` if compromised
- **GitHub OAuth tokens / installation IDs** — revoke via GitHub App settings
- **Stripe webhook secret** — rotate in Stripe dashboard
- **Internal API secret** (`X-Internal-Secret`) — rotate in environment config, redeploy all services
- **`ENCRYPTION_KEY`** — if compromised, all encrypted fields (LLM keys, Slack tokens) must be re-encrypted after rotation

## Evidence Handling

Preserve raw traces from ClickHouse for the affected timeframe. Export relevant trace IDs and span payloads from MinIO/S3. Capture configurations, environment variables, and code refs used in reproduction.

---

## Phase 1 — Lead Validation

### Updates

Describe the incoming report: repro steps, mitigating factors, and impact.

### Tasks

- [ ] Understand the vulnerability/situation
- [ ] Update case summary with findings
- [ ] Determine severity
- [ ] Decide on next step:
  - [ ] Dismiss as not-actionable
  - [ ] Escalate to investigation

### For the record

- [CIA](https://www.energy.gov/femp/operational-technology-cybersecurity-energy-systems#cia) risk? `Yes|No`
- Which [CIA](https://www.energy.gov/femp/operational-technology-cybersecurity-energy-systems#cia)? `Confidentiality|Integrity|Availability`
- What user data is at risk?
- What is required to exploit?
- Introduced on: `YYYY-MM-DD`
- PR introducing vulnerability: `<url>`

---

## Phase 2 — Mitigation

### Updates

State blockers, challenges, and the mitigation plan.

### Tasks

- [ ] Re-assess severity and update if needed
- [ ] Check all product surfaces (SaaS, self-hosted)
- [ ] Confirm mitigation across surfaces

### For the record

- First mitigated on: `YYYY-MM-DD`
- Affected surfaces: `SaaS|Self-hosted|Other`
- Mitigation PR/link: `<url>`

---

## Phase 3 — Scoping

### Updates

Summarize impacted users/sessions, time window, and affected systems.

### Tasks

- [ ] Review available data sources (traces, auth records)
- [ ] Determine if CIA was breached; if yes, mark as Incident
- [ ] Confirm who was affected or might have been affected

### For the record

- Confidence in completeness: `low|medium|high`
- [CIA](https://www.energy.gov/femp/operational-technology-cybersecurity-energy-systems#cia) breach? `Yes|No`
- Affected user accounts: `<n>`
- Affected org/enterprise accounts: `<n>`
- Data gaps? Why?

---

## Phase 4 — Notification

### Tasks

- [ ] Are we notifying? `Yes|No`

If yes:

- [ ] Draft notification content
- [ ] Prepare recipient list
- [ ] Send notifications to affected users
- [ ] Publish blog/changelog if applicable
- [ ] Monitor support channels

### For the record

- Notifications sent: `YYYY-MM-DD HH:MM UTC`
- Count sent: `<n>`
- Blog/changelog link: `<url>`

---

## Containment, Eradication, Recovery

- **Containment**: disable affected routes, rotate credentials (see Key Assets above), narrow CORS, increase auth checks, isolate services.
- **Eradication**: hotfix code, add validation, tighten rate limits and authorization.
- **Recovery**: deploy fixes, verify via traces, restore traffic, monitor for recurrence.

## Post-Incident Review

- Timeline and root cause analysis
- Contributing factors
- Action items with due dates
- Test coverage and monitoring improvements

---

*Adapted from GitHub PSIRT checklist.*
